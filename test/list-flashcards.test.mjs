import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createFlashcardListing} from '../src/list-flashcards.mjs';
const when=Date.parse('2026-01-15T12:00:00Z');
const event=(score,responseTime,more={})=>({score,date:when,responseTime,revealTime:responseTime===undefined?undefined:responseTime/2,isCram:false,...more});
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE quanta (_id TEXT PRIMARY KEY,doc TEXT); CREATE TABLE cards (_id TEXT PRIMARY KEY,doc TEXT); CREATE TABLE user_data (_id TEXT,doc TEXT)');
 const rem=(id,more={})=>db.prepare('INSERT INTO quanta VALUES (?,?)').run(id,JSON.stringify({key:[id],createdAt:when,u:when,...more}));
 const card=(id,more={})=>db.prepare('INSERT INTO cards VALUES (?,?)').run(id,JSON.stringify({rId:id,c:'f',a:when,n:when,h:[],...more}));
 rem('rootTopic');rem('heading',{parent:'rootTopic'});rem('alphaRem',{parent:'heading',key:['Alpha'],value:['A'],enableBackSR:true});
 rem('betaRem',{parent:'heading',key:['Beta'],value:['B'],createdAt:undefined,u:undefined});rem('multiRem',{parent:'rootTopic',key:['Steps?']});
 rem('answer2',{parent:'multiRem',key:['Second climate item'],apu:{w:{v:true}},f:'b'});rem('answer1',{parent:'multiRem',key:['First'],apu:{w:{v:true}},f:'a'});
 rem('noteRem',{parent:'multiRem',key:['Not an answer'],f:'c'});rem('outsideRem',{value:['Outside']});rem('retiredRem',{value:['Retired']});
 card('alphaForward',{rId:'alphaRem',h:[event(0,10000),event(1,20000),event(.01,999999)]});
 card('alphaBackward',{rId:'alphaRem',c:'b',a:0,h:[event(.5,30000)]});
 card('betaCard',{rId:'betaRem',h:[event(1,undefined)]});card('multiCard',{rId:'multiRem',h:[event(0,90000),event(0,90000)]});
 card('outsideCard',{rId:'outsideRem',h:[event(1,1000000)]});card('retiredCard',{rId:'retiredRem',b:true,h:[event(1,800000)]});card('orphanCard',{rId:'gone',h:[event(1,800000)]});
 return {db,rem,card,service:createFlashcardListing({withDatabase:cb=>cb(db)},async()=>{})};
}
const sort=[{field:'recorded_review_seconds',order:'desc'}];
test('ranks all topic matches before paging and groups both directions once',async t=>{
 const f=fixture();t.after(()=>f.db.close());const q={root_rem_id:'rootTopic',sort,limit:1};
 const first=await f.service.list(q);assert.equal(first.total,3);assert.equal(first.items[0].rem_id,'multiRem');assert.equal(first.items[0].metrics.recorded_review_seconds,180);
 const second=await f.service.list({...q,cursor:first.next_cursor});assert.equal(second.items[0].rem_id,'alphaRem');assert.equal(second.items[0].direction,'both');assert.equal(second.items[0].practice_cards.length,2);assert.equal(second.items[0].metrics.review_count,3);assert.equal(second.items[0].metrics.recorded_review_seconds,60);
 const last=await f.service.list({...q,cursor:second.next_cursor});assert.equal(last.items[0].metrics.recorded_review_seconds,null);assert.equal(last.has_more,false);
});
test('full marked child answers searched in native order, ordinary notes excluded',async t=>{
 const f=fixture();t.after(()=>f.db.close());const r=await f.service.list({root_rem_id:'rootTopic',search:{text:'CLIMATE',in:['answer_items']},filters:{types:['multiline']}});
 assert.equal(r.total,1);assert.deepEqual(r.items[0].answer_items.map(i=>i.rem_id),['answer1','answer2']);assert.equal((await f.service.list({search:{text:'Not an answer',in:['answer_items']}})).total,0);
});
test('filters combine AND, field arrays OR, and labels are any direction',async t=>{
 const f=fixture();t.after(()=>f.db.close());const r=await f.service.list({root_rem_id:'rootTopic',filters:{types:['basic','multiline'],enabled:true,labels_any:['disabled'],directions:['both'],review_count:{min:3},again_share:{max:0.5}}});
 assert.equal(r.total,1);assert.equal(r.items[0].rem_id,'alphaRem');assert.equal(r.items[0].enabled_all,false);
 assert.equal((await f.service.list({root_rem_id:'rootTopic',filters:{labels_all:['struggling','enabled']}})).items[0].rem_id,'multiRem');
});
test('scope may include direct children only, missing roots are rejected',async t=>{
 const f=fixture();t.after(()=>f.db.close());const r=await f.service.list({root_rem_id:'rootTopic',include_descendants:false});assert.deepEqual(r.items.map(i=>i.rem_id),['multiRem']);await assert.rejects(()=>f.service.list({root_rem_id:'missingTopic'}),/missing/);
});
test('date windows exclude outside reviews, thresholds retain raw totals, no history is null timing',async t=>{
 const f=fixture();t.after(()=>f.db.close());const q={root_rem_id:'heading',max_review_seconds:15,max_reveal_seconds:8};const r=await f.service.list(q);const a=r.items.find(i=>i.rem_id==='alphaRem');assert.equal(a.metrics.recorded_review_seconds,60);assert.equal(a.metrics.filtered_review_seconds,10);assert.equal(a.metrics.filtered_reveal_seconds,5);assert.equal(a.timing.excluded_by_threshold.reviews,2);
 const empty=await f.service.list({...q,period:{start_date:'2026-01-16',timezone:'UTC'}});assert.ok(empty.items.every(i=>i.metrics.review_count===0&&i.metrics.recorded_review_seconds===null));
 const day=await f.service.list({root_rem_id:'heading',period:{start_date:'2026-01-15',timezone:'UTC',day_start_hour:0}});assert.equal(day.items.find(i=>i.rem_id==='alphaRem').metrics.review_count,3);
});
test('missing dates/timing never match ranges and always sort last',async t=>{
 const f=fixture();t.after(()=>f.db.close());for(const order of ['asc','desc']){const r=await f.service.list({root_rem_id:'heading',sort:[{field:'created_at',order}]});assert.equal(r.items.at(-1).rem_id,'betaRem');}
 assert.equal((await f.service.list({root_rem_id:'heading',filters:{recorded_review_seconds:{min:0}}})).total,1);
 assert.equal((await f.service.list({root_rem_id:'heading',filters:{created_at:{min:'2026-01-15T00:00:00Z'}}})).total,1);
});
test('retired/orphan policy explicit and unsupported card types remain visible',async t=>{
 const f=fixture();t.after(()=>f.db.close());assert.equal((await f.service.list({})).total,4);assert.equal((await f.service.list({include_retired:true})).total,5);
 f.rem('clozeRem');f.card('clozeCard',{rId:'clozeRem',c:'unrecognized'});const r=await f.service.list({filters:{types:['other']}});assert.equal(r.total,1);assert.equal(r.items[0].practice_cards[0].stored_type_code,'unrecognized');assert.equal(r.items[0].direction,'unknown');
});
test('cursor binds filters/settings/snapshot, stable tie breaker prevents repeats',async t=>{
 const f=fixture();t.after(()=>f.db.close());const q={root_rem_id:'rootTopic',limit:1};const first=await f.service.list(q);
 await assert.rejects(()=>f.service.list({...q,filters:{enabled:true},cursor:first.next_cursor}),/belong/);
 f.db.prepare('INSERT INTO user_data VALUES (?,?)').run('threshold',JSON.stringify({key:'leechThreshold',value:8}));await assert.rejects(()=>f.service.list({...q,cursor:first.next_cursor}),/changed/);
});
test('search uses full text even when output clipped or omitted',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.rem('longRem',{key:['x'.repeat(200)+'Needle'],value:['answer']});f.card('longCard',{rId:'longRem'});
 const r=await f.service.list({search:{text:'needle'},content_limit:100});assert.equal(r.total,1);assert.equal(r.items[0].front.length,100);assert.equal(r.items[0].content_truncated,true);
 const bare=await f.service.list({search:{text:'needle'},include_content:false});assert.equal(bare.total,1);assert.equal(bare.items[0].front,undefined);
});
test('strict filter validation rejects unknown fields and invalid bounds',async t=>{
 const f=fixture();t.after(()=>f.db.close());for(const args of [{filters:{arbitrary_sql:'bad'}},{filters:{review_count:{min:5,max:2}}},{filters:{again_share:{min:2}}},{sort:[{field:'bogus',order:'desc'}]},{period:{start_date:'2026-02-30',timezone:'UTC'}},{cursor:'null'},{filters:{updated_at:{min:'tomorrow'}}}])await assert.rejects(()=>f.service.list(args));
});
test('invalid history is visible and an incompatible adapter fails closed',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.card('brokenCard',{rId:'betaRem',h:[event(1,10,{date:'bad'})]});const r=await f.service.list({});assert.equal(r.coverage.complete_retained_history,false);assert.equal(r.coverage.invalid_history_events,1);
 const bad=createFlashcardListing({withDatabase:cb=>cb(f.db)},async()=>{throw new Error('Adapter changed');});await assert.rejects(()=>bad.list({}),/Adapter changed/);
});

