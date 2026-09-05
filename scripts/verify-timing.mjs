// Read-only timing parity checks. Prints counts, never note text or identifiers.
import assert from 'node:assert/strict';
import {EditLaterRepository} from '../src/server.mjs';
import {createWorkloadService} from '../src/workload.mjs';
import {createReviewAnalytics} from '../src/review-analytics.mjs';
import {createAdapterVerifier} from '../src/card-status.mjs';
const databasePath=process.env.REMNOTE_DB;if(!databasePath)throw new Error('REMNOTE_DB is required.');
const repository=new EditLaterRepository(databasePath),verify=createAdapterVerifier(process.env.REMNOTE_APP_ASAR??'/opt/remnote/app/resources/app.asar');
const workload=createWorkloadService(repository,null,verify),analytics=createReviewAnalytics(repository,verify);
const year=new Date().getUTCFullYear(),args={timezone:'UTC',day_start_hour:0,start_date:`${year}-01-01`,end_date:`${year}-12-31`,max_review_seconds:60};
const summary=await workload.summary(args),cutoff=Date.parse(summary.as_of);
const raw=repository.withDatabase(db=>db.prepare('SELECT doc FROM cards').all().flatMap(row=>JSON.parse(row.doc).h??[]));
const grades=raw.filter(e=>e&&[0,.5,1,1.5].includes(e.score)&&e.isFakeSimulated!==true&&Number.isFinite(e.date)&&e.date>=Date.parse(args.start_date)&&e.date<=cutoff&&new Date(e.date).getUTCFullYear()===year);
const ms=grades.map(e=>e.responseTime).filter(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER).sort((a,b)=>a-b);
const seconds=ms.map(v=>v/1000),sum=values=>values.length?values.reduce((s,v)=>s+v,0):null;
assert.equal(summary.timing.graded_reviews,grades.length);assert.equal(summary.timing.unfiltered.samples,ms.length);
assert.equal(summary.timing.unfiltered.recorded_seconds,sum(seconds));
assert.equal(summary.timing.filtered.recorded_seconds,sum(seconds.filter(v=>v<=60)));
assert.equal(summary.timing.excluded_by_threshold.reviews,seconds.filter(v=>v>60).length);
assert.equal(summary.timing.zero_duration_reviews,ms.filter(v=>v===0).length);
const median=seconds.length?((seconds[Math.floor((seconds.length-1)/2)]+seconds[Math.ceil((seconds.length-1)/2)])/2):null;
assert.equal(summary.timing.unfiltered.median_seconds,median);
const roots=repository.withDatabase(db=>db.prepare("SELECT r._id FROM quanta r JOIN cards c ON json_extract(c.doc,'$.rId')=r._id GROUP BY r._id ORDER BY MAX(COALESCE(json_array_length(c.doc,'$.h'),0)) DESC,r._id LIMIT 2").all().map(r=>r._id));
if(roots.length<2)throw new Error('Two existing card Rems are required for read-only parity checks.');
const comparison=await analytics.compare({...args,root_rem_ids:roots});
for(const topic of comparison.topics){const s=await workload.summary({...args,root_rem_id:topic.root_rem_id});assert.deepEqual(topic.timing,s.timing);}
const first=await analytics.timeline({...args,rem_id:roots[0],limit:5});
const expected=repository.withDatabase(db=>db.prepare("SELECT doc FROM cards WHERE json_extract(doc,'$.rId')=?").all(roots[0]).flatMap(row=>JSON.parse(row.doc).h??[]));
for(const e of first.items){const source=expected.find(x=>x.date===Date.parse(e.reviewed_at)&&x.score===e.score);assert.ok(source);assert.equal(e.timing.response_time_ms,typeof source.responseTime==='number'?source.responseTime:null);assert.equal(e.multiline_items.items.length+e.multiline_items.invalid_items,source.subCardScores?.length??0);}
const stats=await workload.list({...args,root_rem_id:roots[0],limit:100}),trend=await analytics.trends({...args,root_rem_id:roots[0],limit:100});
for(const card of trend.items){const match=stats.items.find(s=>s.card_id===card.card_id);assert.ok(match);assert.deepEqual(card.timing.period,match.timing.period);}
console.log(JSON.stringify({verified:true,graded_events_checked:grades.length,timed_events_checked:ms.length,raw_and_filtered_totals_match:true,median_matches:true,five_views_checked:true}));
