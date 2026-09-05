import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createReviewAnalytics,ANALYTICS_TOOLS} from '../src/review-analytics.mjs';
import {createWorkloadService} from '../src/workload.mjs';
const event=(date,score,extra={})=>({date:Date.parse(`${date}T12:00:00Z`),score,isCram:false,...extra});
const options={timezone:'UTC',day_start_hour:0,start_date:'2026-01-01',end_date:'2026-01-14'};
function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE cards (_id TEXT PRIMARY KEY,doc TEXT);CREATE TABLE quanta (_id TEXT PRIMARY KEY,doc TEXT);CREATE TABLE user_data (_id TEXT,doc TEXT)');
  const rem=(id,parent=null)=>db.prepare('INSERT INTO quanta VALUES (?,?)').run(id,JSON.stringify({parent}));
  const card=(id,rId,h,extra={})=>db.prepare('INSERT INTO cards VALUES (?,?)').run(id,JSON.stringify({rId,h,c:'f',...extra}));
  rem('rootAlpha');rem('childAlpha','rootAlpha');rem('rootBeta');
  const repository={withDatabase:cb=>cb(db)};
  return {db,rem,card,service:createReviewAnalytics(repository,async()=>{}),workload:createWorkloadService(repository,null,async()=>{})};
}
test('timeline sorts unsorted equal-time events deterministically, labels administration, and paginates',async t=>{
  const f=fixture(t);
  f.card('cardAlpha','childAlpha',[event('2026-01-03',1),event('2026-01-01',0),event('2026-01-03',3),event('2026-01-03',.01),event('2026-01-04',2),event('2026-01-05',1,{isFakeSimulated:true}),event('2026-01-06',5)]);
  const args={...options,rem_id:'childAlpha',limit:2};const first=await f.service.timeline(args);
  assert.equal(first.total,7);assert.deepEqual(first.items.map(e=>e.rating),['again','good']);
  const second=await f.service.timeline({...args,cursor:first.next_cursor});assert.deepEqual(second.items.map(e=>e.event_type),['resets','skips']);
  await assert.rejects(()=>f.service.timeline({...args,review_mode:'cram',cursor:first.next_cursor}),/does not belong/);
  f.card('cardBeta','childAlpha',[event('2026-01-02',1)]);
  await assert.rejects(()=>f.service.timeline({...args,cursor:first.next_cursor}),/changed between pages/);
});
test('timeline filters grades but preserves resets; exposes no answer, explanation or metadata',async t=>{
  const f=fixture(t);f.card('cardAlpha','childAlpha',[event('2026-01-01',1,{isCram:true,metadata:{secret:'not exported'},explanation:'not exported',answer:'not exported'}),event('2026-01-02',0,{addedExternally:true}),event('2026-01-03',3),event('2026-01-04',.5)]);
  const all=await f.service.timeline({...options,rem_id:'childAlpha'});assert.equal(JSON.stringify(all).includes('not exported'),false);
  const filtered=await f.service.timeline({...options,rem_id:'childAlpha',review_mode:'regular',include_external:false});assert.deepEqual(filtered.items.map(e=>e.event_type),['resets','graded_review']);
  await assert.rejects(()=>f.service.timeline({...options,rem_id:'rootBeta',card_id:'cardAlpha'}),/does not belong/);
});
test('trends compare observed grade proportions with explicit sample sizes',async t=>{
  const f=fixture(t);f.card('cardAlpha','childAlpha',[...['01','02','03'].map(d=>event(`2026-01-${d}`,0)),...['08','09','10'].map(d=>event(`2026-01-${d}`,1))]);
  const r=await f.service.trends(options),c=r.items[0];assert.equal(c.trend,'lower_again_share');assert.equal(c.earlier.graded_reviews,3);assert.equal(c.recent.graded_reviews,3);assert.equal(c.again_share_change,-1);assert.equal(c.repeated_again,true);
  assert.equal(r.windows.earlier.end_date,'2026-01-07');assert.equal(r.windows.recent.start_date,'2026-01-08');
  const strict=await f.service.trends({...options,min_reviews:4});assert.equal(strict.items[0].trend,'insufficient_reviews');assert.equal(strict.items[0].again_share_change,null);
});
test('resets, insufficient samples and invalid history suppress directional trend claims',async t=>{
  const f=fixture(t),reviews=[event('2026-01-01',1),event('2026-01-02',1),event('2026-01-03',1),event('2026-01-08',0),event('2026-01-09',0),event('2026-01-10',0)];
  f.card('cardReset','childAlpha',[...reviews,event('2026-01-07',3)]);f.card('cardInvalid','childAlpha',[...reviews,{score:1,date:'invalid'}]);f.card('cardTiny','childAlpha',[event('2026-01-10',0)]);
  const r=await f.service.trends(options),byId=Object.fromEntries(r.items.map(c=>[c.card_id,c]));
  assert.equal(byId.cardReset.trend,'reset_in_period');assert.equal(byId.cardReset.again_share_change,null);assert.equal(byId.cardInvalid.trend,'incomplete_history');assert.equal(byId.cardTiny.trend,'insufficient_reviews');assert.equal(r.coverage.invalid_history_events,1);
});
test('long-gap pattern uses actual preceding grade and cannot bridge resets or excluded cram practice',async t=>{
  const f=fixture(t);f.card('cardGap','childAlpha',[event('2025-12-30',1),event('2026-01-10',0)]);
  f.card('cardReset','childAlpha',[event('2025-12-30',1),event('2026-01-01',3),event('2026-01-10',0)]);
  f.card('cardCram','childAlpha',[event('2025-12-30',1),event('2026-01-09',1,{isCram:true}),event('2026-01-10',0)]);
  const r=await f.service.trends({...options,review_mode:'regular'}),byId=Object.fromEntries(r.items.map(c=>[c.card_id,c]));
  assert.equal(byId.cardGap.again_after_long_gap_count,1);assert.equal(byId.cardGap.last_again_after_long_gap.elapsed_days,11);
  assert.equal(byId.cardReset.again_after_long_gap_count,0);assert.equal(byId.cardCram.again_after_long_gap_count,0);
});
test('topic comparison matches summary counts and flags nested overlap without summing it',async t=>{
  const f=fixture(t);f.card('cardAlpha','childAlpha',[event('2026-01-01',0),event('2026-01-02',1)],{a:1});f.card('cardBeta','rootBeta',[],{a:1});
  const r=await f.service.compare({...options,root_rem_ids:['rootAlpha','childAlpha','rootBeta']});
  assert.equal(r.overlapping_card_count,1);assert.equal(r.topics[0].reviews.again_share,.5);assert.equal(r.topics[2].reviews.again_share,null);assert.equal(r.topics[2].enabled_never_graded_cards,1);
  const old=await f.workload.summary({...options,root_rem_id:'rootAlpha'});assert.equal(r.topics[0].reviews.graded_reviews,old.reviews.graded_reviews);
  await assert.rejects(()=>f.service.compare({...options,root_rem_ids:['rootAlpha','rootAlpha']}));
});
test('forecast counts enabled cards once, separating overdue, later today, horizon and unknown schedule',async t=>{
  const f=fixture(t),now=Date.now(),hour=Number(new Intl.DateTimeFormat('en',{timeZone:'UTC',hour:'numeric',hourCycle:'h23'}).format(now));
  f.card('cardOverdue','childAlpha',[],{a:now-86400000});f.card('cardSoon','childAlpha',[],{a:now+1000});f.card('cardTomorrow','childAlpha',[],{a:now+86400000});f.card('cardBeyond','childAlpha',[],{a:now+15*86400000});f.card('cardUnknown','childAlpha',[],{a:true});f.card('cardDisabled','childAlpha',[]);f.card('cardRetired','childAlpha',[],{a:now,b:true});
  const r=await f.service.forecast({timezone:'UTC',day_start_hour:hour,days:7});
  assert.equal(r.enabled_cards,5);assert.equal(r.overdue_or_scheduled_now,1);assert.equal(r.daily.reduce((n,d)=>n+d.scheduled_cards,0),2);assert.equal(r.scheduled_beyond_horizon,1);assert.equal(r.unknown_schedule_cards,1);assert.equal(r.daily.length,7);
  assert.equal(r.enabled_cards,r.overdue_or_scheduled_now+r.daily.reduce((n,d)=>n+d.scheduled_cards,0)+r.scheduled_beyond_horizon+r.unknown_schedule_cards);
});
test('historical end date defaults and study-day timezone boundaries work',async t=>{
  const f=fixture(t);f.card('cardAlpha','childAlpha',[{score:1,date:Date.parse('2026-03-29T01:30:00Z'),isCram:false}]);
  const r=await f.service.timeline({timezone:'Europe/Vienna',day_start_hour:4,end_date:'2026-03-28',rem_id:'childAlpha'});assert.equal(r.items.length,1);assert.equal(r.items[0].study_date,'2026-03-28');assert.equal(r.period.start_date,'2026-02-27');
  const defaultTrend=await f.service.trends({timezone:'UTC',end_date:'2026-01-14'});assert.equal(defaultTrend.period.start_date,'2026-01-01');
});
test('filters, cursors and adapter changes fail before claiming analytics',async t=>{
  const f=fixture(t);
  for(const bad of [{min_reviews:1},{review_mode:'guess'},{include_external:'false'},{limit:0},{cursor:'null'},{root_rem_id:'; DROP TABLE cards'},{unexpected:true},{start_date:'2026-02-30'}])await assert.rejects(()=>f.service.trends({...options,...bad}));
  const blocked=createReviewAnalytics({withDatabase(){throw new Error('must not scan');}},async()=>{throw new Error('Adapter changed');});await assert.rejects(()=>blocked.forecast({timezone:'UTC'}),/Adapter changed/);
  for(const spec of ANALYTICS_TOOLS)assert.equal(spec.annotations.readOnlyHint,true);
});

