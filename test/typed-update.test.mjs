import test from 'node:test';
import assert from 'node:assert/strict';
import {CreationJournal} from '../src/create-flashcards.mjs';
import {createFlashcardService} from '../src/flashcards.mjs';
function fixture(multiline=false){
 const rems=new Map(),states=new Map(),cards=new Map();const faults={};let count=0,writes=0;
 function add(id,text,parent=null,answer=false,back){const rem={remId:id,text:[text],parentRemId:parent,children:[],...(back===undefined?{}:{backText:[back]})};rems.set(id,rem);states.set(id,{isDocument:false,isFolder:false,isCardItem:answer,isListItem:false,isCode:false,enablePractice:true,practiceDirection:'forward'});if(parent)rems.get(parent).children.push(id);return rem;}
 add('question','Question',null,false,multiline?undefined:'Answer');if(multiline){add('answerOne','One','question',true);add('answerTwo','Two','question',true);}add('contextNote','Source','question');
 function card(remId,type){const id=`${remId}_${type}`;if(!cards.has(id))cards.set(id,{cardId:id,remId,type});return cards.get(id);}
 card('question','forward');
 const repository={get:()=>null,cardIds:id=>[...cards.values()].filter(c=>c.remId===id).map(c=>c.cardId),cardHistorySnapshot:ids=>ids.sort().map(_id=>({_id,history:faults.emptyHistory?[]:[{score:faults.historyChanged?'again':'good',date:123}]})),cardScheduleSnapshot:ids=>ids.sort().map(_id=>({_id,schedule:{n:faults.scheduleChanged?0:123456,t:0}}))};
 const run=async(name,args)=>{
  const {operation,remId}=args;const rem=rems.get(remId),state=states.get(remId);
  if(name==='remnote_card')return {cards:args.cardIds.map(id=>structuredClone(cards.get(id)))};
  if(operation==='get')return {rem:structuredClone(rem??null)};
  if(operation==='state')return structuredClone(state);
  if(operation==='has_powerup')return {hasPowerup:args.powerupCode==='w'&&state.isCardItem};
  if(operation==='find_many'){const found=args.remIds.filter(id=>rems.has(id)).map(id=>structuredClone(rems.get(id)));return {rems:found,total:found.length};}
  if(operation==='cards')return {cards:structuredClone([...cards.values()].filter(c=>c.remId===remId))};
  writes++;
  if(operation==='create_rem'){const made=add(`newItem${++count}`,'');if(faults.lostCreate)throw new Error('Lost creation response');return {rem:structuredClone(made)};}
  if(faults.failWrite)throw new Error('Failed write');
  if(operation==='set_text')rem.text=structuredClone(args.richText);
  else if(operation==='set_back_text')rem.backText=structuredClone(args.richText);
  else if(operation==='set_card_item')state.isCardItem=args.value;
  else if(operation==='set_parent'){rem.parentRemId=args.targetRemId;rems.get(args.targetRemId).children.push(remId);}
  else if(operation==='move_many'){const id=args.remIds[0],parent=rems.get(args.targetRemId);const index=args.position-(parent.children.slice(0,args.position).includes(id)?1:0);parent.children=parent.children.filter(x=>x!==id);parent.children.splice(index,0,id);}
  else if(operation==='set_practice_direction'){state.practiceDirection=args.value;for(const type of args.value==='both'?['forward','backward']:[args.value])card(remId,type);if(faults.removeDirection&&args.value!=='both')for(const [id,c]of cards)if(c.remId===remId&&c.type!==args.value)cards.delete(id);}
  else if(operation==='remove'){if(!faults.fakeRemove)rems.delete(remId);rems.get(rem.parentRemId).children=rems.get(rem.parentRemId).children.filter(id=>id!==remId);}
  else throw new Error(operation);
  if(faults.changeHistory)faults.historyChanged=true;if(faults.changeSchedule)faults.scheduleChanged=true;
  if(faults.changeContext&&remId==='question')rems.get('contextNote').text=['Concurrent context'];
  return {applied:true};
 };
 const journal=new CreationJournal(':memory:');const service=createFlashcardService(run,repository,'secret',{getJournal:()=>journal});
 const args=async more=>({rem_id:'question',expected_revision:(await service.read('question')).revision,type:multiline?'multiline':'basic',request_id:'typed-request-123',...more});
 return {rems,states,cards,faults,repository,journal,service,args,writes:()=>writes,add};
}
function setup(t,multi=false){const f=fixture(multi);t.after(()=>f.journal.close());return f;}
const update=(f,args)=>f.service.update(args,'flashcard');
test('typed basic preserves sides, schedule, history, notes and identity; retries do not write',async t=>{const f=setup(t);const args=await f.args({back:'Updated → literal ― answer'}),before=await f.service.read('question');const r=await update(f,args);assert.equal(r.verified,true);assert.equal(r.card.front,before.front);assert.deepEqual(r.card.cards,before.cards);assert.deepEqual(r.card.children,before.children);assert.equal(r.spaced_repetition.schedule_verified,true);const writes=f.writes();assert.equal((await update(f,args)).replayed,true);assert.equal(f.writes(),writes);await assert.rejects(()=>update(f,{...args,back:'Different'}),/different update arguments/);});
test('multiline replaces answers in place and preserves item IDs and context',async t=>{const f=setup(t,true);const r=await update(f,await f.args({front:'New question',back:{items:[{text:'First'},{text:'Second'}]}}));assert.equal(r.verified,true);assert.deepEqual(r.card.answer_items.map(c=>c.rem_id),['answerOne','answerTwo']);assert.equal(r.card.back,'');assert.deepEqual(f.rems.get('contextNote').text,['Source']);});
test('explicit item IDs reorder existing answers and add a marked answer without duplicates',async t=>{const f=setup(t,true);const args=await f.args({back:{items:[{rem_id:'answerTwo',text:'Second'},{text:'New'},{rem_id:'answerOne',text:'First'}]},notes:['Updated source','Additional note']});const r=await update(f,args);assert.equal(r.verified,true);assert.deepEqual(r.card.answer_items.map(c=>c.front_rich_text[0]),['Second','New','First']);assert.equal(r.created_rem_ids.length,2);assert.equal(f.states.get(r.created_rem_ids[0]).isCardItem,true);assert.equal(f.states.get(r.created_rem_ids[1]).isCardItem,false);const writes=f.writes();await update(f,args);assert.equal(f.writes(),writes);});
test('explicit leaf removal verifies absence; shortening never silently deletes',async t=>{const f=setup(t,true);await assert.rejects(async()=>update(f,await f.args({back:{items:[{text:'One'}]}})),/Every surviving/);assert.equal(f.writes(),0);
 const r=await update(f,await f.args({back:{items:[{rem_id:'answerOne',text:'One'}]},delete_item_rem_ids:['answerTwo'],notes:[],delete_note_rem_ids:['contextNote']}));assert.equal(r.verified,true);assert.equal(f.rems.has('answerTwo'),false);assert.equal(f.rems.has('contextNote'),false);});
