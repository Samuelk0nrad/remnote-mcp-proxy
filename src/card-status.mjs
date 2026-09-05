import { open, stat } from 'node:fs/promises';
import { plainText, strictArgs } from './flashcards.mjs';

export const STATUS_ADAPTER = { app_version: '1.28.0', bundle: 'heavy-worker-startup.8b0971c091023ef9.bundle.js' };
const STATUS_NAMES = ['leech', 'struggling', 'disabled', 'enabled', 'edit_later', 'new', 'not_yet_learned', 'stale'];
const POWERUPS = { l:'Aliases', a:'Auto Sort', at:'Applied Templates', m:'Auto Template', c:'Custom CSS', d:'Daily Document', u:'Disable Cards', dv:'Divider', o:'Document', s:'Document Sidebar', e:'Edit Later', j:'Emoji', x:'Extra Card Detail', r:'Header', h:'Highlight', b:'Link', i:'List', mc:'Multiple Choice', w:'Multiline Card', pn:'PDF Page Number', n:'PDF Highlight', q:'Quick Add', qt:'Quote', rt:'Restored from Trash', y:'Slot', os:'Sources', k:'Super Private', toc:'Table of Contents', tts:'Text to Speech', ew:'Embed Website', g:'Used as Tag', t:'Todo', f:'Uploaded File', p:'Web Highlight', z:'Website', cd:'Code', ty:'Type in Answer', de:'Deck', sp:'Search Portal', ct:'Collection', hh:'HTML Highlight', ha:'Hide Queue Ancestors', id:'Imported Document', im:'Image', sd:'Saved Documents', clo:'Callout' };
const readOnly = { readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false };
export const STATUS_TOOLS = [
  {
    name:'get_card_status',
    description:'Read card labels for a Rem: Leech, Struggling, Disabled, Enabled, Edit Later, New, Not Yet Learned and Stale, plus direct built-in powerups and live direct tags. Reports each practice Card ID separately. Leech is computed using the installed RemNote rule and configured threshold, never guessed from total failures. Results are read-only; use read_flashcard for live content/revision before editing.',
    inputSchema:{type:'object',additionalProperties:false,properties:{rem_id:{type:'string',pattern:'^[A-Za-z0-9_-]{3,128}$',description:'Exact Rem ID, not Card ID.'},limit:{type:'integer',minimum:1,maximum:100,default:100},cursor:{type:'string',maxLength:1024,description:'Opaque next_cursor from the same Rem status query.'}},required:['rem_id']},annotations:readOnly,
  },
  {
    name:'list_cards_by_status',
    description:'Find cards by RemNote status label, such as leech, struggling, disabled or edit_later. Uses the installed app rule and your configured leech threshold, and returns Card IDs, Rem IDs, stored front/back, all supported labels, total and cursor. Follow next_cursor until has_more is false. Status is calculated from the local synced database; it is not a tag search. Does not change review history or labels.',
    inputSchema:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:STATUS_NAMES},limit:{type:'integer',minimum:1,maximum:100,default:50},cursor:{type:'string',maxLength:1024,description:'Opaque next_cursor from the same status query.'}},required:['status']},annotations:readOnly,
  },
];

// Source contract: installed RemNote 1.28.0 worker modules 547092 (cards),
// 142529 (history), 698579 (trailing history), 296332 (storage fields),
// and the native Card Table filters. Do not change to failures >= threshold:
// native Leech is a positive MULTIPLE of the threshold after the first
// Good/Easy since the latest Reset; if never learned, use all post-reset history.
export function cardLabels(card, rem, threshold, now = Date.now()) {
  if (card.h !== undefined && !Array.isArray(card.h)) throw new Error('Unsupported review-history shape.');
  const history = card.h ?? [];
  if (history.some(event => !event || typeof event.score !== 'number')) throw new Error('Unsupported review-history entry.');
  const reset = history.findLastIndex(event => event.score === 3);
  const sinceReset = history.slice(reset + 1);
  const learned = sinceReset.findIndex(event => event.score === 1 || event.score === 1.5);
  const failures = (learned < 0 ? sinceReset : sinceReset.slice(learned)).filter(event => event.score === 0).length;
  const editLater = rem?.apu?.e?.v === true || rem?.apu?.e?.v === 1;
  const isNew = sinceReset.length === 0;
  return {
    labels:{
      leech: failures > 0 && failures % threshold === 0,
      struggling: failures > 0 && failures % 2 === 0,
      disabled: !card.a && !card.b && !editLater,
      enabled: !!card.a,
      edit_later:editLater,
      new:isNew,
      not_yet_learned:!!card.ny,
      stale:!isNew && !!card.st && card.st < now,
    },
    leech_failure_count:failures,
    leech_threshold:threshold,
    review_history_entries:history.length,
  };
}
export function readLeechThreshold(db) {
  const rows = db.prepare("SELECT json_extract(doc, '$.value') AS value FROM user_data WHERE json_extract(doc, '$.key') = 'leechThreshold'").all();
  if (rows.length > 1) throw new Error('Ambiguous leech threshold records; refusing to guess.');
  const value = rows[0]?.value;
  if (value == null) return { value:4, source:'RemNote default' };
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Unsupported leech threshold setting.');
  return { value:Math.max(4,value), source:'RemNote user setting' };
}
export function remLabels(rem) {
  return Object.entries(rem.apu ?? {}).filter(([,v])=>v?.v !== undefined && v.v !== false && v.v !== null && v.v !== 0).map(([code,value])=>({code,label:POWERUPS[code] ?? `Unknown powerup (${code})`,value:value.v}));
}

