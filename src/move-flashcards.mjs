import {createHash} from 'node:crypto';
import {strictArgs} from './flashcards.mjs';
const id={type:'string',pattern:'^[A-Za-z0-9_-]{3,128}$',description:'Exact Rem ID, never a practice Card ID.'};
const revision={type:'string',pattern:'^[a-f0-9]{64}$',description:'Revision from a fresh read_flashcard response.'};
export const MOVE_FLASHCARD_TOOL={name:'move_flashcards',description:'Move existing question Rems and their child answers/context into an exact document or heading, preserving content, practice-card IDs and retained review history. Read each source and the destination with read_flashcard; supply their revisions. Placement supports start/end or before/after a remaining direct sibling. Batch order follows cards. Refuses documents, standalone answer items, ancestor/descendant batches and cyclic moves. Verifies original/source and destination sibling order, subtree content, card identity and history after SDK moves. Reuse the same request_id and arguments after a timeout; uncertain moves require inspection and are never automatically repeated or reversed. Does not create, delete, grade, or clear Edit Later.',inputSchema:{type:'object',additionalProperties:false,properties:{
 cards:{type:'array',minItems:1,maxItems:10,items:{type:'object',additionalProperties:false,properties:{rem_id:id,expected_revision:revision},required:['rem_id','expected_revision']}},
 parent_rem_id:id,expected_parent_revision:revision,
 placement:{type:'object',additionalProperties:false,properties:{position:{type:'string',enum:['start','end','before','after']},sibling_rem_id:id},required:['position'],description:'Defaults to end. before/after require a direct sibling that is not being moved.'},
 request_id:{type:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$',description:'Unique move request key; reuse unchanged on retries.'},
},required:['cards','parent_rem_id','expected_parent_revision','request_id']},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
const json=v=>JSON.stringify(canonical(v));
const equal=(a,b)=>json(a)===json(b);
const hash=v=>createHash('sha256').update(json(v)).digest('hex');
const validId=v=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{3,128}$/.test(v))throw new TypeError('Use exact Rem IDs.');};
const validRevision=v=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new TypeError('Read sources and destination first, then supply their revisions.');};
function validate(raw){
 strictArgs(raw,Object.keys(MOVE_FLASHCARD_TOOL.inputSchema.properties),MOVE_FLASHCARD_TOOL.inputSchema.required);
 validId(raw.parent_rem_id);validRevision(raw.expected_parent_revision);
 if(!Array.isArray(raw.cards)||!raw.cards.length||raw.cards.length>10)throw new TypeError('Move 1-10 question Rems.');
 for(const card of raw.cards){strictArgs(card,['rem_id','expected_revision'],['rem_id','expected_revision']);validId(card.rem_id);validRevision(card.expected_revision);}
 if(new Set(raw.cards.map(c=>c.rem_id)).size!==raw.cards.length)throw new TypeError('Duplicate source Rem IDs.');
 if(typeof raw.request_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(raw.request_id))throw new TypeError('Invalid request_id.');
 const placement=raw.placement??{position:'end'};strictArgs(placement,['position','sibling_rem_id'],['position']);
 if(!['start','end','before','after'].includes(placement.position))throw new TypeError('Invalid placement.');
 if(['before','after'].includes(placement.position))validId(placement.sibling_rem_id);else if(Object.hasOwn(placement,'sibling_rem_id'))throw new TypeError('Only before/after accept sibling_rem_id.');
 return {...raw,placement};
}
const rootContent=s=>({front:s.front_rich_text,back:s.back_rich_text,has_back:s.has_back,children:s.children,rem_type:s.rem_type,state:s.state,cards:s.cards,card_structure:s.card_structure,answer_items:s.answer_items,edit_later:s.edit_later});
export function createCardMoveService(run,flashcards,repository,getJournal){
 let tail=Promise.resolve();
 const call=(operation,remId,more={})=>run('remnote_rem',{operation,remId,...more});
 const get=async id=>{const rem=(await call('get',id))?.rem;if(!rem||rem.remId!==id||!Array.isArray(rem.children)||!Array.isArray(rem.text))throw new Error('Incomplete Rem metadata.');return rem;};
 async function descendants(snapshot){
  const result=[];const seen=new Set([snapshot.rem_id]);
  async function walk(ids,depth){if(depth>8)throw new Error('Move subtree exceeds safe depth.');for(const id of ids){if(seen.has(id)||result.length>=100)throw new Error('Cyclic or excessive move subtree.');seen.add(id);const rem=await get(id),state=await call('state',id);
    const live=(await call('cards',id))?.cards,persistedIds=repository.cardIds?.(id)??[];
    if(!Array.isArray(live)||persistedIds.length>=100)throw new Error('Incomplete descendant card identities.');
    const persisted=persistedIds.length?(await run('remnote_card',{operation:'find_many',cardIds:persistedIds}))?.cards:[];
    if(!Array.isArray(persisted)||[...live,...persisted].some(c=>!c?.cardId||c.remId!==id||typeof c.type!=='string'))throw new Error('Descendant card identity is still syncing.');
    const cards=[...new Map([...live,...persisted].map(c=>[c.cardId,{card_id:c.cardId,type:c.type}])).values()].sort((a,b)=>a.card_id.localeCompare(b.card_id));
    result.push({rem:{...rem,updatedAt:undefined},state,cards});await walk(rem.children,depth+1);}}
  await walk(snapshot.children,0);return result;
 }
 async function execute(raw){
  const args=validate(raw),journal=getJournal(),key=hash(['move',args.request_id]),digest=hash(args),old=journal.get(key);
  if(old){if(old.digest!==digest)throw new TypeError('request_id was already used with different move arguments.');if(old.status==='complete')return {...old.result,replayed:true,verification_scope:'original_move_receipt'};return {ok:false,status:'needs_inspection',rem_ids:old.rem_ids,message:'This move has an uncertain or interrupted outcome. Read its sources and destination before recovery; do not blindly retry with a new request_id.'};}
  const ids=args.cards.map(c=>c.rem_id),selected=new Set(ids),before=[];
  for(const card of args.cards){const s=await flashcards.read(card.rem_id);if(s.revision!==card.expected_revision)throw new Error('Source revision conflict. No move attempted.');if(s.state.isDocument!==false||s.state.isFolder!==false||s.state.isCardItem!==false||!s.cards.length)throw new Error('Move only question cards, not documents, folders or standalone answer items.');before.push(s);}
  const dest=await flashcards.read(args.parent_rem_id);if(dest.revision!==args.expected_parent_revision)throw new Error('Destination revision conflict. No move attempted.');
  if(dest.cards.length||dest.state.isCardItem!==false||dest.state.isListItem!==false||dest.card_structure.multiline||dest.back.trim())throw new Error('Choose a document or ordinary heading, not a question or answer, as destination.');
  if(dest.children.length>500)throw new Error('Destination is too large; select a smaller heading.');
  for(const child of dest.children)if((await call('state',child))?.isCardItem!==false)throw new Error('Destination has marked or unknown child answers.');
  // Any selected ancestor of a source or destination would make this ambiguous/cyclic.
  for(const s of [...before,dest]){
   let ancestor=s.parent_rem_id;const visited=new Set([s.rem_id]);
   if(s===dest&&selected.has(s.rem_id))throw new Error('Cannot move a card into itself.');
   while(ancestor){if(selected.has(ancestor))throw new Error('Cannot move into a source subtree or include ancestor/descendant sources.');if(visited.has(ancestor)||visited.size>100)throw new Error('Cyclic or excessive ancestry.');visited.add(ancestor);ancestor=(await get(ancestor)).parentRemId;}
  }
  const remaining=dest.children.filter(id=>!selected.has(id));let position=args.placement.position==='start'?0:remaining.length;
  if(['before','after'].includes(args.placement.position)){position=remaining.indexOf(args.placement.sibling_rem_id);if(position<0)throw new TypeError('Placement anchor must be a remaining direct sibling, not a moved card.');if(args.placement.position==='after')position++;}
  const expectedDest=[...remaining];expectedDest.splice(position,0,...ids);
  const parents=new Map();
  for(const s of before)if(s.parent_rem_id&&!parents.has(s.parent_rem_id))parents.set(s.parent_rem_id,await get(s.parent_rem_id));
  const subtrees=[];for(const s of before)subtrees.push(await descendants(s));
  const practiceIds=[...new Set([...before.flatMap(s=>s.cards.map(c=>c.card_id)),...subtrees.flatMap(nodes=>nodes.flatMap(node=>node.cards.map(c=>c.card_id)))])];
  if(typeof repository.cardHistorySnapshot!=='function')throw new Error('Read-only history verification is unavailable.');
  const history=repository.cardHistorySnapshot(practiceIds);
  if(history.length!==new Set(practiceIds).size)throw new Error('Card history is still syncing. Retry after a fresh read.');
  // Recheck all snapshots immediately before writing.
  for(const [i,card]of args.cards.entries()){const current=await flashcards.read(card.rem_id);if(current.revision!==card.expected_revision||!equal(subtrees[i],await descendants(current)))throw new Error('Source changed during preparation. No move attempted.');}
  if((await flashcards.read(dest.rem_id)).revision!==args.expected_parent_revision)throw new Error('Destination changed during preparation. No move attempted.');
  for(const [id,parent]of parents)if(!equal(parent,await get(id)))throw new Error('Source sibling order changed during preparation.');
  const record={status:'pending',rem_ids:ids};if(!journal.claim(key,digest,record))throw new Error('Move request claimed concurrently; retry the same request key.');
  try{
   const unchanged=before.every(s=>s.parent_rem_id===dest.rem_id)&&equal(dest.children,expectedDest);
   if(!unchanged){
    // Native moveRems interprets the position in the PRE-removal sibling list
    // and sorts multi-source selections itself. Single-source moves before a
    // fixed unselected anchor preserve the caller's batch order in all cases.
    const anchor=remaining[position]??null;
    const expectedParents=new Map([...parents].map(([id,p])=>[id,[...p.children]]));
    expectedParents.set(dest.rem_id,[...dest.children]);
    for(const id of ids){
     for(const [parentId,expected]of expectedParents)if(!equal((await get(parentId)).children,expected))throw new Error('Sibling order changed between moves.');
     const current=await get(id),targetChildren=expectedParents.get(dest.rem_id);
     const nativePosition=anchor===null?targetChildren.length:targetChildren.indexOf(anchor);
     if(nativePosition<0)throw new Error('Placement anchor disappeared.');
     const result=await run('remnote_rem',{operation:'move_many',remIds:[id],targetRemId:dest.rem_id,position:nativePosition});
     if(result?.applied!==true)throw new Error('SDK did not confirm the move.');
     if(current.parentRemId)expectedParents.set(current.parentRemId,expectedParents.get(current.parentRemId).filter(child=>child!==id));
     const next=expectedParents.get(dest.rem_id),at=anchor===null?next.length:next.indexOf(anchor);next.splice(at,0,id);
    }
   }
   const after=[];
   for(const [i,s]of before.entries()){const next=await flashcards.read(s.rem_id);if(next.parent_rem_id!==dest.rem_id||!equal(rootContent(s),rootContent(next))||!equal(subtrees[i],await descendants(next)))throw new Error('Card content, structure, identity or state changed during the move.');after.push(next);}
   if(!equal((await get(dest.rem_id)).children,expectedDest))throw new Error('Destination order did not match.');
   for(const [id,parent]of parents)if(id!==dest.rem_id&&!equal((await get(id)).children,parent.children.filter(id=>!selected.has(id))))throw new Error('Source sibling order did not match.');
   if(!equal(history,repository.cardHistorySnapshot(practiceIds)))throw new Error('Retained review history changed during the move.');
   const result={ok:true,verified:true,moved:!unchanged,replayed:false,verification_scope:'stored_content_identity_history_and_placement',parent_rem_id:dest.rem_id,cards:after.map((s,i)=>({rem_id:s.rem_id,previous_parent_rem_id:before[i].parent_rem_id,parent_rem_id:dest.rem_id,position:position+i,revision:s.revision,card_ids:s.cards.map(c=>c.card_id)})),note:'Existing Rems were relocated, not recreated. Destination deck or ancestor settings may affect practice queue membership; this is not a rendered practice check.'};
   record.status='complete';record.result=result;journal.save(key,record);return result;
  }catch(error){record.status='needs_inspection';try{journal.save(key,record);}catch{}return {ok:false,status:'needs_inspection',rem_ids:ids,parent_rem_id:dest.rem_id,message:`Move may already have happened and was not automatically reversed. Read source and destination before recovery. ${error.message}`};}
 }
 return {move(args){const result=tail.then(()=>execute(args));tail=result.catch(()=>{});return result;}};
}