test('type conversion, nested replacement and unknown fields fail before writes',async t=>{const f=setup(t,true);await assert.rejects(async()=>update(f,await f.args({type:'basic',front:'X'})),/Type conversion/);f.add('nested','Nested','answerOne');await assert.rejects(async()=>update(f,await f.args({back:{items:[{text:'One'},{text:'Two'}]}})),/Nested/);await assert.rejects(async()=>update(f,await f.args({front:'X',surprise:1})),/Expected fields/);assert.equal(f.writes(),0);});
test('rich answer formatting must be preserved',async t=>{const f=setup(t,true);f.rems.get('answerOne').text=[{text:'Bold',b:true}];await assert.rejects(async()=>update(f,await f.args({back:{items:[{text:'Flatten'},{text:'Two'}]}})),/structured rich text/);const r=await update(f,await f.args({back:{items:[{rich_text:[{text:'New bold',b:true}]},{text:'Two'}]}}));assert.equal(r.verified,true);assert.deepEqual(f.rems.get('answerOne').text,[{text:'New bold',b:true}]);});
test('context edits invalidate parent revision and independent child cards cannot be edited via notes',async t=>{const f=setup(t);const args=await f.args({notes:['Replace']});f.rems.get('contextNote').text=['User changed'];await assert.rejects(()=>update(f,args),/Revision conflict/);f.rems.get('contextNote').backText=['Independent answer'];await assert.rejects(async()=>update(f,await f.args({notes:['Replace']})),/Independent child cards/);assert.equal(f.writes(),0);});
test('changed history or schedule yields inspection, never verified success',async t=>{for(const key of ['changeHistory','changeSchedule']){const f=setup(t);f.faults[key]=true;const args=await f.args({front:'Changed'}),r=await update(f,args);assert.equal(r.status,'needs_inspection');assert.match(r.message,key==='changeHistory'?/history/:/schedule/);const writes=f.writes();await update(f,args);assert.equal(f.writes(),writes);}});
test('unexpected context edit and fake removal prevent false success',async t=>{for(const key of ['changeContext','fakeRemove']){const f=setup(t);f.faults[key]=true;const r=await update(f,await f.args(key==='changeContext'?{front:'Changed'}:{notes:[],delete_note_rem_ids:['contextNote']}));assert.equal(r.status,'needs_inspection');}});
test('lost allocation is recorded and cannot be replayed',async t=>{const f=setup(t,true);f.faults.lostCreate=true;const args=await f.args({back:{items:[{text:'One'},{text:'Two'},{text:'Three'}]}});const r=await update(f,args);assert.equal(r.status,'needs_inspection');assert.equal(r.uncertain_creation,true);const writes=f.writes();await update(f,args);assert.equal(f.writes(),writes);});
test('direction change preserves old identities and reports newly generated directions',async t=>{const f=setup(t);const r=await update(f,await f.args({direction:'both'}));assert.equal(r.verified,true);assert.equal(r.card.practice_direction,'both');assert.deepEqual(r.spaced_repetition.new_practice_card_ids,['question_backward']);assert.equal(r.spaced_repetition.active_queue_verified,false);});
test('omitted direction and no change preserve disabled direction; no correction token',async t=>{const f=setup(t);f.states.get('question').practiceDirection='none';const r=await update(f,await f.args({front:'Question'}));assert.equal(r.verified,true);assert.equal(r.changed,false);assert.equal(r.verification_token,undefined);assert.equal(f.writes(),0);});

test('direction removal allows only an empty history and reports the discarded unreviewed ID',async t=>{for(const empty of [true,false]){const f=setup(t);f.faults.removeDirection=true;f.faults.emptyHistory=empty;const r=await update(f,await f.args({direction:'backward'}));if(empty){assert.equal(r.verified,true);assert.deepEqual(r.spaced_repetition.removed_unreviewed_practice_card_ids,['question_forward']);}else{assert.equal(r.status,'needs_inspection');assert.match(r.message,/card_ids/);}}});
test('blank sides, documents and missing typed request keys fail before writes',async t=>{const f=setup(t);for(const fields of [{front:''},{back:'  '}])await assert.rejects(async()=>update(f,await f.args(fields)),/must not be blank/);const args=await f.args({front:'X'});delete args.request_id;await assert.rejects(()=>update(f,args),/required/);f.states.get('question').isDocument=true;await assert.rejects(async()=>update(f,await f.args({front:'X'})),/Only existing/);assert.equal(f.writes(),0);});
