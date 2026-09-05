import { createHash } from 'node:crypto';
import { strictArgs } from './flashcards.mjs';
import { STATUS_ADAPTER } from './card-status.mjs';
import {timingProperties,validateTiming,timingSemantics,timingAccumulator} from './timing.mjs';

export const properties = {
  ...timingProperties,
  timezone:{type:'string',maxLength:100,description:'IANA timezone, e.g. Europe/Vienna. Required; never assume the server timezone.'},
  start_date:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'First study date, inclusive. Defaults to the current study date in timezone.'},
  end_date:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'Last study date, inclusive. Defaults to start_date. Maximum 366 days.'},
  day_start_hour:{type:'integer',minimum:0,maximum:23,description:'Local hour starting a study day. Defaults to RemNote nextDayStartsAt (4 if unset). Use 0 for calendar days.'},
  root_rem_id:{type:'string',pattern:'^[A-Za-z0-9_-]{3,128}$',description:'Optional topic/document Rem plus its parent-linked descendants. Excludes tag/portal membership.'},
};
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const WORKLOAD_TOOLS=[
  {name:'get_study_workload',description:'Summarize actual graded reviews, distinct practice cards and Rems studied, daily activity, enabled/disabled/Edit Later cards, and stored schedule candidates for a knowledge base or topic outline. Skips, leech views, resets and manual scheduling events are separate from reviews. Retained retired-card history is included; deleted/purged history is unavailable. Stored schedule candidates are NOT the native queue. Includes separate total-response and reveal-offset summaries: totals, medians, quartiles and timing by rating. Optional max_reveal_seconds filters reveal statistics independently. Optional max_review_seconds adds transparent filtered statistics; raw totals remain. Elapsed time is not active study time. Requires timezone; dates default to today. Read-only.',inputSchema:{type:'object',additionalProperties:false,properties:{...properties,include_live_queue:{type:'boolean',default:false,description:'Also read the currently open SDK review queue. Global session only, unrelated to root_rem_id; may be unavailable outside practice.'}},required:['timezone']},annotations},
  {name:'list_card_review_stats',description:'Inspect how often individual practice cards were reviewed: period and retained lifetime graded counts, grade breakdown, last actual graded review, enabled state and next schedule. Includes retired rows with retained history. Filter to a topic outline with root_rem_id. Follow next_cursor with the same arguments; a changed database requires restarting. Includes period/lifetime timing totals, medians, quartiles, quality counts and rating breakdowns separately for total response and reveal offset. Optional max_reveal_seconds filters reveal statistics independently. Optional max_review_seconds adds filtered alongside unfiltered statistics. Does not expose note text or raw history.',inputSchema:{type:'object',additionalProperties:false,properties:{...properties,limit:{type:'integer',minimum:1,maximum:100,default:50},cursor:{type:'string',maxLength:2048}},required:['timezone']},annotations},
];
export const grades = new Map([[0,'again'],[0.5,'hard'],[1,'good'],[1.5,'easy']]);
export const otherScores = new Map([[0.01,'skips'],[2,'leech_views'],[3,'resets'],[4,'manual_dates'],[5,'manual_ease']]);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateValid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const increment=s=>new Date(Date.parse(s)+86400000).toISOString().slice(0,10);
export function counter(){return {graded_reviews:0,again:0,hard:0,good:0,easy:0,cram_reviews:0,non_cram_reviews:0,cram_mode_unknown:0,externally_added_reviews:0,partial_multiline_reviews:0,skips:0,leech_views:0,resets:0,manual_dates:0,manual_ease:0,unknown_events:0,simulated_events:0};}
export function dateFormatter(timezone) { return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}); }
export function studyDate(timestamp, timezone, hour, formatter=dateFormatter(timezone)) {
  const parts=Object.fromEntries(formatter.formatToParts(timestamp).map(p=>[p.type,p.value]));
  const date=`${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour)<hour?new Date(Date.parse(date)-86400000).toISOString().slice(0,10):date;
}
// RemNote 1.28.0 worker modules 790719 / 734637: only these four scores
// are grades. Outer history events count once, not once per multiline subcard.
export function addEvent(count,event){
  if(event.isFakeSimulated===true){count.simulated_events++;return false;}
  const grade=grades.get(event.score);
  if(!grade){count[otherScores.get(event.score)??'unknown_events']++;return false;}
  count.graded_reviews++;count[grade]++;
  count[event.isCram===true?'cram_reviews':event.isCram===false?'non_cram_reviews':'cram_mode_unknown']++;
  if(event.addedExternally===true)count.externally_added_reviews++;
  if(event.isFullMultiLineRep===false)count.partial_multiline_reviews++;
  return true;
}
export function configuration(db,args,now){
  validateTiming(args);
  if(typeof args.timezone!=='string'||args.timezone.length>100)throw new TypeError('A valid IANA timezone is required.');
  try{new Intl.DateTimeFormat('en',{timeZone:args.timezone});}catch{throw new TypeError('Invalid IANA timezone.');}
  let hour=args.day_start_hour;
  if(hour===undefined){
    const rows=db.prepare("SELECT json_extract(doc,'$.value') AS value FROM user_data WHERE json_extract(doc,'$.key')='nextDayStartsAt'").all();
    if(rows.length>1)throw new Error('Ambiguous study-day setting.');
    hour=rows[0]?.value??4;
  }
  if(!Number.isInteger(hour)||hour<0||hour>23)throw new TypeError('day_start_hour must be an integer from 0 to 23.');
  const start=args.start_date??studyDate(now,args.timezone,hour),end=args.end_date??start;
  if(!dateValid(start)||!dateValid(end)||end<start||(Date.parse(end)-Date.parse(start))/86400000>=366)throw new TypeError('Use valid inclusive start_date/end_date spanning at most 366 days.');
  if(args.root_rem_id!==undefined&&(typeof args.root_rem_id!=='string'||!/^[A-Za-z0-9_-]{3,128}$/.test(args.root_rem_id)))throw new TypeError('Invalid root_rem_id.');
  return {start_date:start,end_date:end,timezone:args.timezone,day_start_hour:hour,root_rem_id:args.root_rem_id??null};
}
export function readRows(db,root){
  if(root&&!db.prepare('SELECT 1 FROM quanta WHERE _id=?').get(root))throw new Error('Topic Rem is missing in the synced database.');
  const rows=db.prepare(`WITH RECURSIVE scope(id) AS (
    SELECT _id FROM quanta WHERE _id=? UNION SELECT q._id FROM quanta q JOIN scope s ON json_extract(q.doc,'$.parent')=s.id
  ) SELECT c._id AS card_id,c.doc AS card_doc,r._id AS rem_id,r.doc AS rem_doc
  FROM cards c LEFT JOIN quanta r ON json_extract(c.doc,'$.rId')=r._id
  WHERE (? IS NULL OR r._id IN (SELECT id FROM scope)) ORDER BY c._id`).all(root,root);
  return rows;
}
export function createWorkloadService(repository,run,verifyAdapter){
  function scan(args,paged){
    let cursor;
    if(args.cursor!==undefined){
      if(typeof args.cursor!=='string'||args.cursor.length>2048)throw new TypeError('Invalid review-stat cursor.');
      try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{throw new TypeError('Invalid review-stat cursor.');}
      if(!cursor||typeof cursor.after!=='string'||typeof cursor.snapshot!=='string'||!Number.isFinite(cursor.now)||cursor.query!==hash({...args,cursor:undefined,limit:undefined}))throw new TypeError('Cursor does not belong to this query.');
    }
    return repository.withDatabase(db=>{
      db.exec('BEGIN');
      try{
        const now=cursor?.now??Date.now(),config=configuration(db,args,now),formatter=dateFormatter(config.timezone);
        const rows=readRows(db,config.root_rem_id);
        const snapshot=hash([config,rows]);
        if(cursor&&cursor.snapshot!==snapshot)throw new Error('Review data changed between pages. Restart without cursor.');
        const total=counter(),totalTiming=timingAccumulator(args),daily=new Map(),uniqueCards=new Set(),uniqueRems=new Set();
        const days=(Date.parse(config.end_date)-Date.parse(config.start_date))/86400000+1;
        for(let i=0,day=config.start_date;i<days;i++){daily.set(day,{date:day,...counter(),timingAccumulator:timingAccumulator(args),cards:new Set(),rems:new Set()});if(i+1<days)day=increment(day);}
        const inventory={stored_card_rows:rows.length,current_cards:0,retired_cards:0,orphaned_cards:0,enabled_cards:0,disabled_cards:0,edit_later_cards:0,never_graded_cards:0,enabled_never_graded_cards:0,enabled_scheduled_at_or_before_now:0,enabled_scheduled_later:0,enabled_schedule_unknown:0};
        let invalidEvents=0;const items=[];
        for(const row of rows){
          const card=JSON.parse(row.card_doc),rem=row.rem_doc?JSON.parse(row.rem_doc):null;
          if(card.h!==undefined&&!Array.isArray(card.h))throw new Error('Unsupported review-history shape.');
          const lifetime=counter(),period=counter(),lifetimeTiming=timingAccumulator(args),periodTiming=timingAccumulator(args);let last=null,bad=0;
          for(const event of card.h??[]){
            if(!event||typeof event.score!=='number'||!Number.isFinite(event.date)||event.date<0||event.date>now){bad++;continue;}
            const graded=addEvent(lifetime,event);if(paged)lifetimeTiming.add(event);if(graded)last=last===null?event.date:Math.max(last,event.date);
            const date=studyDate(event.date,config.timezone,config.day_start_hour,formatter),day=daily.get(date);
            if(!day||event.date>now)continue;
            addEvent(period,event);addEvent(total,event);addEvent(day,event);
            periodTiming.add(event);totalTiming.add(event);day.timingAccumulator.add(event);
            if(graded){uniqueCards.add(row.card_id);if(row.rem_id)uniqueRems.add(row.rem_id);day.cards.add(row.card_id);if(row.rem_id)day.rems.add(row.rem_id);}
          }
          invalidEvents+=bad;
          const editLater=rem?.apu?.e?.v===true||rem?.apu?.e?.v===1;
          const retired=!!card.b&&!editLater,enabled=!!card.a&&!retired&&!!rem;
          if(!rem)inventory.orphaned_cards++;
          else if(retired)inventory.retired_cards++;
          else{
            inventory.current_cards++;
            if(editLater)inventory.edit_later_cards++;
            if(enabled)inventory.enabled_cards++;else if(!editLater)inventory.disabled_cards++;
            if(!lifetime.graded_reviews){inventory.never_graded_cards++;if(enabled)inventory.enabled_never_graded_cards++;}
            if(enabled){if(!Number.isFinite(card.a))inventory.enabled_schedule_unknown++;else if(card.a<=now)inventory.enabled_scheduled_at_or_before_now++;else inventory.enabled_scheduled_later++;}
          }
          if(paged&&(!cursor||row.card_id>cursor.after)&&items.length<(args.limit??50))items.push({card_id:row.card_id,rem_id:card.rId??null,card_type:card.c==='f'?'forward':card.c==='b'?'backward':card.c??null,enabled,edit_later:editLater,retired,orphaned:!rem,period,lifetime,timing:{period:periodTiming.result(),lifetime:lifetimeTiming.result()},last_graded_review_at:last===null?null:new Date(last).toISOString(),next_scheduled_at:Number.isFinite(card.n)&&Math.abs(card.n)<=8640000000000000?new Date(card.n).toISOString():null,invalid_history_events:bad});
        }
        const coverage={source:'Read-only snapshot of the configured local synced knowledge base.',history:'All retained cards rows, including retired and orphaned cards. Deleted/purged cards and undone or missing history cannot be recovered. Counts are retained history, not an all-time audit.',scope:'Current parent-linked outline only; tags, portals and historical topic membership are not expanded.',schedule:'Enabled ignores deck pausing. Schedule candidates use stored active-next-time <= now; they are not the native queue, daily limits, priorities or learn-ahead workload.',invalid_history_events:invalidEvents,complete_retained_history:invalidEvents===0};
        const result={as_of:new Date(now).toISOString(),period:config,adapter:STATUS_ADAPTER,coverage,timing_semantics:timingSemantics};
        if(paged){
          const more=items.length>0&&rows.some(r=>r.card_id>items.at(-1).card_id);
          return {...result,items,total:rows.length,count:items.length,has_more:more,next_cursor:more?Buffer.from(JSON.stringify({after:items.at(-1).card_id,snapshot,now,query:hash({...args,cursor:undefined,limit:undefined})})).toString('base64url'):null};
        }
        return {...result,inventory,timing:totalTiming.result(),reviews:{...total,distinct_cards_reviewed:uniqueCards.size,distinct_rems_reviewed:uniqueRems.size},daily:[...daily.values()].map(({cards,rems,timingAccumulator,...day})=>({...day,timing:timingAccumulator.result(),distinct_cards_reviewed:cards.size,distinct_rems_reviewed:rems.size}))};
      }finally{db.exec('COMMIT');}
    });
  }
  return {
    async summary(args){
      strictArgs(args,[...Object.keys(properties),'include_live_queue'],['timezone']);
      if(args.include_live_queue!==undefined&&typeof args.include_live_queue!=='boolean')throw new TypeError('include_live_queue must be boolean.');
      await verifyAdapter();const result=scan(args,false);
      if(args.include_live_queue){
        try{
          const queue=await run('remnote_queue',{operation:'status'});
          result.live_queue={available:Number.isInteger(queue?.remaining)&&queue.remaining>=0,remaining:Number.isInteger(queue?.remaining)&&queue.remaining>=0?queue.remaining:null,screen_type:queue?.screenType??null,scope:'Currently open SDK queue only; not filtered by topic or dates. A zero outside practice does not mean no cards are due.'};
        }catch{result.live_queue={available:false,remaining:null,reason:'Current SDK queue could not be read. Database summary is still available.'};}
      }
      return result;
    },
    async list(args){
      strictArgs(args,[...Object.keys(properties),'limit','cursor'],['timezone']);
      if(args.limit!==undefined&&(!Number.isInteger(args.limit)||args.limit<1||args.limit>100))throw new TypeError('limit must be from 1 to 100.');
      await verifyAdapter();return scan(args,true);
    },
  };
}