// Refuse native-label claims after the installed app changes until its rules are
// rechecked. Read only the ASAR header and package.json, never extract the app.
export function createAdapterVerifier(asarPath) {
  let signature;
  return async () => {
    const info = await stat(asarPath);
    const next = `${info.size}:${info.mtimeMs}`;
    if (signature === next) return;
    const file = await open(asarPath,'r');
    try {
      const prefix = Buffer.alloc(16);await file.read(prefix,0,16,0);
      const length = prefix.readUInt32LE(12);
      if (length > 20_000_000) throw new Error('Unsupported RemNote app archive.');
      const bytes = Buffer.alloc(length);await file.read(bytes,0,length,16);
      const header = JSON.parse(bytes.toString());
      const entry = header.files?.['package.json'];
      if (!entry || entry.size > 100_000 || !header.files?.build?.files?.js?.files?.[STATUS_ADAPTER.bundle]) throw new Error('RemNote app changed; its card-label adapter must be reviewed.');
      const pkg = Buffer.alloc(entry.size);await file.read(pkg,0,pkg.length,8+prefix.readUInt32LE(4)+Number(entry.offset));
      if (JSON.parse(pkg.toString()).version !== STATUS_ADAPTER.app_version) throw new Error('RemNote version changed; its card-label adapter must be reviewed.');
      signature = next;
    } finally { await file.close(); }
  };
}
export function createStatusService(repository, run, verifyAdapter) {
  function scan({ remId, status, limit = 100, cursor }) {
    let after = null;
    if (cursor !== undefined) {
      try { after = JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch { throw new TypeError('Invalid status cursor.'); }
      if (!after || after.status !== status || (after.rem_id ?? null) !== (remId ?? null) || typeof after.card_id !== 'string') throw new TypeError('Cursor does not belong to this status query.');
    }
    return repository.withDatabase(db => {
      db.exec('BEGIN');
      try {
        const threshold = readLeechThreshold(db);
        const rows = db.prepare(`SELECT c._id AS card_id, c.doc AS card_doc, r._id AS rem_id, r.doc AS rem_doc
          FROM cards c JOIN quanta r ON json_extract(c.doc,'$.rId') = r._id
          WHERE COALESCE(json_extract(c.doc,'$.b'),0) <> 1 AND (? IS NULL OR r._id = ?) ORDER BY c._id`).iterate(remId ?? null,remId ?? null);
        let total=0, more=0;const items=[];const now=Date.now();
        for (const row of rows) {
          const card=JSON.parse(row.card_doc),rem=JSON.parse(row.rem_doc);
          const derived=cardLabels(card,rem,threshold.value,now);
          if (status && !derived.labels[status]) continue;
          total++;
          if (after && row.card_id <= after.card_id) continue;
          if (items.length >= limit) {more++;continue;}
          items.push({card_id:row.card_id,rem_id:row.rem_id,parent_rem_id:rem.parent??null,
            card_type:card.c==='f'?'forward':card.c==='b'?'backward':card.c,
            front:plainText(Array.isArray(rem.key)?rem.key:[]),back:plainText(Array.isArray(rem.value)?rem.value:[]),
            ...derived,next_repetition_at:card.n??null,last_repetition_at:card.l??null,
            rem_labels:remLabels(rem),
          });
        }
        return {items,count:items.length,total,has_more:more>0,next_cursor:more?Buffer.from(JSON.stringify({status,rem_id:remId,card_id:items.at(-1).card_id})).toString('base64url'):null,
          leech_threshold:threshold,adapter:STATUS_ADAPTER,
          source:'Read-only local synced RemNote database; native label rules verified for the installed app build.',
          field_semantics:'Stored front/back are not swapped for backward practice. Rem-level powerups and tags are distinct from computed card labels. Disabled excludes Edit Later and retired cards; paused documents are not classified as disabled solely because they are paused.',
        };
      } finally { db.exec('COMMIT'); }
    });
  }
  return {
    async list(args) {
      strictArgs(args,['status','limit','cursor'],['status']);
      if (!STATUS_NAMES.includes(args.status) || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit<1 || args.limit>100)) || (args.cursor!==undefined && (typeof args.cursor!=='string'||args.cursor.length>1024))) throw new TypeError('Invalid status filter or pagination.');
      await verifyAdapter();
      return scan({status:args.status,limit:args.limit??50,cursor:args.cursor});
    },
    async get(args) {
      strictArgs(args,['rem_id','limit','cursor'],['rem_id']);
      if ((args.limit!==undefined && (!Number.isInteger(args.limit)||args.limit<1||args.limit>100)) || (args.cursor!==undefined && (typeof args.cursor!=='string'||args.cursor.length>1024))) throw new TypeError('Invalid status pagination.');
      if (typeof args.rem_id!=='string'||!/^[A-Za-z0-9_-]{3,128}$/.test(args.rem_id)) throw new TypeError('A valid Rem ID is required.');
      await verifyAdapter();
      const result=scan({remId:args.rem_id,limit:args.limit??100,cursor:args.cursor});
      const tags=await run('remnote_rem',{operation:'tags',remId:args.rem_id,limit:1000});
      if (!Array.isArray(tags?.rems) || typeof tags.total!=='number') throw new Error('Live tag metadata was incomplete.');
      return {...result,rem_id:args.rem_id,tags:tags.rems.map(rem=>({rem_id:rem.remId,text:plainText(rem.text)})),tags_total:tags.total,tags_truncated:tags.truncated===true};
    },
  };
}
