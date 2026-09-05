import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createWorkloadService,studyDate} from '../src/workload.mjs';
const when=Date.parse('2026-01-15T12:00:00Z');
const event=(score,more={})=>({score,date:when,isCram:false,...more});
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cards (_id TEXT PRIMARY KEY,doc TEXT); CREATE TABLE quanta (_id TEXT PRIMARY KEY,doc TEXT); CREATE TABLE user_data (_id TEXT,doc TEXT)');
  const rem=(id,parent=null)=>db.prepare('INSERT INTO quanta VALUES (?,?)').run(id,JSON.stringify({parent}));
  const card=(id,doc)=>db.prepare('INSERT INTO cards VALUES (?,?)').run(id,JSON.stringify(doc));
  rem('topicRoot');rem('childRem','topicRoot');rem('otherRem');
  card('cardA',{rId:'childRem',c:'f',a:when,n:when,h:[event(0),event(.5),event(1),event(1.5,{isCram:true}),event(.01),event(2),event(3),event(4),event(5),event(99),event(1,{isFakeSimulated:true}),event(1,{date:Date.parse('2026-01-14T23:59:59Z')})]});
  card('cardB',{rId:'childRem',c:'b',h:[event(1,{addedExternally:true,isFullMultiLineRep:false,subCardScores:[1,1,1]})]});
  card('cardC',{rId:'otherRem',a:when,b:true,h:[event(1)]});
  card('cardD',{rId:'missingRem',h:[event(1)]});
  card('cardE',{rId:'otherRem',a:when,h:[]});
  const service=createWorkloadService({withDatabase:cb=>cb(db)},async()=>({remaining:7,screenType:'Queue'}),async()=>{});
  return {db,service,card};
}
const args={timezone:'UTC',start_date:'2026-01-15',day_start_hour:0};
test('counts actual grades separately from administrative events, distinct cards and multiline sub-scores',async t=>{
  const {db,service}=fixture();t.after(()=>db.close());
  const r=await service.summary(args);
  assert.equal(r.reviews.graded_reviews,7);assert.equal(r.reviews.distinct_cards_reviewed,4);assert.equal(r.reviews.distinct_rems_reviewed,2);
  for(const key of ['skips','leech_views','resets','manual_dates','manual_ease','unknown_events','simulated_events','cram_reviews','externally_added_reviews','partial_multiline_reviews'])assert.equal(r.reviews[key],1,key);
  assert.equal(r.inventory.current_cards,3);assert.equal(r.inventory.enabled_cards,2);assert.equal(r.inventory.disabled_cards,1);assert.equal(r.inventory.retired_cards,1);assert.equal(r.inventory.orphaned_cards,1);assert.equal(r.inventory.enabled_never_graded_cards,1);
});
test('topic scope is a recursive outline and history remains available for disabled cards',async t=>{
  const {db,service}=fixture();t.after(()=>db.close());
  const r=await service.summary({...args,root_rem_id:'topicRoot'});
  assert.equal(r.reviews.graded_reviews,5);assert.equal(r.reviews.distinct_rems_reviewed,1);assert.equal(r.inventory.current_cards,2);
  await assert.rejects(()=>service.summary({...args,root_rem_id:'unknownRem'}),/missing/);
});
test('pagination binds query and snapshot, and reports lifetime and last actual review',async t=>{
  const {db,service}=fixture();t.after(()=>db.close());
  const first=await service.list({...args,limit:1});assert.equal(first.total,5);assert.equal(first.items[0].lifetime.graded_reviews,5);assert.equal(first.items[0].period.graded_reviews,4);
  const next=await service.list({...args,limit:2,cursor:first.next_cursor});assert.deepEqual(next.items.map(c=>c.card_id),['cardB','cardC']);
  await assert.rejects(()=>service.list({...args,start_date:'2026-01-14',cursor:first.next_cursor}),/does not belong/);
  db.prepare('UPDATE cards SET doc=? WHERE _id=?').run(JSON.stringify({rId:'otherRem',h:[event(0)]}),'cardE');
  await assert.rejects(()=>service.list({...args,cursor:first.next_cursor}),/changed between pages/);
});
test('inclusive date range returns zero days and handles study-day boundaries and DST',async t=>{
  const {db,service}=fixture();t.after(()=>db.close());
  const r=await service.summary({...args,start_date:'2026-01-13',end_date:'2026-01-15'});assert.equal(r.daily.length,3);assert.equal(r.daily[0].graded_reviews,0);assert.equal(r.daily[1].graded_reviews,1);
  assert.equal(studyDate(Date.parse('2026-03-29T01:30:00Z'),'Europe/Vienna',4),'2026-03-28');
  assert.equal(studyDate(Date.parse('2026-03-29T02:00:00Z'),'Europe/Vienna',4),'2026-03-29');
  for(const instant of ['2026-10-25T00:30:00Z','2026-10-25T01:30:00Z'])assert.equal(studyDate(Date.parse(instant),'Europe/Vienna',4),'2026-10-24');
  assert.equal(studyDate(Date.parse('2026-01-15T00:00:00Z'),'UTC',0),'2026-01-15');
});
test('invalid dates, timezone, cursor and ranges are refused; malformed history is visible',async t=>{
  const {db,service,card}=fixture();t.after(()=>db.close());
  for(const override of [{timezone:'bad/zone'},{start_date:'2026-02-30'},{start_date:'2025-01-01',end_date:'2026-01-02'},{day_start_hour:24},{extra:true}])await assert.rejects(()=>service.summary({...args,...override}));
  await assert.rejects(()=>service.list({...args,cursor:'null'}));
  card('invalidCard',{rId:'otherRem',h:[event(1,{date:'bad'})]});
  const r=await service.summary(args);assert.equal(r.coverage.invalid_history_events,1);assert.equal(r.coverage.complete_retained_history,false);
});
test('live queue is optional and failures preserve the database summary',async t=>{
  const {db,service}=fixture();t.after(()=>db.close());
  assert.equal((await service.summary({...args,include_live_queue:true})).live_queue.remaining,7);
  const failing=createWorkloadService({withDatabase:cb=>cb(db)},async()=>{throw new Error('offline');},async()=>{});
  const r=await failing.summary({...args,include_live_queue:true});assert.equal(r.live_queue.available,false);assert.equal(r.reviews.graded_reviews,7);
});
test('upper date boundary terminates and an unverified adapter refuses analytics',async t=>{
  const {db,service}=fixture();t.after(()=>db.close());
  assert.equal((await service.summary({...args,start_date:'9999-12-31'})).daily.length,1);
  const blocked=createWorkloadService({withDatabase:()=>{throw new Error('must not scan');}},null,async()=>{throw new Error('Adapter changed');});
  await assert.rejects(()=>blocked.summary(args),/Adapter changed/);
});
