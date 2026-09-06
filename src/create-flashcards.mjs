import {contentSchema,validateContent,buildContent,countSpans} from './formatting.mjs';
import {imageArraySchema,validateImageArray,appendImages,isImage} from './images.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { strictArgs } from './flashcards.mjs';

const idPattern = '^[A-Za-z0-9_-]{3,128}$';
const idSchema = { type:'string', pattern:idPattern, description:'Exact Rem ID returned by a reader, never a practice Card ID.' };
const textSchema = contentSchema({ type:'string', minLength:1, maxLength:50000, description:'Literal text. Arrows and Markdown are not parsed. Or use {spans:[{text,formats}]} for explicit formatting.' });
const directionSchema = { type:'string', enum:['forward','backward','both'], default:'forward' };
const itemSchema = { type:'object', additionalProperties:false, properties:{text:textSchema,images:imageArraySchema}, required:['text'] };
const cardSchema = type => ({ type:'object', additionalProperties:false, properties:{
  type:{type:'string',const:type}, direction:directionSchema, front:textSchema, front_images:imageArraySchema, ...(type==='basic'?{back_images:imageArraySchema}:{}),
  back:type==='basic' ? textSchema : {type:'object',additionalProperties:false,properties:{items:{type:'array',minItems:1,maxItems:20,items:itemSchema}},required:['items']},
  notes:{type:'array',maxItems:10,items:textSchema,description:'Optional unmarked literal or formatted source/context notes; never answer items.'},
},required:['type','front','back'] });
export const CREATE_FLASHCARD_TOOL = {
  name:'create_flashcards',
  description:'Create basic or multiline flashcards inside an exact document or heading. Read the topic outline first and choose parent_rem_id; do not default to the document root when a section is intended. Supports start/end or before/after a direct sibling. front_images/back_images (basic) and multiline item.images append hosted or reused images after text. No file upload. Text fields accept literal strings or {spans:[{text,formats}]} with bold/italic/underline, including multiline item.text and notes. Separate front/back fields prevent separator parsing; multiline back.items become marked child answers. Both types support forward/backward/both. Verifies stored sides, child answers, direction, generated card IDs and placement. Supply a unique request_id and reuse it unchanged on retries. A completed retry returns its original receipt, not a fresh read; an interrupted request is blocked for inspection, never blindly recreated. Other card types are rejected.',
  inputSchema:{type:'object',additionalProperties:false,properties:{
    parent_rem_id:idSchema,
    placement:{type:'object',additionalProperties:false,properties:{position:{type:'string',enum:['start','end','before','after']},sibling_rem_id:idSchema},required:['position'],description:'Defaults to end. before/after require sibling_rem_id; start/end forbid it.'},
    cards:{type:'array',minItems:1,maxItems:10,items:{oneOf:[cardSchema('basic'),cardSchema('multiline')]}},
    request_id:{type:'string',minLength:8,maxLength:128,pattern:'^[A-Za-z0-9_-]+$',description:'New UUID or unique request key. Reuse exactly the same key and arguments after timeouts; never change it to bypass an uncertain outcome.'},
  },required:['parent_rem_id','cards','request_id']},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
};
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
const json = v => JSON.stringify(canonical(v));
const equal = (a,b) => json(a)===json(b);
const hash = v => createHash('sha256').update(json(v)).digest('hex');
function validId(v) { if(typeof v!=='string'||!new RegExp(idPattern).test(v))throw new TypeError('Use an exact Rem ID from a reader.'); }
function validText(v) { validateContent(v); }
export function validateCreation(args) {
  strictArgs(args,['parent_rem_id','placement','cards','request_id'],['parent_rem_id','cards','request_id']);validId(args.parent_rem_id);
  if(typeof args.request_id!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(args.request_id))throw new TypeError('request_id must be a unique 8-128 character key.');
  const placement=args.placement??{position:'end'};
  strictArgs(placement,['position','sibling_rem_id'],['position']);
  if(!['start','end','before','after'].includes(placement.position))throw new TypeError('Invalid placement position.');
  if(['before','after'].includes(placement.position))validId(placement.sibling_rem_id);
  else if(Object.hasOwn(placement,'sibling_rem_id'))throw new TypeError('Only before/after accept sibling_rem_id.');
  if(!Array.isArray(args.cards)||args.cards.length<1||args.cards.length>10)throw new TypeError('Supply 1-10 cards.');
  let remCount=0,imageCount=0;
  const cards=args.cards.map(card=>{
    strictArgs(card,['type','direction','front','back','notes','front_images','back_images'],['type','front','back']);
    if(!['basic','multiline'].includes(card.type))throw new TypeError('Supported types: basic, multiline.');
    const direction=card.direction??'forward';
    if(!['forward','backward','both'].includes(direction))throw new TypeError('Invalid card direction.');
    validText(card.front);validateImageArray(card.front_images);validateImageArray(card.back_images);if(card.type==='multiline'&&card.back_images!==undefined)throw new TypeError('Multiline images belong to back.items[].images.');
    if(card.type==='basic')validText(card.back);
    else {
      strictArgs(card.back,['items'],['items']);
      if(!Array.isArray(card.back.items)||card.back.items.length<1||card.back.items.length>20)throw new TypeError('Multiline back.items requires 1-20 answer items.');
      for(const item of card.back.items){strictArgs(item,['text','images'],['text']);validText(item.text);validateImageArray(item.images);}
    }
    imageCount+=(card.front_images?.length??0)+(card.back_images?.length??0)+(card.type==='multiline'?card.back.items.reduce((n,item)=>n+(item.images?.length??0),0):0);
    const notes=card.notes??[];
    if(!Array.isArray(notes)||notes.length>10)throw new TypeError('At most 10 context notes per card.');
    notes.forEach(validText);remCount+=1+notes.length+(card.type==='multiline'?card.back.items.length:0);
    return {...card,direction,notes};
  });
  if(countSpans(cards)>200)throw new TypeError('At most 200 formatted spans per batch.');
  if(imageCount>40)throw new TypeError('At most 40 images per creation batch.');
  if(remCount>60||json(cards).length>200000)throw new TypeError('Batch exceeds 60 Rems or 200000 serialized characters; split it into smaller requests.');
  return {parent_rem_id:args.parent_rem_id,placement,cards,request_id:args.request_id};
}

