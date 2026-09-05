import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANALYTICS_TOOLS, createReviewAnalytics } from './review-analytics.mjs';
import { WORKLOAD_TOOLS, createWorkloadService } from './workload.mjs';
import { STATUS_TOOLS, createStatusService, createAdapterVerifier } from './card-status.mjs';
import { MOVE_FLASHCARD_TOOL, createCardMoveService } from './move-flashcards.mjs';
import { LIST_FLASHCARD_TOOL, createFlashcardListing } from './list-flashcards.mjs';
import { CREATE_FLASHCARD_TOOL, CreationJournal, createCardCreationService } from './create-flashcards.mjs';
import { createHash } from 'node:crypto';
import { FLASHCARD_TOOLS, createFlashcardService, strictArgs } from './flashcards.mjs';

const EDIT_LATER_CODE = 'e';
const EDIT_LATER_MESSAGE_SLOT = 'e_m';

const EXTRA_TOOLS = [
  {
    name: 'get_edit_later_queue',
    description:
      'List Edit Later with explicit total, has_more and next_cursor. Stored front/back and raw card codes are not the rendered practice sides. Always call read_flashcard before editing to obtain live direction, rich text and revision. Follow next_cursor until has_more is false; restarting without a cursor returns the first page.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 100,
          description: 'Maximum number of active Edit Later items to return.',
        },
        cursor: { type: 'string', maxLength: 1024, description: 'Opaque next_cursor from the previous page. Do not modify. Pages use a stable queue-time and Rem-ID order.' },
        include_context: {
          type: 'boolean',
          default: true,
          description: 'Include surrounding raw Rem context from the official RemNote MCP when available.',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ...FLASHCARD_TOOLS,
  CREATE_FLASHCARD_TOOL,
  LIST_FLASHCARD_TOOL,
  MOVE_FLASHCARD_TOOL,
  ...STATUS_TOOLS,
  ...WORKLOAD_TOOLS,
  ...ANALYTICS_TOOLS,
];

function asBoolean(value) {
  return value === true || value === 1;
}

function richTextToPlain(value) {
  if (!Array.isArray(value)) return typeof value === 'string' ? value : '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part._id === 'string') return `[[${part._id}]]`;
      return '';
    })
    .join('');
}

function latestEditLaterTimestamp(doc) {
  let latest = null;
  for (const [key, history] of Object.entries(doc?.aph ?? {})) {
    if (!key.startsWith(`${EDIT_LATER_CODE}_`) || !Array.isArray(history?.v)) continue;
    for (const event of history.v) {
      if (!asBoolean(event?.v) || !Number.isFinite(event?.t)) continue;
      latest = latest === null ? event.t : Math.max(latest, event.t);
    }
  }
  return latest;
}

function normalizeCard(row) {
  const doc = JSON.parse(row.doc);
  return {
    id: row._id,
    rem_id: doc.rId ?? null,
    card_type_code: doc.c ?? null,
    created_at: Number.isFinite(doc.createdAt) ? new Date(doc.createdAt).toISOString() : null,
  };
}

function normalizeQueueItem(row, cards) {
  const doc = JSON.parse(row.doc);
  const feedbackRichText = doc?.ps?.[EDIT_LATER_MESSAGE_SLOT]?.v?.v ?? [];
  const addedAt = latestEditLaterTimestamp(doc);
  return {
    id: row._id,
    rem_id: row._id,
    parent_rem_id: doc.parent ?? null,
    front: richTextToPlain(doc.key),
    back: richTextToPlain(doc.value),
    front_rich_text: Array.isArray(doc.key) ? doc.key : [],
    back_rich_text: Array.isArray(doc.value) ? doc.value : [],
    feedback: richTextToPlain(feedbackRichText),
    feedback_rich_text: Array.isArray(feedbackRichText) ? feedbackRichText : [],
    added_at: Number.isFinite(addedAt) ? new Date(addedAt).toISOString() : null,
    cards,
    field_semantics: 'Stored Rem sides, not rendered practice sides. Read read_flashcard for live direction and revision before editing.',
  };
}

export class EditLaterRepository {
  constructor(databasePath) {
    this.databasePath = databasePath;
  }

