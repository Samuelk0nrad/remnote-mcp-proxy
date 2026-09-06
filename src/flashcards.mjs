import {contentSchema,isFormatted,buildContent,contentView,countSpans} from './formatting.mjs';
import {snapshotImages,imageChangesSchema,applyImageChanges} from './images.mjs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TEXT_LENGTH = 50_000;
const idSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{3,128}$', description: 'Exact Rem ID, never a practice Card ID.' };
const revisionSchema = { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Copy revision from a fresh read_flashcard response. A stale revision is rejected.' };
const richSchema = { type: 'array', maxItems: 10000, items: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] }, description: 'Complete replacement SDK rich-text array for this side. Copy existing structured elements and formatting; edit their text without dropping their structure.' };
const plainSchema = { type: 'string', maxLength: MAX_TEXT_LENGTH, description: 'Literal text for this side only. Arrows are content, never front/back delimiters. For a formatted side use its rich-text field.' };
const tool = (name, description, properties, required, readOnly = false) => ({
  name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: name==='update_flashcard' },
});
export const FLASHCARD_TOOLS = [
  tool('read_flashcard', 'Read a Rem through the live SDK before editing or deleting. Returns separate stored front/back, marked child answer items, rich text, practice direction, card IDs, child IDs and a revision. An empty inline back does not mean a blank practice answer. Stored sides are not swapped for backward practice. Returns front_content/back_content span views on the question and answers for formatting; embedded objects use preserve_element indices. Returns image IDs, locations and metadata in images; use get_flashcard_image for pixels. Also supports ordinary Rems and documents for inspection.', { rem_id: idSchema }, ['rem_id'], true),
  tool('update_flashcard', 'Update an existing basic or multiline card using the same type/direction/front/back/notes fields as creation. Read first and copy expected_revision. Type identifies the existing layout; type conversion is refused. Omitted fields are preserved. Text fields accept strings or {spans:[{text,formats}]} for bold/italic/underline. Preserve embedded nodes using preserve_element indices. Basic back is text content; multiline back.items reuses existing child IDs, supports explicit rem_id and appends new items. Deleting answer/context leaves requires delete_item_rem_ids/delete_note_rem_ids; omission never silently deletes. Typed updates require request_id for durable retry protection. image_changes explicitly adds, replaces or removes images on question sides or direct answer fronts. Legacy rich-text arrays must preserve structure; use explicit spans to add/remove text formatting. Preserves spaced repetition; no reset option. Verifies content, direction and retained card identity/history/schedule, then returns an Edit Later verification token. Legacy basic front/back updates remain compatible.', {
    rem_id: idSchema, expected_revision: revisionSchema, type: {type:'string',enum:['basic','multiline']}, direction:{type:'string',enum:['forward','backward','both'],description:'Omit to preserve current practice direction.'},
    request_id:{type:'string',pattern:'^[A-Za-z0-9_-]{8,128}$',description:'Required for typed, direction, multiline or notes updates. Reuse the same key and arguments after timeouts.'},
    front: contentSchema(plainSchema), back: {anyOf:[...contentSchema(plainSchema).anyOf,{type:'object',additionalProperties:false,properties:{items:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,properties:{rem_id:idSchema,text:contentSchema(plainSchema),rich_text:richSchema},description:'Supply text or rich_text. Without any item IDs, existing surviving items are reused in order and extra entries are new. When any ID is supplied, entries without IDs create new items.'}}},required:['items']}]},
    notes:{type:'array',maxItems:10,items:contentSchema(plainSchema),description:'Replacement literal or formatted context/source texts. Existing surviving notes are reused in order. Omit to preserve all context. Preserve embedded nodes explicitly when using formatted spans.'},
    delete_item_rem_ids:{type:'array',maxItems:20,uniqueItems:true,items:idSchema,description:'Explicit answer-item leaf IDs to delete. Requires the complete replacement back.items list. Independent cards or non-leaf items cannot be deleted here.'},
    delete_note_rem_ids:{type:'array',maxItems:10,uniqueItems:true,items:idSchema,description:'Explicit plain context leaf IDs to delete. Requires notes. Independent cards and non-leaf context cannot be deleted here.'},
    front_rich_text: richSchema, back_rich_text: richSchema, image_changes:imageChangesSchema,
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
  tool('keep_edit_later_item', 'After reviewing the content and Edit Later feedback, keep this Rem unchanged and clear its marker. Read with read_flashcard first, then copy revision and edit_later.queue_revision. Requires an explicit review reason. Rejects stale content or feedback and verifies unchanged sides and structure. Does not edit text or rate a practice card.', {
    rem_id: idSchema, expected_revision: revisionSchema,
    expected_queue_revision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Copy edit_later.queue_revision from the same fresh read_flashcard response.' },
    review_reason: { type: 'string', minLength: 1, maxLength: 2000, description: 'Why the existing content already addresses the queued feedback. Returned to the caller, not saved in the note.' },
  }, ['rem_id', 'expected_revision', 'expected_queue_revision', 'review_reason']),
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

export function createFlashcardService(run, repository, tokenSecret, { getJournal } = {}) {
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
  async function inspectAnswerItems(parent) {
    const observed = [], visited = new Set([parent.remId]);
    async function childrenOf(node, depth) {
      if (depth > 8) throw new Error('Answer nesting is too deep for a verified read.');
      const items = [];
      for (const childId of node.children) {
        if (visited.has(childId) || observed.length >= 50) throw new Error('Answer structure is cyclic or too large for a verified read.');
        visited.add(childId);
        const child = (await remCall('get', childId))?.rem;
        const state = await remCall('state', childId);
        if (!child || child.remId !== childId || child.parentRemId !== node.remId || !Array.isArray(child.text) || !Array.isArray(child.children) || (child.backText != null && !Array.isArray(child.backText)) || typeof state?.isCardItem !== 'boolean') throw new Error('Incomplete child-answer metadata; refusing to guess.');
        const shape = { is_card_item:state.isCardItem, is_list_item:state.isListItem === true };
        observed.push({ rem:child, shape });
        if (state.isCardItem) items.push({ rem_id:childId, front_rich_text:child.text, back_rich_text:child.backText ?? [], has_back:Array.isArray(child.backText), ...shape, children:await childrenOf(child, depth + 1) });
      }
      return items;
    }
    const items = await childrenOf(parent, 0);
    return { items, observed, async verify() {
      // Also recheck unmarked children: adding one to the answer changes meaning.
      for (const old of observed) {
        const fresh = (await remCall('get', old.rem.remId))?.rem;
        const state = await remCall('state', old.rem.remId);
        if (!equal(fresh, old.rem) || !equal({is_card_item:state?.isCardItem,is_list_item:state?.isListItem===true}, old.shape)) throw new Error('Child answer changed while reading; call read_flashcard again.');
      }
    } };
  }
  async function read(remId, checkQueue = true) {
    id(remId);
    const queue = repository.get?.(remId) ?? null;
    const queueRevision = queueDigest(queue);
    const result = await remCall('get', remId);
    const rem = result?.rem;
    if (!rem || rem.remId !== remId || !Array.isArray(rem.text) || !Array.isArray(rem.children) || (rem.backText != null && !Array.isArray(rem.backText))) throw new Error('Runtime returned incomplete Rem content; refusing to guess.');
    const state = await remCall('state', remId);
    if (typeof state?.isDocument !== 'boolean' || typeof state?.isFolder !== 'boolean') throw new Error('Runtime returned unknown document/folder status; refusing to guess.');
    let cardResult = await remCall('cards', remId);
    // getCards() omits Edit Later/disabled cards. Find persisted identities through
    // the SDK as well, never infer their live type from the database code.
    const persistedIds = repository.cardIds?.(remId) ?? [];
    if (persistedIds.length >= 100) throw new Error('Too many practice cards for one safe edit.');
    if (persistedIds.length) {
      const persisted = await run('remnote_card', { operation: 'find_many', cardIds: persistedIds });
      if (!Array.isArray(persisted?.cards) || persisted.cards.some(c => !c)) throw new Error('Card identities are still syncing; read again before editing.');
      const merged = new Map([...(cardResult?.cards ?? []), ...persisted.cards].map(c => [c.cardId, c]));
      cardResult = { cards: [...merged.values()] };
    }
    if (!Array.isArray(cardResult?.cards) || cardResult.cards.length >= 100 || cardResult.cards.some(c => !c?.cardId || c.remId !== remId || typeof c.type !== 'string')) throw new Error('Runtime returned incomplete or unsupported card metadata.');
    const cardStructure = {};
    for (const [name, code] of [['multiline', 'w'], ['multiple_choice', 'mc']]) {
      const result = await remCall('has_powerup', remId, { powerupCode: code });
      if (typeof result?.hasPowerup !== 'boolean') throw new Error('Unknown card structure.');
      cardStructure[name] = result.hasPowerup;
    }
    const cards = cardResult.cards.map(c => ({ card_id: c.cardId, rem_id: c.remId, type: c.type })).sort((a, b) => a.card_id.localeCompare(b.card_id));
    const childAnswer = cards.length || Array.isArray(rem.backText) || state.isCardItem === true ? await inspectAnswerItems(rem) : null;
    const answerItems = childAnswer?.items ?? [];
    // RemNote marks the CHILD as a multiline card item, not necessarily the parent.
    cardStructure.multiline_item = cardStructure.multiline || state.isCardItem === true;
    cardStructure.multiline = cardStructure.multiline_item || answerItems.length > 0;
    const snapshot = {
      rem_id: remId, front_rich_text: rem.text, back_rich_text: rem.backText ?? [],
      has_back: Array.isArray(rem.backText), parent_rem_id: rem.parentRemId ?? null,
      children: rem.children, rem_type: rem.type ?? null, state, cards, card_structure: cardStructure, answer_items:answerItems,
      context_items: (childAnswer?.observed ?? []).filter(c => c.rem.parentRemId === remId && !c.shape.is_card_item).map(c => ({ rem_id:c.rem.remId, front_rich_text:c.rem.text, back_rich_text:c.rem.backText ?? [], children:c.rem.children, ...c.shape })),
      updated_at: rem.updatedAt ?? null,
    };
    // Detect a concurrent edit during the multi-call read.
    await childAnswer?.verify();
    const check = (await remCall('get', remId))?.rem;
    if (!equal(rem, check)) throw new Error('Rem changed while reading; call read_flashcard again.');
    if (checkQueue && queueVersion(remId) !== queueRevision) throw new Error('Edit Later feedback changed while reading; call read_flashcard again.');
    const viewItems=items=>items.map(item=>({...item,front_content:contentView(item.front_rich_text),back_content:contentView(item.back_rich_text),children:viewItems(item.children??[])}));
    return { ...snapshot, front_content:contentView(snapshot.front_rich_text),back_content:contentView(snapshot.back_rich_text),answer_items:viewItems(answerItems),context_items:snapshot.context_items.map(item=>({...item,front_content:contentView(item.front_rich_text),back_content:contentView(item.back_rich_text)})), images:snapshotImages(snapshot), front: plainText(rem.text), back: plainText(rem.backText),
      answer_inspection: { source:childAnswer === null ? 'not_inspected' : answerItems.length ? (plainText(rem.backText).trim() ? 'inline_and_child_items' : 'child_items') : (plainText(rem.backText).trim() ? 'inline_back' : 'no_inline_or_marked_child_answer'), inspected:childAnswer !== null, rendering_verified:false, note:'Marked child items can supply the answer even when back is empty. Ordinary unmarked children are not assumed to be answer items. This is stored structure, not a rendered practice preview; extra detail, hidden content and other rendering rules may affect the screen.' },
      edit_later: { queued: queue !== null, queue_revision: queueRevision, feedback_rich_text: queue?.feedback_rich_text ?? [], added_at: queue?.added_at ?? null },
      practice_direction: state.practiceDirection ?? null,
      field_semantics: 'front/back are stored inline Rem sides; answer_items holds marked child answers and must be inspected before judging an empty back. A parent can be multiline without its own multiline powerup; backward practice reverses their roles. Arrows within either field are literal content.',
      revision: digest(snapshot),
      supported_basic_card: cards.length > 0 && cards.every(c => ['forward', 'backward'].includes(c.type)) && state.isCardItem === false && !cardStructure.multiline && !cardStructure.multiple_choice && Array.isArray(rem.backText),
    };
  }
  const structure = s => ({parent: s.parent_rem_id, children: s.children, type: s.rem_type, state: s.state, cards: s.cards, card_structure: s.card_structure, answer_items:s.answer_items, has_back: s.has_back});
  function checkRevision(snapshot, revision) {
    expectedRevision(revision);
    if (snapshot.revision !== revision) throw new Error('Revision conflict: the Rem changed since it was read. Read it again and reconsider the edit. No write was attempted.');
  }
  function queueDigest(item) {
    return digest(item ? { added_at: item.added_at, feedback: item.feedback_rich_text } : null);
  }
  function queueVersion(remId) { return queueDigest(repository.get?.(remId)); }
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
    if(kind==='flashcard' && (['type','direction','notes','delete_item_rem_ids','delete_note_rem_ids','request_id','image_changes'].some(k=>Object.hasOwn(args,k)) || isFormatted(args.front) || (args.back && typeof args.back==='object')))return updateTyped(args);
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
  async function typedReplacement(args,side,current){
    if(isFormatted(args[side])){if(Object.hasOwn(args,`${side}_rich_text`))throw new TypeError('Use either formatted content or rich_text, not both.');return buildContent(run,args[side],current);}
    return replacement(args,side,current);
  }
  async function updateTyped(args) {
    strictArgs(args, ['rem_id','expected_revision','type','direction','front','back','front_rich_text','back_rich_text','notes','delete_item_rem_ids','delete_note_rem_ids','request_id','image_changes'], ['rem_id','expected_revision','request_id']);
    id(args.rem_id);expectedRevision(args.expected_revision);
    if(typeof args.request_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(args.request_id))throw new TypeError('Typed updates require a unique request_id; reuse it unchanged on retries.');
    if(args.type!==undefined&&!['basic','multiline'].includes(args.type))throw new TypeError('Supported update types: basic, multiline.');
    if(args.direction!==undefined&&!['forward','backward','both'].includes(args.direction))throw new TypeError('Invalid practice direction.');
    if(!['front','back','front_rich_text','back_rich_text','notes','direction','image_changes'].some(k=>Object.hasOwn(args,k)))throw new TypeError('Supply at least one explicit field to update.');
    if(countSpans(args)>200)throw new TypeError('At most 200 formatted spans per update.');
    if(!getJournal)throw new Error('Persistent update journal is unavailable.');
    const journal=getJournal(),key=digest(['update',args.request_id]),requestDigest=digest(args);
    return locked(args.rem_id,async()=>{
      const previous=journal.get(key);
      if(previous){
        if(previous.digest!==requestDigest)throw new TypeError('request_id was already used with different update arguments.');
        if(previous.status==='complete')return {...previous.result,replayed:true,verification_scope:'original_update_receipt'};
        return {ok:false,status:'needs_inspection',rem_id:args.rem_id,created_rem_ids:previous.created_rem_ids??[],uncertain_creation:previous.uncertain_creation===true,message:'This update was interrupted or failed. Read the card before recovery; do not bypass the guard with a new request key.'};
      }
      const before=await read(args.rem_id);checkRevision(before,args.expected_revision);
      const multiline=before.card_structure.multiline && !before.card_structure.multiline_item && before.answer_items.length>0;
      if(before.state.isDocument!==false||before.state.isFolder!==false||(!before.supported_basic_card&&!multiline)||before.card_structure.multiple_choice||before.state.isCardItem!==false||!before.cards.length||before.cards.some(c=>!['forward','backward'].includes(c.type)))throw new Error('Only existing basic or multiline question cards can be updated here.');
      const type=multiline?'multiline':'basic';
      if(args.type!==undefined&&args.type!==type)throw new Error('Type conversion is not supported; type must match the existing card.');
      if(multiline&&before.back.trim())throw new Error('Mixed inline and child answers require a dedicated structural edit.');
      const front=[...await typedReplacement(args,'front',before.front_rich_text)];
      const back=[...(multiline?before.back_rich_text:await typedReplacement(args,'back',before.back_rich_text))];
      if(multiline&&Object.hasOwn(args,'back_rich_text'))throw new TypeError('Multiline cards use back.items, not back_rich_text.');
      if(!multiline&&Object.hasOwn(args,'delete_item_rem_ids'))throw new TypeError('Basic cards have no multiline answer items.');
      if(!plainText(front).trim()||(!multiline&&!plainText(back).trim()))throw new TypeError('Question and basic answer must not be blank.');
      const direction=args.direction??before.practice_direction;
      const direct=[];
      for(const childId of before.children){
        const child=(await remCall('get',childId))?.rem,state=await remCall('state',childId);
        if(!child||child.parentRemId!==args.rem_id||!Array.isArray(child.text)||!Array.isArray(child.children)||typeof state?.isCardItem!=='boolean')throw new Error('Incomplete child metadata.');
        direct.push({id:childId,rich:child.text,answer:state.isCardItem,rem:child,state});
      }
      function deletedIds(name,requiredField,answer){
        const value=args[name]??[];
        if(!Array.isArray(value)||value.length>(answer?20:10)||new Set(value).size!==value.length)throw new TypeError('Invalid explicit deletion list.');
        if(Object.hasOwn(args,name)&&!Object.hasOwn(args,requiredField))throw new TypeError(`${name} requires ${requiredField}.`);
        for(const remId of value){id(remId);const child=direct.find(c=>c.id===remId);if(!child||child.answer!==answer||child.rem.children.length||(child.rem.backText?.length??0)>0||(repository.cardIds?.(remId)??[]).length)throw new Error('Deletion is limited to named answer/context leaves without independent cards.');}
        return new Set(value);
      }
      const deletedAnswers=deletedIds('delete_item_rem_ids','back',true),deletedNotes=deletedIds('delete_note_rem_ids','notes',false);
      const oldAnswers=direct.filter(c=>c.answer),oldNotes=direct.filter(c=>!c.answer);
      let answers=oldAnswers.map(c=>({...c,rich:[...c.rich]})),notes=oldNotes.map(c=>({...c}));
      if(multiline&&Object.hasOwn(args,'back')){
        strictArgs(args.back,['items'],['items']);
        if(!Array.isArray(args.back.items)||!args.back.items.length||args.back.items.length>20)throw new TypeError('Multiline back.items needs 1-20 answer items.');
        if(oldAnswers.some(c=>c.rem.children.length))throw new Error('Nested answer items must be edited separately; flat replacement would obscure their structure.');
        const explicit=args.back.items.some(item=>item&&Object.hasOwn(item,'rem_id')),survivors=oldAnswers.filter(c=>!deletedAnswers.has(c.id));
        answers=await Promise.all(args.back.items.map(async(item,index)=>{
          strictArgs(item,['rem_id','text','rich_text']);
          if(Object.hasOwn(item,'text')===Object.hasOwn(item,'rich_text'))throw new TypeError('Each answer item needs either text or rich_text.');
          let old;
          if(item.rem_id!==undefined){id(item.rem_id);old=survivors.find(c=>c.id===item.rem_id);if(!old)throw new Error('Answer item ID is not a surviving direct marked child.');}
          else if(!explicit)old=survivors[index];
          const rich=await typedReplacement(Object.hasOwn(item,'text')?{front:item.text}:{front_rich_text:item.rich_text},'front',old?.rich??[]);
          if(!plainText(rich).trim())throw new TypeError('Answer items must not be blank.');
          return {...old,id:old?.id??null,rich:[...rich],answer:true};
        }));
        const kept=answers.filter(c=>c.id).map(c=>c.id);
        if(new Set(kept).size!==kept.length||survivors.some(c=>!kept.includes(c.id)))throw new Error('Every surviving answer item must appear exactly once. Name removed leaves in delete_item_rem_ids.');
      }
      if(Object.hasOwn(args,'notes')){
        if(!Array.isArray(args.notes)||args.notes.length>10)throw new TypeError('notes must contain at most 10 text values.');
        const survivors=oldNotes.filter(c=>!deletedNotes.has(c.id));
        if(args.notes.length<survivors.length)throw new Error('Name removed context leaves in delete_note_rem_ids.');
        notes=await Promise.all(args.notes.map(async(value,index)=>{const old=survivors[index],rich=await typedReplacement({front:value},'front',old?.rich??[]);if(!plainText(rich).trim())throw new TypeError('Context notes must not be blank.');return {...old,id:old?.id??null,rich,answer:false};}));
      }
      for(const note of notes)if(note.rem&&!equal(note.rich,note.rem.text)&&((note.rem.backText?.length??0)>0||(repository.cardIds?.(note.id)??[]).length))throw new Error('Independent child cards must be updated through their own Rem ID and revision, not notes.');
      await applyImageChanges(run,args.image_changes,[{id:args.rem_id,side:'front',rich:front,root:true},...(!multiline?[{id:args.rem_id,side:'back',rich:back,root:true}]:[]),...answers.filter(c=>c.id).map(c=>({id:c.id,side:'front',rich:c.rich}))]);
      if(!plainText(front).trim()||(!multiline&&!plainText(back).trim())||answers.some(c=>!plainText(c.rich).trim()))throw new TypeError('Image removal must not leave a blank question or answer.');
      for(const item of answers)if(item.rem&&!equal(item.rich,item.rem.text)&&((item.rem.backText?.length??0)>0||(repository.cardIds?.(item.id)??[]).length))throw new Error('Independent answer cards must be edited through their own Rem ID.');
      const planned=[...answers,...notes],newItems=planned.filter(c=>!c.id);
      if(before.children.length+newItems.length>50||json(args).length>200000||json([front,back,...planned.map(c=>c.rich)]).length>200000)throw new Error('Update exceeds safe child or text limits; split the work into smaller updates.');
      const historyIds=[...new Set([...before.cards.map(c=>c.card_id),...direct.flatMap(c=>repository.cardIds?.(c.id)??[])])];
      if(typeof repository.cardHistorySnapshot!=='function'||typeof repository.cardScheduleSnapshot!=='function')throw new Error('History/schedule verification is unavailable.');
      const history=repository.cardHistorySnapshot(historyIds),schedule=repository.cardScheduleSnapshot(historyIds,{includeActive:direction===before.practice_direction});
      if(history.length!==historyIds.length||schedule.length!==historyIds.length)throw new Error('Card history is still syncing; read again before updating.');
      checkRevision(await read(args.rem_id),args.expected_revision);
      const record={status:'pending',created_rem_ids:[],uncertain_creation:false};
      if(!journal.claim(key,requestDigest,record))throw new Error('Update request claimed concurrently; retry the same key.');
      const wantedDirections=direction==='both'?['forward','backward']:[direction];
      // RemNote removes unused directions only when their history is empty;
      // studied directions remain retained/retired. Never excuse a lost studied card.
      const removableUnusedIds=direction===before.practice_direction?[]:before.cards.filter(c=>!wantedDirections.includes(c.type)&&history.find(h=>h._id===c.card_id)?.history.length===0).map(c=>c.card_id);
      let expected=before,changed=false;
      const guard=async()=>checkRevision(await read(args.rem_id),expected.revision);
      async function write(operation,remId,more){await guard();requireApplied(await remCall(operation,remId,more));changed=true;expected=await read(args.rem_id);}
      try{
        // Build new leaves before linking them; persist uncertainty before allocation.
        for(const item of newItems){
          await guard();record.uncertain_creation=true;journal.save(key,record);
          const created=(await run('remnote_rem',{operation:'create_rem'}))?.rem;id(created?.remId);
          item.id=created.remId;record.created_rem_ids.push(item.id);record.uncertain_creation=false;journal.save(key,record);
          requireApplied(await remCall('set_text',item.id,{richText:item.rich}));
          if(item.answer)requireApplied(await remCall('set_card_item',item.id,{value:true}));
          await write('set_parent',item.id,{targetRemId:args.rem_id});
        }
        if(!equal(front,before.front_rich_text))await write('set_text',args.rem_id,{richText:front});
        if(!multiline&&!equal(back,before.back_rich_text))await write('set_back_text',args.rem_id,{richText:back});
        for(const item of planned)if(item.rem&&!equal(item.rich,item.rem.text))await write('set_text',item.id,{richText:item.rich});
        for(const remId of [...deletedAnswers,...deletedNotes]){
          // Prevent removal of a leaf that acquired context or independent cards.
          const current=(await remCall('get',remId))?.rem;
          if(!current||current.children.length||!equal(current.text,direct.find(c=>c.id===remId).rem.text)||!equal(current.backText??[],direct.find(c=>c.id===remId).rem.backText??[])||(repository.cardIds?.(remId)??[]).length)throw new Error('A deletion target changed; inspection required.');
          await write('remove',remId);
        }
        // Preserve context slots/relative order while replacing answer slots.
        const desired=[];let ai=0,ni=0;
        for(const child of direct){
          if(child.answer){if(ai<answers.length)desired.push(answers[ai++].id);if(child.id===oldAnswers.at(-1)?.id)while(ai<answers.length)desired.push(answers[ai++].id);}
          else {if(ni<notes.length)desired.push(notes[ni++].id);if(child.id===oldNotes.at(-1)?.id)while(ni<notes.length)desired.push(notes[ni++].id);}
        }
        while(ai<answers.length)desired.push(answers[ai++].id);while(ni<notes.length)desired.push(notes[ni++].id);
        if(!equal(expected.children,desired))for(const remId of desired){await guard();const result=await run('remnote_rem',{operation:'move_many',remIds:[remId],targetRemId:args.rem_id,position:expected.children.length});requireApplied(result);changed=true;expected=await read(args.rem_id);}
        if(direction!==before.practice_direction)await write('set_practice_direction',args.rem_id,{value:direction});
        // New direction IDs can be generated asynchronously. Never recreate the Rem.
        const needed=direction==='both'?['forward','backward']:['forward','backward'].includes(direction)?[direction]:[];
        for(let i=0;i<20&&!needed.every(type=>expected.cards.some(c=>c.type===type));i++){await new Promise(r=>setTimeout(r,100));expected=await read(args.rem_id);}
        if(!needed.every(type=>expected.cards.some(c=>c.type===type)))throw new Error('Requested practice direction has not generated its cards.');
        const checks={parent:expected.parent_rem_id===before.parent_rem_id,children:equal(expected.children,desired),front:equal(expected.front_rich_text,front),back:equal(expected.back_rich_text,back),has_back:expected.has_back===before.has_back,direction:expected.practice_direction===direction,state:equal({...expected.state,practiceDirection:before.state.practiceDirection},before.state),card_structure:equal(expected.card_structure,before.card_structure),card_ids:before.cards.every(c=>expected.cards.some(next=>equal(c,next))||removableUnusedIds.includes(c.card_id))};
        const mismatches=Object.entries(checks).filter(([,ok])=>!ok).map(([field])=>field);
        if(mismatches.length)throw new Error(`Final question verification failed: ${mismatches.join(', ')}.`);
        for(const item of planned){const actual=(await remCall('get',item.id))?.rem,state=await remCall('state',item.id);if(!actual||actual.parentRemId!==args.rem_id||!equal(actual.text,item.rich)||state.isCardItem!==item.answer||!equal(actual.children,item.rem?.children??[])||!equal(actual.backText??[],item.rem?.backText??[]))throw new Error('Final answer/context structure did not match.');}
        for(const remId of [...deletedAnswers,...deletedNotes]){const absent=await run('remnote_rem',{operation:'find_many',remIds:[remId]});if(absent.total!==0||absent.rems?.length!==0)throw new Error('Deleted leaf absence could not be verified.');}
        const removedUnusedIds=removableUnusedIds.filter(id=>!expected.cards.some(c=>c.card_id===id));
        const retainedIds=historyIds.filter(id=>!removedUnusedIds.includes(id));
        if(!equal(history.filter(h=>retainedIds.includes(h._id)),repository.cardHistorySnapshot(retainedIds)))throw new Error('Retained review history changed during the update.');
        if(!equal(schedule.filter(s=>retainedIds.includes(s._id)),repository.cardScheduleSnapshot(retainedIds,{includeActive:direction===before.practice_direction})))throw new Error('Retained spaced repetition schedule changed during the update.');
        if(queueVersion(args.rem_id)!==before.edit_later.queue_revision)throw new Error('Edit Later feedback changed during the update.');
        const result={ok:true,changed,verified:true,replayed:false,rem_id:args.rem_id,type,revision:expected.revision,spaced_repetition:{policy:'preserve',history_verified:true,schedule_verified:true,active_queue_verified:direction===before.practice_direction,removed_unreviewed_practice_card_ids:removedUnusedIds,new_practice_card_ids:expected.cards.filter(c=>!before.cards.some(old=>old.card_id===c.card_id)).map(c=>c.card_id)},created_rem_ids:record.created_rem_ids,deleted_rem_ids:[...deletedAnswers,...deletedNotes],...(changed?{verification_token:receipt(args.rem_id,expected.revision,queueVersion(args.rem_id))}:{})};
        record.status='complete';record.result=result;journal.save(key,record);return {...result,card:expected};
      }catch(error){record.status='needs_inspection';try{journal.save(key,record);}catch{}return {ok:false,status:'needs_inspection',rem_id:args.rem_id,created_rem_ids:record.created_rem_ids,uncertain_creation:record.uncertain_creation,message:`Update may be partial. Edit Later was not cleared. Read the card before recovery; do not repeat with a new request key. ${error.message}`};}
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
  async function keep(args) {
    strictArgs(args, ['rem_id', 'expected_revision', 'expected_queue_revision', 'review_reason'], ['rem_id', 'expected_revision', 'expected_queue_revision', 'review_reason']);
    id(args.rem_id); expectedRevision(args.expected_revision); expectedRevision(args.expected_queue_revision);
    if (typeof args.review_reason !== 'string' || !args.review_reason.trim() || args.review_reason.length > 2000) throw new TypeError('A non-empty review_reason of at most 2000 characters is required.');
    return locked(args.rem_id, async () => {
      const before = await read(args.rem_id);
      checkRevision(before, args.expected_revision);
      if (!before.edit_later.queued || before.edit_later.queue_revision !== args.expected_queue_revision) throw new Error('Edit Later feedback changed or is absent; read the card and review its feedback again.');
      const membership = await remCall('has_powerup', args.rem_id, { powerupCode: 'e' });
      if (membership?.hasPowerup !== true || queueVersion(args.rem_id) !== args.expected_queue_revision) throw new Error('Edit Later membership or feedback changed; no write was attempted.');
      requireApplied(await remCall('remove_powerup', args.rem_id, { powerupCode: 'e' }));
      // The SDK marker write may reach SQLite during this verification read.
      // Verify live content and membership; queue stability only guards pre-write reads.
      const after = await read(args.rem_id, false);
      const marker = await remCall('has_powerup', args.rem_id, { powerupCode: 'e' });
      // Marker removal can change scheduling state and update timestamps.
      const content = s => ({ front:s.front_rich_text, back:s.back_rich_text, has_back:s.has_back, parent:s.parent_rem_id, children:s.children, type:s.rem_type, cards:s.cards, card_structure:s.card_structure, answer_items:s.answer_items, direction:s.practice_direction });
      if (marker?.hasPowerup !== false || !equal(content(before), content(after))) throw new Error('Marker removal was attempted but unchanged content could not be verified. Read the Rem before recovery; do not blindly retry.');
      return { ok:true, verified:true, kept_unchanged:true, rem_id:args.rem_id, review_reason:args.review_reason.trim() };
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
  return { read, update, resolve, keep, remove };
}
