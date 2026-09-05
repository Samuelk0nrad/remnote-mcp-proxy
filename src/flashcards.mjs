import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TEXT_LENGTH = 50_000;
const idSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{3,128}$', description: 'Exact Rem ID, never a practice Card ID.' };
const revisionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Copy revision from a fresh read_flashcard response. A stale revision is rejected.' };
const richSchema = { type: 'array', maxItems: 10000, items: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] }, description: 'Complete replacement SDK rich-text array for this side. Copy existing structured elements and formatting; edit their text without dropping their structure.' };
const plainSchema = { type: 'string', maxLength: MAX_TEXT_LENGTH, description: 'Literal text for this side only. Arrows are content, never front/back delimiters. For a formatted side use its rich-text field.' };
const tool = (name, description, properties, required, readOnly = false) => ({
  name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
});
export const FLASHCARD_TOOLS = [
  tool('read_flashcard', 'Read a Rem through the live SDK before editing or deleting. Returns separate stored front/back, rich text, practice direction, card IDs, child IDs and a revision. Stored sides are not swapped for backward practice. Also supports ordinary Rems and documents for inspection.', { rem_id: idSchema }, ['rem_id'], true),
  tool('update_flashcard', 'Update an existing basic forward/backward flashcard by Rem ID. Read first and copy expected_revision. Supply front and/or back separately; omitted sides and practice direction are preserved. Never concatenate question, separator and answer. Strings cannot replace structured rich text. Verifies both saved sides and card identity. Returns a verification_token for resolving Edit Later. Unsupported card types are refused.', {
    rem_id: idSchema, expected_revision: revisionSchema, front: plainSchema, back: plainSchema,
    front_rich_text: richSchema, back_rich_text: richSchema,
  }, ['rem_id', 'expected_revision']),
  tool('update_rem_front', 'Replace only the stored front/text of a Rem. Read first and copy expected_revision. Back and card direction are preserved. For flashcard answers use update_flashcard with back. Plain text does not parse Markdown or card separators.', {
    rem_id: idSchema, expected_revision: revisionSchema, front: plainSchema, front_rich_text: richSchema,
  }, ['rem_id', 'expected_revision']),
  tool('update_rem', 'Compatibility tool for plain Rem text only. Requires a fresh read_flashcard revision. Refuses flashcards: use update_flashcard with separate front/back instead. Never pass question plus answer in text.', {
    id: idSchema, text: plainSchema, expected_revision: revisionSchema,
  }, ['id', 'text', 'expected_revision']),
  tool('resolve_edit_later_item', 'Clear Edit Later only after a verified correction. Pass the verification_token returned by update_flashcard/update_rem_front. Rejects changed content or changed queue feedback; verifies that the marker is gone.', {
    id: idSchema, verification_token: { type: 'string', maxLength: 4096, description: 'Opaque token from the verified update response; do not invent or modify it.' },
  }, ['id', 'verification_token']),
  tool('delete_rem', 'Delete a non-document Rem by exact Rem ID after read_flashcard. Requires its current revision. Refuses unknown types, documents and folders. Refuses parents unless allow_descendants is explicitly true; that also deletes their subtree. Verifies the Rem is missing.', {
    rem_id: idSchema, expected_revision: revisionSchema,
    allow_descendants: { type: 'boolean', default: false, description: 'True explicitly authorizes deletion of this Rem AND its descendant subtree.' },
  }, ['rem_id', 'expected_revision']),
];