  withDatabase(callback) {
    const db = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      return callback(db);
    } finally {
      db.close();
    }
  }

  list(limit = 100) { return this.listPage(limit).items; }

  cardIds(remId) {
    return this.withDatabase(db => db.prepare("SELECT _id FROM cards WHERE json_extract(doc, '$.rId') = ? ORDER BY _id LIMIT 101").all(remId).map(row => row._id));
  }

  cardHistorySnapshot(cardIds) {
    if (!cardIds.length) return [];
    return this.withDatabase(db => {
      const query = db.prepare("SELECT _id, json_extract(doc, '$.h') AS history FROM cards WHERE _id = ?");
      return [...new Set(cardIds)].sort().flatMap(id => {
        const row = query.get(id);
        if (!row) return [];
        const history = JSON.parse(row.history ?? '[]');
        if (!Array.isArray(history)) throw new Error('Unsupported stored review history.');
        return [{ _id: row._id, history }];
      });
    });
  }

  cardScheduleSnapshot(cardIds, { includeActive = true } = {}) {
    if (!cardIds.length) return [];
    return this.withDatabase(db => {
      const query = db.prepare('SELECT _id, doc FROM cards WHERE _id = ?');
      // RemNote card properties: due date, explanation, mastery, failure streak,
      // last review, stale date, not-yet-learned; active fields may change with direction.
      const fields = ['n', 'ne', 'ml', 't', 'l', 'st', 'ny', ...(includeActive ? ['a', 'd', 'b'] : [])];
      return [...new Set(cardIds)].sort().flatMap(id => {
        const row = query.get(id);
        if (!row) return [];
        const doc = JSON.parse(row.doc);
        return [{ _id: row._id, schedule: Object.fromEntries(fields.map(field => [field, doc[field] ?? null])) }];
      });
    });
  }

  get(id) {
    return this.withDatabase(db => {
      const row = db.prepare("SELECT _id, doc FROM quanta WHERE _id = ? AND json_extract(doc, '$.apu.e.v') = 1").get(id);
      return row ? normalizeQueueItem(row, []) : null;
    });
  }

  listPage(limit = 100, cursor) {
    let after = null;
    if (cursor !== undefined) {
      try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw new TypeError('Invalid queue cursor.'); }
      if (!after || !Number.isFinite(after.time) || !validateId(after.id)) throw new TypeError('Invalid queue cursor.');
    }
    return this.withDatabase(db => {
      db.exec('BEGIN');
      try {
        const total = db.prepare("SELECT COUNT(*) AS count FROM quanta WHERE json_extract(doc, '$.apu.e.v') = 1").get().count;
        const rows = db.prepare(`
          WITH queue AS (
            SELECT _id, doc, COALESCE(
              (SELECT MAX(CAST(json_extract(event.value, '$.t') AS INTEGER))
               FROM json_each(doc, '$.aph') AS history, json_each(history.value, '$.v') AS event
               WHERE substr(history.key, 1, 2) = 'e_' AND json_extract(event.value, '$.v') = 1),
              json_extract(doc, '$.createdAt'), 0) AS queued_at
            FROM quanta WHERE json_extract(doc, '$.apu.e.v') = 1
          )
          SELECT * FROM queue WHERE (? IS NULL OR queued_at > ? OR (queued_at = ? AND _id > ?))
          ORDER BY queued_at ASC, _id ASC LIMIT ?
        `).all(after?.time ?? null, after?.time ?? null, after?.time ?? null, after?.id ?? null, limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = rows.slice(0, limit);
        const cardStatement = db.prepare("SELECT _id, doc FROM cards WHERE json_extract(doc, '$.rId') = ? ORDER BY _id");
        const items = pageRows.map(row => normalizeQueueItem(row, cardStatement.all(row._id).map(normalizeCard)));
        const last = pageRows.at(-1);
        return { items, total, has_more: hasMore, next_cursor: hasMore ? Buffer.from(JSON.stringify({ time: last.queued_at, id: last._id })).toString('base64url') : null };
      } finally { db.exec('COMMIT'); }
    });
  }

  isActive(id) {
    return this.withDatabase((db) => {
      const row = db
        .prepare(
          `SELECT 1 AS active
             FROM quanta
            WHERE _id = ? AND json_extract(doc, '$.apu.e.v') = 1
            LIMIT 1`,
        )
        .get(id);
      return Boolean(row?.active);
    });
  }
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function secureTokenEqual(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function parseJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function callUpstream(upstreamUrl, authorization, rpcRequest) {
  const response = await fetch(upstreamUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { authorization, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(rpcRequest),
  });
  if (!response.ok) throw new Error(`Official RemNote MCP returned HTTP ${response.status}`);
  return readJsonResponse(response, rpcRequest?.id);
}

async function loadContext(upstreamUrl, authorization, items) {
  if (items.length === 0) return new Map();
  const response = await callUpstream(upstreamUrl, authorization, {
    jsonrpc: '2.0',
    id: 'edit-later-context',
    method: 'tools/call',
    params: {
      name: 'read_docs_raw',
      arguments: { ids: items.map((item) => item.rem_id) },
    },
  });
  if (response?.error || response?.result?.isError) throw new Error('Official RemNote MCP could not load context.');
  const parsed = normalizeToolResult(response?.result);
  if (!Array.isArray(parsed?.documents)) throw new Error('Official RemNote MCP returned no document context.');
  return new Map((parsed.documents ?? []).map((document) => [document.document_id, document]));
}

export function normalizeToolResult(result) {
  if (!result || typeof result !== 'object' || result.isError) throw new Error('MCP returned an error or missing tool result.');
  let payload = result.structuredContent;
  if (payload === undefined) {
    const texts = result.content?.filter(entry => entry.type === 'text') ?? [];
    if (texts.length !== 1) throw new Error('MCP returned an ambiguous or missing JSON payload.');
    try { payload = JSON.parse(texts[0].text); } catch { throw new Error('MCP tool result was not JSON.'); }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.ok === false || payload.applied === false) throw new Error('MCP tool did not report a successful structured result.');
  return payload;
}

export async function readJsonResponse(response, expectedId) {
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const body = await response.text();
    if (!body) { if (expectedId === undefined) return null; throw new Error('MCP response was empty.'); }
    const parsed = JSON.parse(body);
    if (expectedId !== undefined && parsed.id !== expectedId) throw new Error('MCP response ID mismatch.');
    return parsed;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  function event(block) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return null;
    const parsed = JSON.parse(data);
    return Object.hasOwn(parsed, 'id') && (expectedId === undefined || parsed.id === expectedId) ? parsed : null;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) { size += value.length; if (size > 10_000_000) throw new Error('MCP response too large.'); }
      buffer += decoder.decode(value, { stream: !done });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = event(block);
        if (parsed) return parsed;
      }
      if (done) {
        const parsed = event(buffer);
        if (parsed) return parsed;
        throw new Error('MCP stream ended without the matching response.');
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function createRuntimeMcpRunner({
  runtimeUrl = 'http://127.0.0.1:3001/mcp',
  token,
  fetchImpl = fetch,
} = {}) {
  if (!token) throw new Error('RemNote Agent Runtime token is required');
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };

  return async (toolName, args) => {
    const initializeResponse = await fetchImpl(runtimeUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'proxy-init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'remnote-edit-later-proxy', version: '0.3.0' },
        },
      }),
    });
    const initializeBody = await readJsonResponse(initializeResponse, 'proxy-init');
    if (!initializeResponse.ok || initializeBody?.error) {
      throw new Error(
        initializeBody?.error?.message ??
          `RemNote Agent Runtime initialization returned HTTP ${initializeResponse.status}`,
      );
    }
    const sessionId = initializeResponse.headers.get('mcp-session-id');
    if (!sessionId) throw new Error('RemNote Agent Runtime did not return an MCP session ID');
    const sessionHeaders = { ...headers, 'mcp-session-id': sessionId };

    try {
      const initializedResponse = await fetchImpl(runtimeUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      if (!initializedResponse.ok) {
        throw new Error(
          `RemNote Agent Runtime initialization notification returned HTTP ${initializedResponse.status}`,
        );
      }

      const callResponse = await fetchImpl(runtimeUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: sessionHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'proxy-call',
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        }),
      });
      const callBody = await readJsonResponse(callResponse, 'proxy-call');
      if (!callResponse.ok || callBody?.error) {
        throw new Error(
          callBody?.error?.message ??
            `RemNote Agent Runtime tool call returned HTTP ${callResponse.status}`,
        );
      }
      if (callBody?.result?.isError) {
        const message = callBody.result.content?.find((entry) => entry.type === 'text')?.text;
        throw new Error(message ?? 'RemNote Agent Runtime tool call failed');
      }
      return normalizeToolResult(callBody?.result);
    } finally {
      await fetchImpl(runtimeUrl, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5_000),
        headers: sessionHeaders,
      }).catch(() => {});
    }
  };
}