// This is a separate proxy-owned database, never the RemNote database. No note text
// is stored: only hashes, state, created IDs and verification receipts.
export class CreationJournal {
  constructor(filename) {
    if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(filename);
    if(filename!==':memory:')chmodSync(filename,0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, digest TEXT NOT NULL, record TEXT NOT NULL)');
  }
  get(key) { const row=this.db.prepare('SELECT digest,record FROM requests WHERE key=?').get(key);return row?{digest:row.digest,...JSON.parse(row.record)}:null; }
  claim(key,digest,record) { return this.db.prepare('INSERT OR IGNORE INTO requests VALUES (?,?,?)').run(key,digest,JSON.stringify(record)).changes===1; }
  save(key,record) { if(this.db.prepare('UPDATE requests SET record=? WHERE key=?').run(JSON.stringify(record),key).changes!==1)throw new Error('Creation journal update failed.'); }
  close(){this.db.close();}
}

export function createCardCreationService(run,getJournal,{wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  // Serialize batches through this handler. SQLite's claim also prevents duplicate
  // execution across handlers/processes sharing the same journal.
  let tail=Promise.resolve();
  const call=(operation,remId,more={})=>run('remnote_rem',{operation,remId,...more});
  const get=async id=>{
    const rem=(await call('get',id))?.rem;
    if(!rem||rem.remId!==id||!Array.isArray(rem.text)||!Array.isArray(rem.children))throw new Error('Incomplete Rem metadata.');
    return rem;
  };
  const write=async(operation,id,more)=>{if((await call(operation,id,more))?.applied!==true)throw new Error('SDK did not confirm the write.');};
  async function destination(id) {
    const rem=await get(id);
    if(rem.children.length>500)throw new Error('Destination has over 500 direct children. Choose a smaller section.');
    const state=await call('state',id),cards=await call('cards',id);
    if(typeof state?.isDocument!=='boolean'||typeof state?.isFolder!=='boolean'||state.isCardItem!==false||state.isListItem!==false||state.isCode!==false||!Array.isArray(cards?.cards))throw new Error('Destination type could not be verified as a document or ordinary heading.');
    if((rem.backText?.length??0)>0||cards.cards.length)throw new Error('Destination is a flashcard. Choose its enclosing heading, not a question or answer.');
    // Disabled multiline parents may have no cards or inline back.
    for(const childId of rem.children){const state=await call('state',childId);if(typeof state?.isCardItem!=='boolean'||state.isCardItem)throw new Error('Destination has marked child answers or unknown child state; choose an ordinary heading.');}
    if(!equal(rem,await get(id)))throw new Error('Destination changed while inspecting it; read the outline again.');
    return rem;
  }
  async function execute(raw) {
    const args=validateCreation(raw),key=hash(args.request_id),digest=hash(args),journal=getJournal();
    const previous=journal.get(key);
    if(previous){
      if(previous.digest!==digest)throw new TypeError('request_id was already used with different arguments.');
      if(previous.status==='complete')return {...previous.result,replayed:true,verification_scope:'original_creation_receipt'};
      return {ok:false,status:'needs_inspection',request_id:args.request_id,created_rem_ids:previous.created_rem_ids,uncertain_creation:previous.uncertain_creation===true,message:'This request was interrupted or failed. Inspect the recorded Rems before any repair. Do not submit a new request_id to repeat this batch.'};
    }
    const parent=await destination(args.parent_rem_id);
    if(parent.children.length>500)throw new Error('Destination has over 500 direct children. Choose a smaller section.');
    let index=args.placement.position==='start'?0:parent.children.length;
    if(['before','after'].includes(args.placement.position)){
      const sibling=await get(args.placement.sibling_rem_id);
      index=parent.children.indexOf(sibling.remId);
      if(index<0||sibling.parentRemId!==parent.remId)throw new TypeError('Placement sibling must be a direct child of parent_rem_id.');
      if(args.placement.position==='after')index++;
    }
    const prepared=[];for(const card of args.cards){prepared.push({front:await appendImages(run,card.front,card.front_images),back:card.type==='basic'?await appendImages(run,card.back,card.back_images):[],answers:card.type==='multiline'?await Promise.all(card.back.items.map(item=>appendImages(run,item.text,item.images))):[],notes:await Promise.all(card.notes.map(text=>buildContent(run,text)))});}
    if(json(prepared).length>200000)throw new TypeError('Prepared rich content exceeds 200000 characters; split the batch.');
    const record={status:'pending',created_rem_ids:[],uncertain_creation:false};
    if(!journal.claim(key,digest,record))throw new Error('Request was claimed concurrently; retry the same request_id.');
    const roots=[];
    async function create(richText) {
      // Persist uncertainty BEFORE asking the SDK to allocate an ID. A lost reply
      // cannot safely be retried, even when the created ID is unavailable.
      record.uncertain_creation=true;journal.save(key,record);
      const rem=(await call('create_rem'))?.rem;validId(rem?.remId);
      record.created_rem_ids.push(rem.remId);record.uncertain_creation=false;journal.save(key,record);
      await write('set_text',rem.remId,{richText});
      return rem.remId;
    }
    async function verifyCard(root,card) {
      const ready=prepared[roots.indexOf(root)];
      const rem=await get(root.id),state=await call('state',root.id);
      if(!equal(rem.text,ready.front)||!equal(rem.children,root.children)||rem.parentRemId!==parent.remId||state.practiceDirection!==card.direction||state.enablePractice!==true||state.isCardItem!==false)throw new Error('Saved card structure or direction did not match.');
      if(card.type==='basic'?!equal(rem.backText,ready.back):(rem.backText?.length??0)!==0)throw new Error('Saved back did not match the selected card type.');
      const answers=ready.answers;
      for(const [i,id]of root.children.entries()){
        const child=await get(id),childState=await call('state',id);
        if(child.parentRemId!==root.id||!equal(child.text,(answers.concat(ready.notes))[i])||child.children.length||(child.backText?.length??0)>0||childState.isCardItem!==(i<answers.length)||childState.isListItem!==false)throw new Error('Saved answer/context item did not match.');
      }
      const expected=card.direction==='both'?['backward','forward']:[card.direction];
      let cards;
      for(let i=0;i<20;i++){
        cards=(await call('cards',root.id))?.cards;
        if(Array.isArray(cards)&&equal(cards.map(c=>c.type).sort(),expected)&&cards.every(c=>c.remId===root.id&&typeof c.cardId==='string'))break;
        if(i===19)throw new Error('Generated practice cards did not match the requested direction; inspect before retrying.');
        await wait(100);
      }
      return {rem_id:root.id,type:card.type,direction:card.direction,parent_rem_id:parent.remId,position:index+roots.indexOf(root),answer_item_rem_ids:root.children.slice(0,answers.length),note_rem_ids:root.children.slice(answers.length),image_count:[...ready.front,...ready.back,...ready.answers.flat()].filter(isImage).length,card_ids:cards.map(c=>c.cardId)};
    }
    try {
      for(const [cardIndex,card] of args.cards.entries()){
        const ready=prepared[cardIndex];
        const root={id:await create(ready.front),children:[]};roots.push(root);
        if(card.type==='basic')await write('set_back_text',root.id,{richText:ready.back});
        const answers=ready.answers;
        for(const [i,text]of answers.concat(ready.notes).entries()){
          const child=await create(text);root.children.push(child);
          await write('set_parent',child,{targetRemId:root.id,position:i});
          if(i<answers.length)await write('set_card_item',child,{value:true});
        }
        await write('set_practice_direction',root.id,{value:card.direction});
        await write('set_practice',root.id,{value:true});
      }
      // Existing content remains untouched. Refuse stale placement before inserting.
      if(!equal(parent,await get(parent.remId)))throw new Error('Destination changed during creation; newly created Rems need placement inspection.');
      const expectedChildren=[...parent.children];
      for(const [i,root]of roots.entries()){
        if(!equal((await get(parent.remId)).children,expectedChildren))throw new Error('Concurrent destination change; placement stopped.');
        await write('set_parent',root.id,{targetRemId:parent.remId,position:index+i});
        expectedChildren.splice(index+i,0,root.id);
      }
      const receipts=[];
      for(const [i,root]of roots.entries())receipts.push(await verifyCard(root,args.cards[i]));
      if(!equal((await get(parent.remId)).children,expectedChildren))throw new Error('Final placement verification failed.');
      const result={ok:true,verified:true,verification_scope:'stored_structure_and_placement',rendering_verified:false,replayed:false,request_id:args.request_id,parent_rem_id:parent.remId,cards:receipts,created_rem_ids:record.created_rem_ids};
      record.status='complete';record.result=result;journal.save(key,record);
      return {...result,cards:receipts.map((receipt,i)=>({...receipt,front:args.cards[i].front,back:args.cards[i].back,notes:args.cards[i].notes}))};
    }catch(error){
      record.status='needs_inspection';
      try{journal.save(key,record);}catch{/* the durable pending claim still blocks retries */}
      return {ok:false,status:'needs_inspection',request_id:args.request_id,created_rem_ids:record.created_rem_ids,uncertain_creation:record.uncertain_creation,message:`${error.message} Partial creation is possible. Read these Rems; do not repeat this batch with a new request_id. No existing notes were intentionally edited or deleted.`};
    }
  }
  return {create(args){const result=tail.then(()=>execute(args));tail=result.catch(()=>{});return result;}};
}