export function strictArgs(args, allowed, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(args, k))) {
    throw new TypeError(`Expected fields: ${allowed.join(', ')}; required: ${required.join(', ')}`);
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
const json = value => JSON.stringify(canonical(value));
const equal = (a, b) => json(a) === json(b);
const digest = value => createHash('sha256').update(json(value)).digest('hex');
export function plainText(value) {
  return (value ?? []).map(p => typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : p?._id ? `[[${p._id}]]` : '[structured content]').join('');
}
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) throw new TypeError('A valid Rem ID is required, not a Card ID.'); }
function expectedRevision(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('Read with read_flashcard first, then pass its revision as expected_revision.'); }
function requireApplied(value) { if (value?.applied !== true) throw new Error('Runtime did not confirm applied:true; read the Rem before retrying.'); }
function protectedStructure(value) {
  // Preserve every structured node and its attributes; only visible text may change.
  return value.filter(p => typeof p !== 'string').map(p => canonical({ ...p, ...(typeof p?.text === 'string' ? { text: '' } : {}) }));
}
function replacement(args, side, current) {
  const richKey = `${side}_rich_text`;
  if (Object.hasOwn(args, side) && Object.hasOwn(args, richKey)) throw new TypeError(`Use either ${side} or ${richKey}, not both.`);
  if (!Object.hasOwn(args, side) && !Object.hasOwn(args, richKey)) return current;
  if (Object.hasOwn(args, side)) {
    if (typeof args[side] !== 'string' || args[side].length > MAX_TEXT_LENGTH) throw new TypeError(`Invalid ${side} text.`);
    if (args[side] === plainText(current)) return current;
    if (current.some(p => typeof p !== 'string')) throw new Error(`${side} contains structured rich text. Read and preserve ${richKey}; plain text would discard formatting, references or clozes.`);
    return [args[side]];
  }
  const value = args[richKey];
  if (!Array.isArray(value) || value.length > 10000 || json(value).length > MAX_TEXT_LENGTH * 4 || value.some(p => typeof p !== 'string' && (!p || typeof p !== 'object' || Array.isArray(p)))) throw new TypeError(`Invalid ${richKey}.`);
  if (!equal(protectedStructure(current), protectedStructure(value))) throw new Error(`${richKey} must preserve existing structured nodes and formatting. Structural edits require a dedicated workflow.`);
  return value;
}