test('image counts include both sides and marked answers, exclude context, and rank before paging',async t=>{
 const f=fixture();t.after(()=>f.db.close());const image={i:'i',url:'https://example.com/image.png'};
 const patch=(id,fields)=>{const row=f.db.prepare('SELECT doc FROM quanta WHERE _id=?').get(id);f.db.prepare('UPDATE quanta SET doc=? WHERE _id=?').run(JSON.stringify({...JSON.parse(row.doc),...fields}),id);};
 patch('alphaRem',{key:['Alpha',image],value:['A',image]});patch('answer1',{key:['First',image]});patch('noteRem',{key:[image]});
 const q={root_rem_id:'rootTopic',filters:{has_images:true},sort:[{field:'image_count',order:'desc'}],limit:1,include_content:false};const r=await f.service.list(q);assert.equal(r.total,2);assert.equal(r.items[0].rem_id,'alphaRem');assert.equal(r.items[0].image_count,2);assert.equal((await f.service.list({...q,cursor:r.next_cursor})).items[0].image_count,1);
 assert.deepEqual((await f.service.list({root_rem_id:'rootTopic',filters:{has_images:false}})).items.map(c=>c.rem_id),['betaRem']);await assert.rejects(()=>f.service.list({filters:{has_images:'yes'}}),/boolean/);
});