function validateId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{3,128}$/.test(value);
}

export function createMcpHandler({
  expectedToken,
  upstreamUrl,
  repository,
  runtimeMcpRunner,
  logger = console,
  creationJournal,
  verifyStatusAdapter = createAdapterVerifier(process.env.REMNOTE_APP_ASAR ?? '/opt/remnote/app/resources/app.asar'),
}) {
  let journal = creationJournal;
  const getOperationJournal = () => {
    if (!journal) {
      const scope = createHash('sha256').update(process.env.REMNOTE_DB ?? 'default').digest('hex').slice(0, 16);
      journal = new CreationJournal(process.env.REMNOTE_CREATION_JOURNAL ?? path.join(os.homedir(), '.local', 'state', 'remnote-mcp-proxy', `creation-${scope}.sqlite`));
    }
    return journal;
  };
  const creation = createCardCreationService(runtimeMcpRunner, getOperationJournal);
  const flashcards = createFlashcardService(runtimeMcpRunner, repository, expectedToken, { getJournal: getOperationJournal });
  const moves = createCardMoveService(runtimeMcpRunner, flashcards, repository, getOperationJournal);
  const status = createStatusService(repository, runtimeMcpRunner, verifyStatusAdapter);
  const workload = createWorkloadService(repository, runtimeMcpRunner, verifyStatusAdapter);
  const analytics = createReviewAnalytics(repository, verifyStatusAdapter);
  const listing = createFlashcardListing(repository, verifyStatusAdapter);
  return async function handler(request, response) {
    if (request.url !== '/mcp') {
      response.writeHead(404).end('Not found');
      return;
    }

    const authorization = request.headers.authorization ?? '';
    if (!secureTokenEqual(authorization, `Bearer ${expectedToken}`)) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }

    let rpcRequest;
    try {
      rpcRequest = await parseJsonBody(request);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
      return;
    }

    try {
      if (rpcRequest?.method === 'tools/list') {
        const upstream = await callUpstream(upstreamUrl, authorization, rpcRequest);
        if (upstream?.error || !Array.isArray(upstream?.result?.tools)) throw new Error('Official tool catalog was unavailable.');
        const customNames = new Set(EXTRA_TOOLS.map(tool => tool.name));
        upstream.result.tools = [...upstream.result.tools.filter(tool => !customNames.has(tool.name)).map(tool =>
          ['append_doc', 'create_doc'].includes(tool.name) ? { ...tool, description: `${tool.description ?? ''} For new flashcards inside a topic or heading, prefer create_flashcards with separate typed sides and exact placement.` } : tool), ...EXTRA_TOOLS];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(upstream));
        return;
      }

      if (rpcRequest?.method === 'tools/call') {
        const name = rpcRequest?.params?.name;
        const args = rpcRequest?.params?.arguments ?? {};

        if (name === 'get_edit_later_queue') {
          strictArgs(args, ['limit', 'include_context', 'cursor']);
          const limit = args.limit ?? 100;
          if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 1024)) || (args.include_context !== undefined && typeof args.include_context !== 'boolean')) {
            throw new TypeError('Invalid get_edit_later_queue arguments');
          }
          const page = repository.listPage(limit, args.cursor);
          const items = page.items;
          let contextError = null;
          if (args.include_context !== false) {
            try {
              const contexts = await loadContext(upstreamUrl, authorization, items);
              for (const item of items) item.context = contexts.get(item.rem_id) ?? null;
              if (items.some(item => item.context === null)) contextError = 'Context was unavailable for some Rems. Use read_flashcard and read_docs_raw before editing.';
            } catch (error) {
              contextError = error.message;
            }
          }
          const payload = {
            ...page,
            count: items.length,
            ...(contextError ? { context_warning: contextError } : {}),
          };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: rpcRequest.id, result: { ...toolResult(payload), ...(payload.ok === false ? { isError: true } : {}) } }));
          return;
        }

        let payload;
        if (name === 'get_card_review_history') {
          payload = await analytics.timeline(args);
        } else if (name === 'get_review_difficulty_trends') {
          payload = await analytics.trends(args);
        } else if (name === 'compare_study_topics') {
          payload = await analytics.compare(args);
        } else if (name === 'get_study_workload_forecast') {
          payload = await analytics.forecast(args);
        } else if (name === 'get_study_workload') {
          payload = await workload.summary(args);
        } else if (name === 'list_card_review_stats') {
          payload = await workload.list(args);
        } else if (name === 'keep_edit_later_item') {
          payload = await flashcards.keep(args);
        } else if (name === 'get_card_status') {
          payload = await status.get(args);
        } else if (name === 'list_cards_by_status') {
          payload = await status.list(args);
        } else if (name === 'move_flashcards') {
          payload = await moves.move(args);
        } else if (name === 'list_flashcards') {
          payload = await listing.list(args);
        } else if (name === 'create_flashcards') {
          payload = await creation.create(args);
        } else if (name === 'read_flashcard') {
          strictArgs(args, ['rem_id'], ['rem_id']);
          payload = await flashcards.read(args.rem_id);
        } else if (name === 'update_flashcard') {
          payload = await flashcards.update(args, 'flashcard');
        } else if (name === 'update_rem_front') {
          payload = await flashcards.update(args, 'front');
        } else if (name === 'update_rem') {
          strictArgs(args, ['id', 'text', 'expected_revision'], ['id', 'text', 'expected_revision']);
          payload = await flashcards.update({ rem_id: args.id, front: args.text, expected_revision: args.expected_revision }, 'legacy');
        } else if (name === 'resolve_edit_later_item') {
          payload = await flashcards.resolve(args);
        } else if (name === 'delete_rem') {
          payload = await flashcards.remove(args);
        }
        if (payload !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: rpcRequest.id, result: { ...toolResult(payload), ...(payload.ok === false ? { isError: true } : {}) } }));
          return;
        }

      }

      const upstream = await callUpstream(upstreamUrl, authorization, rpcRequest);
      response.writeHead(upstream === null ? 202 : 200, {
        ...(upstream === null ? {} : { 'content-type': 'application/json' }),
      });
      response.end(upstream === null ? undefined : JSON.stringify(upstream));
    } catch (error) {
      const invalidArguments = error instanceof TypeError;
      logger.error?.('[remnote-mcp-proxy]', error.message);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          jsonRpcError(
            rpcRequest?.id,
            invalidArguments ? -32602 : -32000,
            invalidArguments ? error.message : 'RemNote operation failed',
            { message: error.message },
          ),
        ),
      );
    }
  };
}

