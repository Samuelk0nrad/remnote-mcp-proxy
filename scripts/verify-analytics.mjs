// Read-only checks. Prints assertions and totals, never note text or Card/Rem IDs.
import assert from 'node:assert/strict';
import {EditLaterRepository} from '../src/server.mjs';
import {createReviewAnalytics} from '../src/review-analytics.mjs';
import {createWorkloadService} from '../src/workload.mjs';
import {createAdapterVerifier} from '../src/card-status.mjs';
const databasePath=process.env.REMNOTE_DB;if(!databasePath)throw new Error('REMNOTE_DB is required.');
const repository=new EditLaterRepository(databasePath);
const verify=createAdapterVerifier(process.env.REMNOTE_APP_ASAR??'/opt/remnote/app/resources/app.asar');
const service=createReviewAnalytics(repository,verify),workload=createWorkloadService(repository,null,verify);
const roots=repository.withDatabase(db=>db.prepare("SELECT r._id FROM quanta r JOIN cards c ON json_extract(c.doc,'$.rId')=r._id GROUP BY r._id ORDER BY MAX(COALESCE(json_array_length(c.doc,'$.h'),0)) DESC,r._id LIMIT 2").all().map(r=>r._id));
if(roots.length<2)throw new Error('Two existing card Rems are required for read-only comparison.');
const year=new Date().getUTCFullYear(),args={timezone:'UTC',day_start_hour:0,start_date:`${year}-01-01`,end_date:`${year}-12-31`};
let page=await service.timeline({...args,rem_id:roots[0],limit:10});const events=[...page.items],cutoff=Date.parse(page.as_of);
while(page.has_more){page=await service.timeline({...args,rem_id:roots[0],limit:10,cursor:page.next_cursor});events.push(...page.items);}
const expected=repository.withDatabase(db=>{
 const rows=db.prepare("SELECT _id,doc FROM cards WHERE json_extract(doc,'$.rId')=?").all(roots[0]);
 return rows.flatMap(row=>(JSON.parse(row.doc).h??[]).flatMap((e,index)=>e&&Number.isFinite(e.score)&&Number.isFinite(e.date)&&e.date>=0&&e.date<=cutoff&&new Date(e.date).getUTCFullYear()===year?[{card_id:row._id,history_index:index,score:e.score,reviewed_at:new Date(e.date).toISOString()}]:[])).sort((a,b)=>a.reviewed_at.localeCompare(b.reviewed_at)||a.card_id.localeCompare(b.card_id)||a.history_index-b.history_index);
});
assert.deepEqual(events.map(({card_id,history_index,score,reviewed_at})=>({card_id,history_index,score,reviewed_at})),expected);
const comparison=await service.compare({...args,root_rem_ids:roots});
for(const topic of comparison.topics){const summary=await workload.summary({...args,root_rem_id:topic.root_rem_id});assert.equal(topic.reviews.graded_reviews,summary.reviews.graded_reviews);assert.equal(topic.enabled_cards,summary.inventory.enabled_cards);}
let trend=await service.trends({...args,root_rem_id:roots[0]});const trendItems=[...trend.items];
while(trend.has_more){trend=await service.trends({...args,root_rem_id:roots[0],cursor:trend.next_cursor});trendItems.push(...trend.items);}
const summary=await workload.summary({...args,root_rem_id:roots[0]});
assert.equal(trendItems.reduce((sum,c)=>sum+c.period.graded_reviews,0),summary.reviews.graded_reviews);
const forecast=await service.forecast({timezone:'UTC',days:7});
assert.equal(forecast.enabled_cards,forecast.overdue_or_scheduled_now+forecast.daily.reduce((sum,d)=>sum+d.scheduled_cards,0)+forecast.scheduled_beyond_horizon+forecast.unknown_schedule_cards);
console.log(JSON.stringify({verified:true,timeline_events_compared:events.length,topic_comparisons:comparison.topics.length,trends_match_workload:true,forecast_balances:true}));
