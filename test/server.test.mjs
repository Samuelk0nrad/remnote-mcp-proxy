import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createMcpHandler, EditLaterRepository } from '../src/server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createFixtureDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'remnote-proxy-test-'));
  const databasePath = path.join(directory, 'remnote.db');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE quanta (_id TEXT PRIMARY KEY NOT NULL, doc TEXT); CREATE TABLE cards (_id TEXT PRIMARY KEY NOT NULL, doc TEXT);');
  const insertRem = db.prepare('INSERT INTO quanta (_id, doc) VALUES (?, ?)');
  insertRem.run(
    'queuedRem1',
    JSON.stringify({
      _id: 'queuedRem1',
      key: ['Question'],
      value: ['Answer'],
      parent: 'parent1',
      createdAt: Date.UTC(2026, 7, 31, 12),
      apu: { e: { v: true } },
      aph: { e_1: { v: [{ v: true, t: Date.UTC(2026, 7, 31, 13) }] } },
      ps: { e_m: { v: { v: [{ text: 'Too vague', i: 'm' }] } } },
    }),
  );
  insertRem.run(
    'resolvedRem1',
    JSON.stringify({
      _id: 'resolvedRem1',
      key: ['Resolved'],
      apu: { e: { v: false } },
    }),
  );
  db.prepare('INSERT INTO cards (_id, doc) VALUES (?, ?)').run(
    'card1',
    JSON.stringify({ _id: 'card1', rId: 'queuedRem1', c: 1, createdAt: Date.UTC(2026, 7, 31, 12) }),
  );
  db.close();
  return databasePath;
}

async function rpc(url, token, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('lists official and Edit Later tools and reads the real queue', async (t) => {
  const token = 'test-token';
  const databasePath = createFixtureDatabase();
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    if (body.method === 'tools/list') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search_docs' }] } }));
      return;
    }
    if (body.method === 'tools/call' && body.params.name === 'read_docs_raw') {
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  documents: [{ document_id: 'queuedRem1', title: 'Question', raw_document_text: 'Question >> Answer' }],
                }),
              },
            ],
          },
        }),
      );
      return;
    }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const writes = [];
  const proxy = http.createServer(
    createMcpHandler({
      expectedToken: token,
      upstreamUrl: `http://127.0.0.1:${upstreamPort}/mcp`,
      repository: new EditLaterRepository(databasePath),
      runtimeMcpRunner: async (name, args) => {
        writes.push({ name, args });
        return { ok: true };
      },
      logger: { error() {} },
    }),
  );
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));
  const url = `http://127.0.0.1:${proxyPort}/mcp`;

  const listed = await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.result.tools.map((tool) => tool.name),
    ['search_docs', 'get_edit_later_queue', 'update_rem', 'resolve_edit_later_item'],
  );

  const queue = await rpc(url, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_edit_later_queue', arguments: {} },
  });
  const result = queue.body.result.structuredContent;
  assert.equal(result.count, 1);
  assert.equal(result.items[0].rem_id, 'queuedRem1');
  assert.equal(result.items[0].front, 'Question');
  assert.equal(result.items[0].back, 'Answer');
  assert.equal(result.items[0].feedback, 'Too vague');
  assert.equal(result.items[0].cards[0].id, 'card1');
  assert.equal(result.items[0].context.raw_document_text, 'Question >> Answer');
  assert.deepEqual(writes, []);
});

test('rejects unauthenticated requests and validates resolution against the live queue', async (t) => {
  const token = 'test-token';
  const databasePath = createFixtureDatabase();
  const writes = [];
  const proxy = http.createServer(
    createMcpHandler({
      expectedToken: token,
      upstreamUrl: 'http://127.0.0.1:1/mcp',
      repository: new EditLaterRepository(databasePath),
      runtimeMcpRunner: async (name, args) => {
        writes.push({ name, args });
        return { ok: true };
      },
      logger: { error() {} },
    }),
  );
  const port = await listen(proxy);
  t.after(() => close(proxy));
  const url = `http://127.0.0.1:${port}/mcp`;

  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(unauthorized.status, 401);

  const missing = await rpc(url, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'resolve_edit_later_item', arguments: { id: 'resolvedRem1' } },
  });
  assert.equal(missing.body.error.code, -32000);
  assert.deepEqual(writes, []);

  const updated = await rpc(url, token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'update_rem', arguments: { id: 'queuedRem1', text: 'Updated question' } },
  });
  assert.equal(updated.body.result.structuredContent.ok, true);
  assert.deepEqual(writes[0], {
    name: 'remnote_rem',
    args: {
      operation: 'set_text',
      remId: 'queuedRem1',
      richText: ['Updated question'],
    },
  });

  const resolved = await rpc(url, token, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'resolve_edit_later_item', arguments: { id: 'queuedRem1' } },
  });
  assert.equal(resolved.body.result.structuredContent.ok, true);
  assert.deepEqual(writes[1], {
    name: 'remnote_rem',
    args: {
      operation: 'remove_powerup',
      remId: 'queuedRem1',
      powerupCode: 'e',
    },
  });
});