export function createFlashcardService(run, repository, tokenSecret) {
  const locks = new Map();
  async function locked(remId, action) {
    const previous = locks.get(remId) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    locks.set(remId, next);
    await previous;
    try { return await action(); } finally { release(); if (locks.get(remId) === next) locks.delete(remId); }
  }
  const remCall = (operation, remId, more = {}) => run('remnote_rem', { operation, remId, ...more });
  async function read(remId) {
    id(remId);
    const result = await remCall('get', remId);
    const rem = result?.rem;
    if (!rem || rem.remId !== remId || !Array.isArray(rem.text) || !Array.isArray(rem.children) || (rem.backText != null && !Array.isArray(rem.backText))) throw new Error('Runtime returned incomplete Rem content; refusing to guess.');
    const state = await remCall('state', remId);
    if (typeof state?.isDocument !== 'boolean' || typeof state?.isFolder !== 'boolean') throw new Error('Runtime returned unknown document/folder status; refusing to guess.');
    const cardResult = await remCall('cards', remId);
    if (!Array.isArray(cardResult?.cards) || cardResult.cards.length >= 100 || cardResult.cards.some(c => !c?.cardId || c.remId !== remId || typeof c.type !== 'string')) throw new Error('Runtime returned incomplete or unsupported card metadata.');
    const cardStructure = {};
    for (const [name, code] of [['multiline', 'w'], ['multiple_choice', 'mc']]) {
      const result = await remCall('has_powerup', remId, { powerupCode: code });
      if (typeof result?.hasPowerup !== 'boolean') throw new Error('Unknown card structure.');
      cardStructure[name] = result.hasPowerup;
    }
    const cards = cardResult.cards.map(c => ({ card_id: c.cardId, rem_id: c.remId, type: c.type })).sort((a, b) => a.card_id.localeCompare(b.card_id));
    const snapshot = {
      rem_id: remId, front_rich_text: rem.text, back_rich_text: rem.backText ?? [],
      has_back: Array.isArray(rem.backText), parent_rem_id: rem.parentRemId ?? null,
      children: rem.children, rem_type: rem.type ?? null, state, cards, card_structure: cardStructure,
      updated_at: rem.updatedAt ?? null,
    };
    // Detect a concurrent edit during the multi-call read.
    const check = (await remCall('get', remId))?.rem;
    if (!equal(rem, check)) throw new Error('Rem changed while reading; call read_flashcard again.');
    return { ...snapshot, front: plainText(rem.text), back: plainText(rem.backText),
      practice_direction: state.practiceDirection ?? null,
      field_semantics: 'front/back are stored Rem sides; backward practice reverses their roles. Arrows within either field are literal content.',
      revision: digest(snapshot),
      supported_basic_card: cards.length > 0 && cards.every(c => ['forward', 'backward'].includes(c.type)) && state.isCardItem === false && !cardStructure.multiline && !cardStructure.multiple_choice && Array.isArray(rem.backText),
    };
  }
  const structure = s => ({parent: s.parent_rem_id, children: s.children, type: s.rem_type, state: s.state, cards: s.cards, card_structure: s.card_structure, has_back: s.has_back});
  function checkRevision(snapshot, revision) {
    expectedRevision(revision);
    if (snapshot.revision !== revision) throw new Error('Revision conflict: the Rem changed since it was read. Read it again and reconsider the edit. No write was attempted.');
  }
  function queueVersion(remId) {
    const item = repository.get?.(remId);
    return digest(item ? { added_at: item.added_at, feedback: item.feedback_rich_text } : null);
  }
  function receipt(remId, revision, queueVersion) {
    const body = Buffer.from(JSON.stringify({ rem_id: remId, revision, queue_version: queueVersion, issued_at: Date.now() })).toString('base64url');
    return `${body}.${createHmac('sha256', tokenSecret).update(body).digest('hex')}`;
  }
  function verifyReceipt(value, remId) {
    if (typeof value !== 'string' || value.length > 4096) throw new TypeError('A verification_token from a successful update is required.');
    const parts = value.split('.');
    if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) throw new TypeError('Invalid verification_token.');
    const signature = createHmac('sha256', tokenSecret).update(parts[0]).digest();
    if (!timingSafeEqual(signature, Buffer.from(parts[1], 'hex'))) throw new Error('Invalid verification_token signature.');
    let payload; try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { throw new TypeError('Invalid verification_token payload.'); }
    if (payload.rem_id !== remId || !Number.isFinite(payload.issued_at) || payload.issued_at > Date.now() || Date.now() - payload.issued_at > 7 * 86400000) throw new Error('Verification token is expired or belongs to another Rem.');
    return payload;
  }
  async function update(args, kind) {
    const allowed = kind === 'flashcard' ? ['rem_id', 'expected_revision', 'front', 'back', 'front_rich_text', 'back_rich_text'] : ['rem_id', 'expected_revision', 'front', 'front_rich_text'];
    strictArgs(args, allowed, ['rem_id', 'expected_revision']);
    id(args.rem_id); expectedRevision(args.expected_revision);
    if (!allowed.filter(k => ['front', 'back', 'front_rich_text', 'back_rich_text'].includes(k)).some(k => Object.hasOwn(args, k))) throw new TypeError('Supply at least one explicit side to update.');
    return locked(args.rem_id, async () => {
      const before = await read(args.rem_id);
      checkRevision(before, args.expected_revision);
      const isCard = before.has_back || before.cards.length > 0;
      if (kind === 'legacy' && isCard) throw new Error('update_rem cannot update flashcards. Use read_flashcard then update_flashcard with separate front/back fields.');
      if ((kind === 'flashcard' || isCard) && !before.supported_basic_card) throw new Error('Only basic forward/backward cards are supported. Cloze, multiline and other card types need a dedicated editing workflow.');
      const front = replacement(args, 'front', before.front_rich_text);
      const back = replacement(args, 'back', before.back_rich_text);
      const queueBefore = queueVersion(args.rem_id);
      const operations = [
        ['set_text', 'front_rich_text', front, before.front_rich_text],
        ['set_back_text', 'back_rich_text', back, before.back_rich_text],
      ].filter(([, , value, old]) => !equal(value, old));
      if (!operations.length) return { ok: true, changed: false, verified: true, card: before, message: 'No change was needed; no Edit Later verification token was issued.' };
      let expected = before;
      let attempted = false;
      try {
        for (const [operation, field, value] of operations) {
          const current = await read(args.rem_id);
          checkRevision(current, expected.revision);
          attempted = true;
          requireApplied(await remCall(operation, args.rem_id, { richText: value }));
          const saved = await read(args.rem_id);
          const other = field === 'front_rich_text' ? 'back_rich_text' : 'front_rich_text';
          if (!equal(saved[field], value) || !equal(saved[other], expected[other]) || !equal(structure(saved), structure(before))) throw new Error('Saved content or card structure did not match the requested edit.');
          expected = saved;
        }
        if (queueVersion(args.rem_id) !== queueBefore) throw new Error('Edit Later feedback changed during the update.');
        return { ok: true, changed: true, verified: true, card: expected, verification_token: receipt(args.rem_id, expected.revision, queueBefore) };
      } catch (error) {
        // Never replay a write or overwrite an intervening edit automatically.
        // Preserve the receipt-free partial result for explicit recovery using a fresh read.
        if (attempted) throw new Error(`Update could not be fully verified; one or both sides may have changed. Edit Later was not cleared. Read the Rem again before recovery. Cause: ${error.message}`);
        throw error;
      }
    });
  }
  async function resolve(args) {
    strictArgs(args, ['id', 'verification_token'], ['id', 'verification_token']); id(args.id);
    const proof = verifyReceipt(args.verification_token, args.id);
    return locked(args.id, async () => {
      const current = await read(args.id);
      if (proof.revision !== current.revision || proof.queue_version !== queueVersion(args.id)) throw new Error('Content or Edit Later feedback changed after verification; refusing to clear the queue item.');
      const membership = await remCall('has_powerup', args.id, { powerupCode: 'e' });
      if (typeof membership?.hasPowerup !== 'boolean') throw new Error('Unknown Edit Later membership.');
      if (!membership.hasPowerup) return { ok: true, verified: true, already_resolved: true, rem_id: args.id };
      requireApplied(await remCall('remove_powerup', args.id, { powerupCode: 'e' }));
      const after = await remCall('has_powerup', args.id, { powerupCode: 'e' });
      if (after?.hasPowerup !== false) throw new Error('Could not verify removal from Edit Later.');
      return { ok: true, verified: true, rem_id: args.id };
    });
  }
  async function remove(args) {
    strictArgs(args, ['rem_id', 'expected_revision', 'allow_descendants'], ['rem_id', 'expected_revision']); id(args.rem_id); expectedRevision(args.expected_revision);
    if (args.allow_descendants !== undefined && typeof args.allow_descendants !== 'boolean') throw new TypeError('allow_descendants must be boolean.');
    return locked(args.rem_id, async () => {
      const current = await read(args.rem_id); checkRevision(current, args.expected_revision);
      if (current.state.isDocument !== false || current.state.isFolder !== false) throw new Error('delete_rem refuses documents, folders and unknown target types.');
      if (current.children.length && args.allow_descendants !== true) throw new Error('This Rem has descendants. Deletion would remove its subtree; explicit allow_descendants:true is required.');
      requireApplied(await remCall('remove', args.rem_id));
      const result = await run('remnote_rem', { operation: 'find_many', remIds: [args.rem_id] });
      if (!Array.isArray(result?.rems) || result.rems.length !== 0 || result.total !== 0) throw new Error('Deletion was attempted but absence could not be verified; do not blindly retry.');
      return { ok: true, deleted: true, verified: true, rem_id: args.rem_id };
    });
  }
  return { read, update, resolve, remove };
}