async function loadExpectedToken() {
  if (process.env.REMNOTE_MCP_TOKEN) return process.env.REMNOTE_MCP_TOKEN;
  const configPath =
    process.env.REMNOTE_CONFIG_PATH ?? path.join(os.homedir(), '.config', 'RemNote', 'config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.remNoteMcpAccessToken) throw new Error(`No RemNote MCP token found in ${configPath}`);
  return config.remNoteMcpAccessToken;
}

async function loadRuntimeToken() {
  if (process.env.REMNOTE_AGENT_TOKEN) return process.env.REMNOTE_AGENT_TOKEN;
  const authPath =
    process.env.REMNOTE_AGENT_AUTH_PATH ?? path.join(os.homedir(), '.remnote-agent', 'auth.json');
  const auth = JSON.parse(await readFile(authPath, 'utf8'));
  if (!auth.httpToken) throw new Error(`No RemNote Agent Runtime token found in ${authPath}`);
  return auth.httpToken;
}

export async function startServer() {
  const databasePath = process.env.REMNOTE_DB;
  if (!databasePath) throw new Error('REMNOTE_DB must point to the currently open RemNote remnote.db');
  const port = Number.parseInt(process.env.PORT ?? '7789', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  const upstreamUrl = process.env.REMNOTE_UPSTREAM_URL ?? 'http://127.0.0.1:7788/mcp';
  const runtimeUrl = process.env.REMNOTE_AGENT_URL ?? 'http://127.0.0.1:3001/mcp';
  const expectedToken = await loadExpectedToken();
  const runtimeToken = await loadRuntimeToken();
  const repository = new EditLaterRepository(databasePath);
  const runtimeMcpRunner = createRuntimeMcpRunner({ runtimeUrl, token: runtimeToken });
  const server = http.createServer(
    createMcpHandler({ expectedToken, upstreamUrl, repository, runtimeMcpRunner }),
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  console.log(`RemNote MCP proxy listening on http://${host}:${port}/mcp`);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
