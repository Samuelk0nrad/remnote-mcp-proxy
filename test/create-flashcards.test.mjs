import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CreationJournal,createCardCreationService,validateCreation} from '../src/create-flashcards.mjs';
function fixture() {
 const rems=new Map(),states=new Map();let count=0,writes=0;
 function add(id,text,parent=null){rems.set(id,{remId:id,text:[text],children:[],parentRemId:parent});states.set(id,{isDocument:false,isFolder:false,isCardItem:false,isListItem:false,isCode:false,enablePractice:true,practiceDirection:'forward'});if(parent)rems.get(parent).children.push(id);return id;}
 add('parent','Topic');add('heading','Section','parent');add('sibling1','First','heading');add('sibling2','Last','heading');
 const faults={};
 const run=async(_,args)=>{
  const {operation,remId}=args;const rem=rems.get(remId),state=states.get(remId);
  if(operation==='image')return {richText:[{i:'i',url:args.url,...(args.width?{width:args.width}:{}),...(args.height?{height:args.height}:{})}]};
  if(operation==='get')return {rem:rem?structuredClone(rem):null};
  if(operation==='state')return structuredClone(state);
  if(operation==='cards'){
   const enabled=rem&&(rem.backText?.length||rem.children.some(id=>states.get(id)?.isCardItem));
   const types=enabled?(state.practiceDirection==='both'?['forward','backward']:[state.practiceDirection]):[];
   return {cards:types.map(type=>({cardId:`${remId}_${type}`,remId,type}))};
  }
  writes++;
  if(operation==='create_rem'){
   const id=add(`created${++count}`,'');
   if(faults.lostCreate){faults.lostCreate=false;throw new Error('Lost creation response');}
   return {rem:structuredClone(rems.get(id))};
  }
  if(faults.failWrite){faults.failWrite=false;throw new Error('Write failed');}
  if(operation==='set_text')rem.text=args.richText;
  else if(operation==='set_back_text')rem.backText=args.richText;
  else if(operation==='set_practice_direction')state.practiceDirection=args.value;
  else if(operation==='set_practice')state.enablePractice=args.value;
  else if(operation==='set_card_item')state.isCardItem=args.value;
  else if(operation==='set_parent'){
   if(rem.parentRemId){const prev=rems.get(rem.parentRemId);prev.children=prev.children.filter(id=>id!==remId);}
   rem.parentRemId=args.targetRemId;const parent=rems.get(args.targetRemId);
   parent.children.splice(args.position??parent.children.length,0,remId);
   if(faults.concurrent){faults.concurrent=false;add('concurrent','User edit',args.targetRemId);}
  }else throw new Error(operation);
  return {applied:true};
 };
 const journal=new CreationJournal(':memory:');
 return {rems,states,run,faults,journal,writes:()=>writes,service:createCardCreationService(run,()=>journal,{wait:async()=>{}})};
}
const basic={type:'basic',front:'Question → literal >> delimiter',back:'Answer ↔ literal ― text',direction:'both'};
const args=(more={})=>({parent_rem_id:'heading',request_id:'request-test-123',cards:[basic],...more});
test('literal sides and verified sibling placement inside exact heading',async t=>{
 const f=fixture();t.after(()=>f.journal.close());const r=await f.service.create(args({placement:{position:'before',sibling_rem_id:'sibling2'}}));
 assert.equal(r.verified,true);assert.deepEqual(f.rems.get('parent').children,['heading']);assert.deepEqual(f.rems.get('heading').children,['sibling1',r.cards[0].rem_id,'sibling2']);
 assert.equal(r.cards[0].front,basic.front);assert.equal(r.cards[0].back,basic.back);assert.equal(r.cards[0].card_ids.length,2);
});
test('multiline answers marked, source notes unmarked, inline back empty',async t=>{
 const f=fixture();t.after(()=>f.journal.close());const r=await f.service.create(args({cards:[{type:'multiline',front:'Steps?',back:{items:[{text:'One'},{text:'Two'}]},notes:['Source'],direction:'backward'}]}));
 assert.equal(r.verified,true);const card=r.cards[0];assert.equal(card.answer_item_rem_ids.length,2);assert.equal(card.note_rem_ids.length,1);
 for(const id of card.answer_item_rem_ids)assert.equal(f.states.get(id).isCardItem,true);
 assert.equal(f.states.get(card.note_rem_ids[0]).isCardItem,false);assert.equal(f.rems.get(card.rem_id).backText,undefined);
});
test('entire batch and placement validated before allocation',async t=>{
 const f=fixture();t.after(()=>f.journal.close());
 for(const input of [args({cards:[basic,{...basic,type:'cloze'}]}),args({placement:{position:'before',sibling_rem_id:'parent'}}),args({cards:[{type:'multiline',front:'Q',back:'Wrong shape'}]}),args({placement:{position:'start',sibling_rem_id:'sibling1'}})])await assert.rejects(()=>f.service.create(input));
 assert.equal(f.writes(),0);f.rems.get('heading').backText=['Existing answer'];await assert.rejects(()=>f.service.create(args()),/Destination is a flashcard/);assert.equal(f.writes(),0);
});
test('rejects multiline destinations and unknown nested fields',async t=>{
 const f=fixture();t.after(()=>f.journal.close());f.states.get('sibling1').isCardItem=true;await assert.rejects(()=>f.service.create(args()));assert.equal(f.writes(),0);
 assert.throws(()=>validateCreation(args({cards:[{type:'multiline',front:'Q',back:{items:[{text:'A',children:[]}]}}]})),TypeError);
});
test('concurrent identical retries execute once; changed payload is rejected',async t=>{
 const f=fixture();t.after(()=>f.journal.close());const [a,b]=await Promise.all([f.service.create(args()),f.service.create(args())]);
 assert.equal(a.verified,true);assert.equal(b.replayed,true);assert.equal(a.cards[0].rem_id,b.cards[0].rem_id);
 const writes=f.writes();await assert.rejects(()=>f.service.create(args({cards:[{...basic,back:'Changed'}]})),/different arguments/);assert.equal(f.writes(),writes);
});
test('partial write failure retains IDs and blocks all retries',async t=>{
 const f=fixture();t.after(()=>f.journal.close());f.faults.failWrite=true;const a=await f.service.create(args());assert.equal(a.status,'needs_inspection');assert.equal(a.created_rem_ids.length,1);
 const writes=f.writes();const b=await f.service.create(args());assert.equal(b.status,'needs_inspection');assert.equal(f.writes(),writes);
});
test('lost allocation response stays uncertain and is never repeated',async t=>{
 const f=fixture();t.after(()=>f.journal.close());f.faults.lostCreate=true;const a=await f.service.create(args());assert.equal(a.uncertain_creation,true);assert.deepEqual(a.created_rem_ids,[]);
 const writes=f.writes();assert.equal((await f.service.create(args())).uncertain_creation,true);assert.equal(f.writes(),writes);
});
test('concurrent placement changes do not overwrite user order',async t=>{
 const f=fixture();t.after(()=>f.journal.close());f.faults.concurrent=true;const a=await f.service.create(args({cards:[basic,basic]}));assert.equal(a.status,'needs_inspection');assert.ok(f.rems.get('heading').children.includes('concurrent'));
 const writes=f.writes();await f.service.create(args({cards:[basic,basic]}));assert.equal(f.writes(),writes);
});
test('journal survives restart and stores no note text',async t=>{
 const f=fixture();t.after(()=>f.journal.close());const dir=mkdtempSync(path.join(os.tmpdir(),'remnote-create-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const filename=path.join(dir,'creation.sqlite');let journal=new CreationJournal(filename);const first=await createCardCreationService(f.run,()=>journal).create(args());journal.close();
 const writes=f.writes();journal=new CreationJournal(filename);
 try {const second=await createCardCreationService(f.run,()=>journal).create(args());assert.equal(second.replayed,true);assert.equal(second.cards[0].rem_id,first.cards[0].rem_id);assert.equal(f.writes(),writes);
  const stored=journal.db.prepare('SELECT record FROM requests').get().record;assert.ok(!stored.includes(basic.front));assert.ok(!stored.includes(basic.back));
 }finally{journal.close();}
});

test('creates hosted and reused images on basic sides and multiline answers with retry safety',async()=>{
 const f=fixture();try{
 const images=[{url:'https://example.com/a.png',width:32,height:32}];
 const r=await f.service.create(args({cards:[{...basic,front_images:images,back_images:images},{type:'multiline',front:'Steps',back:{items:[{text:'One',images}]}}]}));assert.equal(r.verified,true,r.message);
 assert.equal(f.rems.get(r.cards[0].rem_id).text[1].url,images[0].url);assert.equal(f.rems.get(r.cards[0].rem_id).backText[1].i,'i');assert.equal(f.rems.get(r.cards[1].answer_item_rem_ids[0]).text[1].i,'i');
 const {imageEntries}=await import('../src/images.mjs');const source=r.cards[0].rem_id,image_id=imageEntries(f.rems.get(source).text,source,'front')[0].image_id;
 const request=args({request_id:'copy-image-123',cards:[{...basic,back_images:[{source_rem_id:source,image_id}]}]});const copy=await f.service.create(request);assert.equal(copy.verified,true,copy.message);const writes=f.writes();assert.equal((await f.service.create(request)).replayed,true);assert.equal(f.writes(),writes);
 }finally{f.journal.close();}
});
test('invalid image inputs fail before allocating any Rems',async()=>{const f=fixture();try{for(const images of [[{url:'http://example.com/a.png'}],[{url:'https://127.0.0.1/a.png'}],[{url:'file:///etc/passwd'}],[{url:'https://example.com/a.png',width:-1}]])await assert.rejects(()=>f.service.create(args({cards:[{...basic,front_images:images}]})));assert.equal(f.writes(),0);}finally{f.journal.close();}});
