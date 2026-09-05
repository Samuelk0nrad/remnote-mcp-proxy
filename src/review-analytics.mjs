import {createHash} from 'node:crypto';
import {strictArgs} from './flashcards.mjs';
import {properties,configuration,readRows,studyDate,dateFormatter,grades,otherScores,counter,addEvent} from './workload.mjs';
import {STATUS_ADAPTER} from './card-status.mjs';
import {validateTiming,timingSemantics,eventTiming,eventOrigin,subItemReviews,timingAccumulator,timingChange} from './timing.mjs';

const dateProperties={...properties,
  start_date:{...properties.start_date,description:'First study date, inclusive. If omitted, look back by this tool\'s documented default window from end_date or today.'},
  end_date:{...properties.end_date,description:'Last study date, inclusive. Defaults to start_date when supplied, otherwise today in the requested timezone. Maximum 366 days.'},
};
const {root_rem_id: outlineProperty,...exactDateProperties}=dateProperties;
const id={type:'string',pattern:'^[A-Za-z0-9_-]{3,128}$'};
const pagination={limit:{type:'integer',minimum:1,maximum:100,default:50},cursor:{type:'string',maxLength:2048,description:'Opaque next_cursor. Repeat the same filters; restart if the data changes.'}};
const filters={review_mode:{type:'string',enum:['all','regular','cram'],default:'all',description:'Filter graded events. Unknown modes count only in all. Resets and administrative events remain visible.'},include_external:{type:'boolean',default:true,description:'Include grades explicitly marked as externally added. Administrative events remain visible.'}};
const tool=(name,description,props,required)=>({name,description,inputSchema:{type:'object',additionalProperties:false,properties:props,required},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}});
export const ANALYTICS_TOOLS=[
  tool('get_card_review_history','Read a chronological, paginated timeline of retained review ratings and timestamps for one Rem, optionally one of its practice Card IDs. Includes skips, resets and other administrative events, separately labelled. Includes raw response/reveal milliseconds, timing-quality flags, origin markers and multiline-item ratings/timings. max_review_seconds and max_reveal_seconds independently flag long total/reveal values without hiding events. No typed answers, private event metadata or note text. Defaults to the last 30 study dates. Deleted or undone history is unavailable.',{...exactDateProperties,rem_id:{...id,description:'Exact Rem ID; all its practice directions are included unless card_id is supplied.'},card_id:{...id,description:'Optional exact practice Card ID belonging to rem_id.'},...filters,...pagination},['timezone','rem_id']),
  tool('get_review_difficulty_trends','Find review-rating patterns per practice card in any subject. Splits the selected dates into earlier and recent windows; returns counts, Again shares, repeated-Again evidence and Again-after-long-gap events. Directional trends require enough grades in both windows and are suppressed across resets or invalid history. These descriptive heuristics are not retention estimates or native RemNote labels. Also compares total-response and reveal-offset distributions and medians separately between windows, with sample sizes and independent optional max_review_seconds/max_reveal_seconds filtering alongside raw statistics. Defaults to the last 14 study dates.',{...dateProperties,...filters,min_reviews:{type:'integer',minimum:2,maximum:100,default:3,description:'Minimum graded observations in EACH window for a directional label.'},again_threshold:{type:'integer',minimum:2,maximum:100,default:3,description:'Minimum Again grades in the selected period for repeated_again.'},long_gap_days:{type:'integer',minimum:1,maximum:365,default:7,description:'Elapsed 24-hour days since the preceding graded event for a Good/Easy to Again gap pattern.'},...pagination},['timezone']),
  tool('compare_study_topics','Compare up to 10 user-selected topic/document outlines in one consistent database snapshot: graded reviews, distinct cards studied, Again share, and enabled/never-graded counts. Subject-independent. Current parent links define each topic; tags and portals are excluded. Overlapping outlines are flagged and must not be summed. Includes separate total-response and reveal-offset totals, medians, quartiles and timing by rating. Optional max_reveal_seconds independently filters reveal offsets. Optional max_review_seconds applies consistently to all topics and preserves unfiltered statistics. Defaults to the last 14 study dates.',{...exactDateProperties,root_rem_ids:{type:'array',minItems:2,maxItems:10,uniqueItems:true,items:id},...filters},['timezone','root_rem_ids']),
  tool('get_study_workload_forecast','Group each currently enabled card once by its stored next schedule over upcoming study dates, plus overdue candidates. This is a changeable schedule snapshot, NOT predicted review attempts or the exact native queue: excludes future repeats, daily limits, deck priorities, pausing and learn-ahead rules. Subject-independent and read-only.',{timezone:properties.timezone,day_start_hour:properties.day_start_hour,root_rem_id:properties.root_rem_id,days:{type:'integer',minimum:1,maximum:90,default:7}},['timezone']),
];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dayOffset=(date,days)=>new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{3,128}$/.test(value);
const iso=ms=>Number.isFinite(ms)&&ms>=0&&ms<=8640000000000000?new Date(ms).toISOString():null;
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));return value;}
const queryHash=args=>hash(canonical({...args,limit:undefined,cursor:undefined}));
function validate(args,kind){
  const schema=ANALYTICS_TOOLS.find(t=>t.name===kind).inputSchema;
  strictArgs(args,Object.keys(schema.properties),schema.required);
  validateTiming(args);
  for(const [name,spec] of Object.entries(schema.properties)){
    const value=args[name];if(value===undefined)continue;
    if(spec.type==='integer'&&(!Number.isInteger(value)||value<spec.minimum||value>spec.maximum))throw new TypeError(`Invalid ${name}.`);
    if(spec.type==='boolean'&&typeof value!=='boolean')throw new TypeError(`Invalid ${name}.`);
    if(spec.type==='string'&&(typeof value!=='string'||(spec.maxLength&&value.length>spec.maxLength)||(spec.enum&&!spec.enum.includes(value))))throw new TypeError(`Invalid ${name}.`);
  }
  for(const name of ['rem_id','card_id','root_rem_id'])if(args[name]!==undefined&&!validId(args[name]))throw new TypeError(`Invalid ${name}.`);
  if(kind==='get_card_review_history'&&args.root_rem_id!==undefined)throw new TypeError('Use rem_id for exact history; root_rem_id is for outline summaries.');
  if(kind==='compare_study_topics'){
    if(args.root_rem_id!==undefined)throw new TypeError('Use root_rem_ids for topic comparisons.');
    if(!Array.isArray(args.root_rem_ids)||args.root_rem_ids.length<2||args.root_rem_ids.length>10||args.root_rem_ids.some(v=>!validId(v))||new Set(args.root_rem_ids).size!==args.root_rem_ids.length)throw new TypeError('Choose 2 to 10 distinct topic Rem IDs.');
  }
}
function getCursor(args){
  if(args.cursor===undefined)return null;
  let c;try{c=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{throw new TypeError('Invalid analytics cursor.');}
  if(!c||!Number.isInteger(c.offset)||c.offset<0||!Number.isFinite(c.now)||c.now<0||c.now>Date.now()||typeof c.snapshot!=='string'||c.query!==queryHash(args))throw new TypeError('Cursor does not belong to this query.');
  return c;
}
function windowConfig(db,args,now,defaultDays){
  if(args.start_date!==undefined)return configuration(db,args,now);
  const base=configuration(db,{...args,start_date:undefined,end_date:undefined},now);
  const end=args.end_date??base.end_date;
  configuration(db,{...args,start_date:end,end_date:end},now);
  return configuration(db,{...args,start_date:dayOffset(end,1-defaultDays),end_date:end},now);
}
function selected(event,args){
  if(!grades.has(event.score)||event.isFakeSimulated===true)return true;
  return (args.include_external!==false||event.addedExternally!==true)&&(!args.review_mode||args.review_mode==='all'||(args.review_mode==='cram'?event.isCram===true:event.isCram===false));
}
function history(card,now){
  if(card.h!==undefined&&!Array.isArray(card.h))throw new Error('Unsupported review-history shape.');
  let invalid=0;
  const events=(card.h??[]).flatMap((e,index)=>{
    if(!e||typeof e.score!=='number'||!Number.isFinite(e.score)||!Number.isFinite(e.date)||e.date<0||e.date>now){invalid++;return [];}
    return [{...e,index}];
  }).sort((a,b)=>a.date-b.date||a.index-b.index);
  return {events,invalid};
}
function inWindow(event,config,formatter){const date=studyDate(event.date,config.timezone,config.day_start_hour,formatter);return date>=config.start_date&&date<=config.end_date;}
function cardState(row){
  const card=JSON.parse(row.card_doc),rem=row.rem_doc?JSON.parse(row.rem_doc):null;
  const editLater=rem?.apu?.e?.v===true||rem?.apu?.e?.v===1;
  const retired=!!card.b&&!editLater;
  return {card,rem,card_id:row.card_id,rem_id:card.rId??null,retired,orphaned:!rem,edit_later:editLater,enabled:!!card.a&&!retired&&!!rem};
}
function metadata(config,now,args,invalid=0){return {
  as_of:iso(now),period:config,adapter:STATUS_ADAPTER,filters:{review_mode:args.review_mode??'all',include_external:args.include_external??true,max_review_seconds:args.max_review_seconds??null,max_reveal_seconds:args.max_reveal_seconds??null},
  timing_semantics:timingSemantics,
  coverage:{source:'Read-only local synced database snapshot.',history:'Retained card history only. Deleted, purged and undone events are unavailable. No typed answers or raw metadata are exposed.',scope:'Current parent-linked outline; no tags, portals or historical membership.',invalid_history_events:invalid,valid_retained_events_only:invalid===0},
};}
function page(items,args,cursor,snapshot,now){
  if(cursor&&cursor.snapshot!==snapshot)throw new Error('Analytics data changed between pages. Restart without cursor.');
  const offset=cursor?.offset??0,part=items.slice(offset,offset+(args.limit??50));
  const more=offset+part.length<items.length;
  return {items:part,count:part.length,total:items.length,has_more:more,next_cursor:more?Buffer.from(JSON.stringify({offset:offset+part.length,snapshot,now,query:queryHash(args)})).toString('base64url'):null};
}
function rates(count){return {...count,again_share:count.graded_reviews?count.again/count.graded_reviews:null,good_easy_share:count.graded_reviews?(count.good+count.easy)/count.graded_reviews:null};}

export function createReviewAnalytics(repository,verifyAdapter){
  async function execute(kind,args,action){
    validate(args,kind);await verifyAdapter();
    const cursor=getCursor(args),now=cursor?.now??Date.now();
    return repository.withDatabase(db=>{db.exec('BEGIN');try{return action(db,now,cursor);}finally{db.exec('COMMIT');}});
  }
  return {
    timeline(args){return execute('get_card_review_history',args,(db,now,cursor)=>{
      const config=windowConfig(db,args,now,30),formatter=dateFormatter(config.timezone);
      if(!db.prepare('SELECT 1 FROM quanta WHERE _id=?').get(args.rem_id))throw new Error('Rem is missing in the synced database.');
      const rows=readRows(db,null).filter(r=>r.rem_id===args.rem_id&&(!args.card_id||r.card_id===args.card_id));
      if(args.card_id&&!rows.length)throw new Error('Card ID is missing or does not belong to this Rem.');
      let invalid=0;const items=[];
      for(const row of rows){
        const card=JSON.parse(row.card_doc),h=history(card,now);invalid+=h.invalid;
        for(const e of h.events){
          if(!inWindow(e,config,formatter)||!selected(e,args))continue;
          const grade=e.isFakeSimulated===true?null:grades.get(e.score);
          items.push({card_id:row.card_id,rem_id:args.rem_id,card_type:card.c==='f'?'forward':card.c==='b'?'backward':card.c??null,history_index:e.index,reviewed_at:iso(e.date),study_date:studyDate(e.date,config.timezone,config.day_start_hour,formatter),event_type:e.isFakeSimulated===true?'simulated':grade?'graded_review':otherScores.get(e.score)??'unknown',rating:grade??null,score:e.score,practice_mode:e.isCram===true?'cram':e.isCram===false?'regular':'unknown',externally_added:e.addedExternally===true,partial_multiline:e.isFullMultiLineRep===false,scheduled_for:iso(e.scheduled),origin:eventOrigin(e),timing:eventTiming(e,args),multiline_items:subItemReviews(e)});
        }
      }
      items.sort((a,b)=>a.reviewed_at.localeCompare(b.reviewed_at)||a.card_id.localeCompare(b.card_id)||a.history_index-b.history_index);
      return {...metadata(config,now,args,invalid),order:'Chronological; ties by Card ID then stored history index. Indices are snapshot-local, not permanent event IDs.',...page(items,args,cursor,hash([config,rows]),now)};
    });},
    trends(args){return execute('get_review_difficulty_trends',args,(db,now,cursor)=>{
      const config=windowConfig(db,args,now,14),formatter=dateFormatter(config.timezone),rows=readRows(db,config.root_rem_id);
      const days=(Date.parse(config.end_date)-Date.parse(config.start_date))/86400000+1;
      if(days<2)throw new TypeError('Difficulty trends need at least two study dates.');
      const split=dayOffset(config.start_date,Math.floor(days/2)),minimum=args.min_reviews??3,threshold=args.again_threshold??3,gapDays=args.long_gap_days??7;
      let invalid=0;const items=[];
      for(const row of rows){
        const {card,...state}=cardState(row);delete state.rem;
        const h=history(card,now);invalid+=h.invalid;
        const earlier=counter(),recent=counter(),period=counter(),earlierTiming=timingAccumulator(args),recentTiming=timingAccumulator(args),periodTiming=timingAccumulator(args);let previous=null,gaps=0,lastGap=null;
        for(const e of h.events){
          if(e.isFakeSimulated!==true&&e.score===3)previous=null;
          const inside=inWindow(e,config,formatter),included=selected(e,args),graded=grades.has(e.score)&&e.isFakeSimulated!==true;
          if(inside&&included){
            const isEarlier=studyDate(e.date,config.timezone,config.day_start_hour,formatter)<split;
            addEvent(period,e);addEvent(isEarlier?earlier:recent,e);periodTiming.add(e);(isEarlier?earlierTiming:recentTiming).add(e);
            if(graded&&e.score===0&&previous&&selected(previous,args)&&[1,1.5].includes(previous.score)&&(e.date-previous.date)/86400000>=gapDays){gaps++;lastGap={previous_review_at:iso(previous.date),previous_rating:grades.get(previous.score),again_at:iso(e.date),elapsed_days:(e.date-previous.date)/86400000};}
          }
          // Every real grade, even filtered cram/external events, breaks elapsed gaps.
          if(graded)previous=e;
        }
        if(!period.graded_reviews&&!period.resets)continue;
        const a=rates(earlier),b=rates(recent);let trend='insufficient_reviews';
        const reset=period.resets>0;
        const enough=earlier.graded_reviews>=minimum&&recent.graded_reviews>=minimum;
        const delta=enough&&!reset&&!h.invalid?b.again_share-a.again_share:null;
        if(h.invalid)trend='incomplete_history';else if(reset)trend='reset_in_period';else if(enough)trend=delta<=-.2?'lower_again_share':delta>=.2?'higher_again_share':'similar_again_share';
        const ta=earlierTiming.result(),tb=recentTiming.result();
        items.push({...state,timing:{earlier:ta,recent:tb,period:periodTiming.result(),change:timingChange(ta,tb,minimum,{reset,invalid:h.invalid>0})},earlier:a,recent:b,period:rates(period),trend,again_share_change:delta,repeated_again:period.again>=threshold,again_after_long_gap_count:gaps,last_again_after_long_gap:lastGap,invalid_history_events:h.invalid});
      }
      items.sort((a,b)=>b.period.again-a.period.again||a.card_id.localeCompare(b.card_id));
      return {...metadata(config,now,args,invalid),windows:{earlier:{start_date:config.start_date,end_date:dayOffset(split,-1)},recent:{start_date:split,end_date:config.end_date}},rules:{min_reviews_per_window:minimum,again_threshold:threshold,long_gap_days:gapDays,again_share_change_threshold:0.2,interpretation:'Descriptive rating-share heuristics, not evidence of causation, mastery or retention probability. Counts are shown for both windows. Reset or invalid history suppresses a directional label. Mixed practice modes and external grades are broken out; narrow filters for comparable practice.'},...page(items,args,cursor,hash([config,rows]),now)};
    });},
    compare(args){return execute('compare_study_topics',args,(db,now)=>{
      const config=windowConfig(db,args,now,14),formatter=dateFormatter(config.timezone),seen=new Set(),overlap=new Set();let invalid=0;
      const topics=args.root_rem_ids.map(root=>{
        const rows=readRows(db,root),count=counter(),timed=timingAccumulator(args),studied=new Set();let bad=0,enabled=0,never=0,current=0;
        for(const row of rows){
          if(seen.has(row.card_id))overlap.add(row.card_id);seen.add(row.card_id);
          const state=cardState(row),h=history(state.card,now);bad+=h.invalid;
          // Never graded is lifetime and independent of the selected review filters.
          const hadGrade=h.events.some(e=>grades.has(e.score)&&e.isFakeSimulated!==true);
          if(!state.retired&&!state.orphaned){current++;if(state.enabled){enabled++;if(!hadGrade)never++;}}
          for(const e of h.events)if(inWindow(e,config,formatter)&&selected(e,args)){timed.add(e);if(addEvent(count,e))studied.add(row.card_id);}
        }
        invalid+=bad;
        return {root_rem_id:root,timing:timed.result(),reviews:rates(count),distinct_cards_reviewed:studied.size,current_cards:current,enabled_cards:enabled,enabled_never_graded_cards:never,invalid_history_events:bad};
      });
      return {...metadata(config,now,args,invalid),topics,overlapping_card_count:overlap.size,comparison_notes:'Each topic is evaluated independently in one snapshot. Overlapping outlines must not be summed. Again share is a rating proportion, not a retention score. Small samples and different practice modes limit comparisons. Enabled ignores deck pausing; invalid-event counts are per topic and may overlap.'};
    });},
    forecast(args){return execute('get_study_workload_forecast',args,(db,now)=>{
      const config=configuration(db,args,now),formatter=dateFormatter(config.timezone),days=args.days??7;
      const rows=readRows(db,config.root_rem_id),daily=Array.from({length:days},(_,i)=>({date:dayOffset(config.start_date,i),scheduled_cards:0,never_graded_cards:0}));
      const buckets=new Map(daily.map(d=>[d.date,d]));let enabled=0,overdue=0,overdueNew=0,beyond=0,unknown=0,invalid=0;
      for(const row of rows){
        const state=cardState(row);if(!state.enabled)continue;enabled++;
        const h=history(state.card,now);invalid+=h.invalid;
        const never=!h.events.some(e=>grades.has(e.score)&&e.isFakeSimulated!==true),next=state.card.a;
        if(typeof next!=='number'||!iso(next)){unknown++;continue;}
        if(next<=now){overdue++;if(never)overdueNew++;continue;}
        const date=studyDate(next,config.timezone,config.day_start_hour,formatter),bucket=buckets.get(date);
        if(bucket){bucket.scheduled_cards++;if(never)bucket.never_graded_cards++;}else beyond++;
      }
      return {...metadata({...config,end_date:daily.at(-1).date},now,args,invalid),forecast_kind:'Stored next-schedule candidates only',enabled_cards:enabled,overdue_or_scheduled_now:overdue,overdue_never_graded_cards:overdueNew,daily,scheduled_beyond_horizon:beyond,unknown_schedule_cards:unknown,limitations:'Each enabled card counts once. Overdue cards are separate from daily buckets. Dates start with the current study date. Subsequent reviews can reschedule cards and create repeats. Deck pausing, priorities, daily limits, learn-ahead and unsynced changes are not modeled. This is not the exact queue or a study-time estimate.'};
    });},
  };
}