test('five timing views agree while threshold flags retain the complete review timeline',async t=>{
 const f=fixture(t);
 const h=[event('2025-12-31',1,{responseTime:1000}),event('2026-01-01',0,{responseTime:10000,revealTime:7000}),event('2026-01-02',.5,{responseTime:20000}),event('2026-01-09',1,{responseTime:30000}),event('2026-01-10',1.5,{responseTime:900000}),event('2026-01-11',.01,{responseTime:999999})];
 f.card('cardAlpha','childAlpha',h,{a:1});
 const opts={...options,max_review_seconds:30};
 const timeline=await f.service.timeline({...opts,rem_id:'childAlpha'});assert.equal(timeline.total,5);assert.equal(timeline.items[3].timing.exceeds_selected_threshold,true);assert.equal(timeline.items[0].timing.recorded_seconds,10);
 const summary=await f.workload.summary({...opts,root_rem_id:'rootAlpha'});assert.equal(summary.timing.unfiltered.recorded_seconds,960);assert.equal(summary.timing.filtered.recorded_seconds,60);assert.equal(summary.timing.graded_reviews,4);
 assert.equal(summary.daily.reduce((sum,d)=>sum+(d.timing.unfiltered.recorded_seconds??0),0),960);
 const stats=await f.workload.list(opts);assert.deepEqual(stats.items[0].timing.period,summary.timing);assert.equal(stats.items[0].timing.lifetime.unfiltered.recorded_seconds,961);
 const compare=await f.service.compare({...opts,root_rem_ids:['rootAlpha','rootBeta']});assert.deepEqual(compare.topics[0].timing,summary.timing);assert.equal(compare.topics[1].timing.unfiltered.median_seconds,null);
 const trend=(await f.service.trends({...opts,min_reviews:2})).items[0];assert.deepEqual(trend.timing.period,summary.timing);assert.equal(trend.timing.change.unfiltered.median_seconds_change,450);assert.equal(trend.timing.change.filtered.status,'insufficient_timed_reviews');
 const raw=await f.workload.summary({...options,root_rem_id:'rootAlpha'});assert.equal(raw.timing.filtered,null);assert.deepEqual(raw.timing.unfiltered,summary.timing.unfiltered);
});
test('timing filters, quality coverage and pagination stay consistent with review filters',async t=>{
 const f=fixture(t);f.card('cardAlpha','childAlpha',[event('2026-01-01',1,{responseTime:1000,isCram:true}),event('2026-01-02',0,{responseTime:2000,addedExternally:true}),event('2026-01-09',.5,{responseTime:0}),event('2026-01-10',1),event('2026-01-11',3)]);f.card('cardBeta','rootBeta',[]);
 const result=await f.service.compare({...options,review_mode:'regular',include_external:false,root_rem_ids:['rootAlpha','rootBeta']});const timing=result.topics[0].timing;assert.equal(timing.graded_reviews,2);assert.equal(timing.zero_duration_reviews,1);assert.equal(timing.missing_duration_reviews,1);assert.equal(timing.positive_only.samples,0);
 const trend=(await f.service.trends({...options,min_reviews:2})).items[0];assert.equal(trend.timing.change.unfiltered.status,'reset_in_period');
 const args={...options,rem_id:'childAlpha',max_review_seconds:10,limit:1};const page=await f.service.timeline(args);await assert.rejects(()=>f.service.timeline({...args,max_review_seconds:20,cursor:page.next_cursor}),/does not belong/);
 const stat=await f.workload.list({...options,max_review_seconds:10,limit:1});await assert.rejects(()=>f.workload.list({...options,max_review_seconds:20,limit:1,cursor:stat.next_cursor}),/does not belong/);
 for(const max_review_seconds of [0,-1,'5',null,Infinity]){await assert.rejects(()=>f.workload.summary({...options,max_review_seconds}));await assert.rejects(()=>f.service.timeline({...options,rem_id:'childAlpha',max_review_seconds}));}
 await assert.rejects(()=>f.service.forecast({timezone:'UTC',max_review_seconds:10}),/Expected fields/);
});
