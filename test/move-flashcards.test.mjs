import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CreationJournal} from '../src/create-flashcards.mjs';
import {createCardMoveService} from '../src/move-flashcards.mjs';
function fixture(){
 const nodes=new Map();let writes=0;const faults={};
 const add=(id,parent,card=false)=>{const s={rem_id:id,parent_rem_id:parent,front_rich_text:[id],back_rich_text:card?['Answer']:[],has_back:card,children:[],state:{isDocument:!card,isFolder:false,isCardItem:false,isListItem:false,enablePractice:true,practiceDirection:'forward'},cards:card?[{card_id:`card_${id}`,rem_id:id,type:'forward'}]:[],card_structure:{multiline:false},answer_items:[],edit_later:{queued:false},back:card?'Answer':''};nodes.set(id,s);if(parent)nodes.get(parent).children.push(id);};
 add('source',null);add('target',null);add('first','source',true);add('second','source',true);add('anchor','target',true);
 const read=async id=>{const s=nodes.get(id);if(!s)throw new Error('Missing');return {...structuredClone(s),revision:createHash('sha256').update(JSON.stringify(s)).digest('hex')};};
 const history=ids=>ids.map(_id=>({_id,history:faults.historyChanged?'[1]':'[]'}));
 const run=async(_,args)=>{
  if(args.operation==='get'){const s=nodes.get(args.remId);return {rem:{remId:s.rem_id,parentRemId:s.parent_rem_id,text:s.front_rich_text,backText:s.back_rich_text,children:[...s.children]}};}
  if(args.operation==='state')return structuredClone(nodes.get(args.remId).state);
  if(args.operation==='move_many'){
   const oldChildren=[...nodes.get(args.targetRemId).children];const actualPosition=args.position-oldChildren.slice(0,args.position).filter(id=>args.remIds.includes(id)).length;
   writes++;for(const id of args.remIds){const n=nodes.get(id);if(n.parent_rem_id){const p=nodes.get(n.parent_rem_id);p.children=p.children.filter(x=>x!==id);}n.parent_rem_id=args.targetRemId;}
   nodes.get(args.targetRemId).children.splice(actualPosition,0,...args.remIds);
   if(faults.modify)nodes.get(args.remIds[0]).front_rich_text=['Concurrent user edit'];
   if(faults.history)faults.historyChanged=true;
   if(faults.lost)throw new Error('Lost reply');return {applied:true};
  }throw new Error(args.operation);
 };
 const journal=new CreationJournal(':memory:');const service=createCardMoveService(run,{read},{cardHistorySnapshot:history},()=>journal);
 const args=async(ids=['first','second'],parent='target',placement={position:'start'})=>({cards:await Promise.all(ids.map(async rem_id=>({rem_id,expected_revision:(await read(rem_id)).revision}))),parent_rem_id:parent,expected_parent_revision:(await read(parent)).revision,placement,request_id:'move-request-123'});
 return {nodes,read,journal,service,args,faults,writes:()=>writes};
}
test('batch move preserves source order/content/IDs and replays without writing',async t=>{const f=fixture();t.after(()=>f.journal.close());const args=await f.args();const r=await f.service.move(args);assert.equal(r.verified,true);assert.deepEqual(f.nodes.get('target').children,['first','second','anchor']);assert.deepEqual(f.nodes.get('source').children,[]);assert.equal(r.cards[0].card_ids[0],'card_first');const retry=await f.service.move(args);assert.equal(retry.replayed,true);assert.equal(f.writes(),2);});
test('same-parent reorder uses remaining siblings; already placed is a no-op',async t=>{const f=fixture();t.after(()=>f.journal.close());const r=await f.service.move(await f.args(['first'],'source',{position:'after',sibling_rem_id:'second'}));assert.equal(r.verified,true);assert.deepEqual(f.nodes.get('source').children,['second','first']);const args=await f.args(['first'],'source',{position:'end'});args.request_id='another-request';const noop=await f.service.move(args);assert.equal(noop.moved,false);assert.equal(f.writes(),1);});
test('stale source and destination revisions refuse before moving',async t=>{const f=fixture();t.after(()=>f.journal.close());const a=await f.args();f.nodes.get('first').front_rich_text=['New'];await assert.rejects(()=>f.service.move(a),/Source revision/);const b=await f.args();f.nodes.get('target').front_rich_text=['New heading'];await assert.rejects(()=>f.service.move(b),/Destination revision/);assert.equal(f.writes(),0);});
test('rejects question destinations, documents, duplicate IDs and moving anchors',async t=>{const f=fixture();t.after(()=>f.journal.close());for(const args of [await f.args(['first'],'anchor'),await f.args(['source']),await f.args(['first','first']),await f.args(['first'],'source',{position:'before',sibling_rem_id:'first'})])await assert.rejects(()=>f.service.move(args));assert.equal(f.writes(),0);});
test('uncertain move result is retained without replay or automatic reversal',async t=>{const f=fixture();t.after(()=>f.journal.close());f.faults.lost=true;const args=await f.args();const first=await f.service.move(args);assert.equal(first.status,'needs_inspection');const second=await f.service.move(args);assert.equal(second.status,'needs_inspection');assert.equal(f.writes(),1);assert.deepEqual(f.nodes.get('target').children,['first','anchor']);});
test('concurrent content or history changes prevent a false success',async t=>{for(const fault of ['modify','history']){const f=fixture();t.after(()=>f.journal.close());f.faults[fault]=true;const r=await f.service.move(await f.args());assert.equal(r.status,'needs_inspection');assert.equal(f.writes(),2);}});
test('a request key cannot be reused for a different move',async t=>{const f=fixture();t.after(()=>f.journal.close());const a=await f.args();await f.service.move(a);await assert.rejects(()=>f.service.move({...a,placement:{position:'end'}}),/different move/);assert.equal(f.writes(),2);});

test('reversed input order is honored for siblings',async t=>{const f=fixture();t.after(()=>f.journal.close());const r=await f.service.move(await f.args(['second','first']));assert.equal(r.verified,true);assert.deepEqual(f.nodes.get('target').children,['second','first','anchor']);});
test('cycles and ancestor/descendant selections are rejected before writes',async t=>{
 const f=fixture();t.after(()=>f.journal.close());
 f.nodes.set('innerHeading',{...structuredClone(f.nodes.get('target')),rem_id:'innerHeading',parent_rem_id:'first',children:[]});f.nodes.get('first').children.push('innerHeading');
 await assert.rejects(async()=>f.service.move(await f.args(['first'],'innerHeading')),/subtree/);
 f.nodes.get('second').parent_rem_id='first';f.nodes.get('first').children.push('second');f.nodes.get('source').children=['first'];
 await assert.rejects(async()=>f.service.move(await f.args()),/ancestor\/descendant/);assert.equal(f.writes(),0);
});
