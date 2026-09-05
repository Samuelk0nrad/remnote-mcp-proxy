// RemNote 1.28.0: responseTime = answerTime - review start, in milliseconds.
// revealTime is elapsed from that same start, NOT additional time to sum.
const ratings = new Map([[0,'again'],[.5,'hard'],[1,'good'],[1.5,'easy']]);
export const timingProperties = {
  max_review_seconds:{type:'number',exclusiveMinimum:0,maximum:Number.MAX_SAFE_INTEGER/1000,description:'Optional agent-selected upper duration for filtered timing statistics. No default cutoff. Values above it stay visible in raw history and unfiltered statistics; excluded counts and time are reported. Never proves a pause. Use the same threshold across comparisons.'},
};
export function validateTiming(args) {
  const v=args.max_review_seconds;
  if(v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>Number.MAX_SAFE_INTEGER/1000))throw new TypeError('max_review_seconds must be a finite positive number.');
}
export const timingSemantics = {
  measurement:'Recorded elapsed review time, not measured active study. responseTime includes front and back; revealTime is an offset from the same start and must never be added to it.',
  reveal:'The desktop controller stores elapsed time at reveal; hiding/revealing can update this value. Zero may be a default for imported or externally added history. No first-reveal or active front/back split is inferred.',
  summaries:'Timing summaries count real graded outer review events only, after date/mode/external filters. Sub-item times are separate and never added to outer times. Non-graded events remain visible in history and existing event counters.',
  quality:'Unfiltered statistics include finite nonnegative recorded durations, including explicitly counted zeros. Positive-only statistics separate zero/default values. Missing, negative, nonnumeric or unsafe values have no usable duration. Long values are not proof of interruption.',
  quantiles:'Sorted linear interpolation at (n-1)*p (R-7). Empty distributions return null for total and quantiles, not a measured zero.',
  groups:'Rating, practice-mode, origin and multiline groups are independent partitions; do not add across different partitions. No multiline evidence does not establish a basic card. Origin markers are limited to recognized stored flags. Empty groups are omitted; positive-only distributions are reported at the overall level.',
};
function field(value) {
  if(value===undefined||value===null)return 'missing';
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER)return 'invalid';
  return value===0?'zero':'valid';
}
const rawNumber=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
export function eventOrigin(e) {
  if(e.addedExternally===true)return 'externally_added';
  if(e.metadata?.ankiImport===true)return 'anki_import';
  if(e.metadata?.fromNativeMobile===true)return 'native_mobile';
  return 'standard_or_unknown';
}
export function eventTiming(e,args={}) {
  const response=field(e.responseTime),reveal=field(e.revealTime);
  const usable=response==='valid'||response==='zero';
  const exceeds=usable&&args.max_review_seconds!==undefined&&e.responseTime/1000>args.max_review_seconds;
  const flags=[];
  if(response!=='valid')flags.push(`${response}_response_time`);
  if(reveal!=='valid')flags.push(`${reveal}_reveal_time`);
  if(usable&&(reveal==='valid'||reveal==='zero')&&e.revealTime>e.responseTime)flags.push('reveal_exceeds_response');
  if(exceeds)flags.push('exceeds_selected_threshold');
  return {response_time_ms:rawNumber(e.responseTime),reveal_time_ms:rawNumber(e.revealTime),response_time_state:response,reveal_time_state:reveal,recorded_seconds:usable?e.responseTime/1000:null,exceeds_selected_threshold:exceeds,quality_flags:flags};
}
export function subItemReviews(e) {
  if(e.subCardScores===undefined)return {state:'not_recorded',items:[],invalid_items:0};
  if(!Array.isArray(e.subCardScores))return {state:'invalid',items:[],invalid_items:1};
  let invalid=0;
  const items=e.subCardScores.flatMap((item,index)=>{
    if(!item||typeof item.remId!=='string'||!/^([A-Za-z0-9_-]{3,128}|main)$/.test(item.remId)||!Number.isFinite(item.score)){invalid++;return [];}
    return [{index,rem_id:item.remId,score:item.score,rating:ratings.get(item.score)??null,response_time_ms:rawNumber(item.responseTime),response_time_state:field(item.responseTime)}];
  });
  return {state:invalid?'partially_invalid':'recorded',items,invalid_items:invalid,semantics:'Stored per-item scores and response times in milliseconds, in recorded order. Desktop item times run from the previous item score (or review start); a group submission can repeat the same interval for several items. Not independent outer reviews; never sum these times as total study time. IDs may refer to changed or removed items.'};
}
function distribution(values) {
  const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;
  const quantile=p=>{if(!n)return null;const x=(n-1)*p,i=Math.floor(x);return sorted[i]+(sorted[Math.ceil(x)]-sorted[i])*(x-i);};
  const total=n?sorted.reduce((a,b)=>a+b,0):null;
  return {samples:n,recorded_seconds:total,mean_seconds:n?total/n:null,min_seconds:n?sorted[0]:null,q1_seconds:quantile(.25),median_seconds:quantile(.5),q3_seconds:quantile(.75),max_seconds:n?sorted[n-1]:null};
}
function partition(observations,threshold) {
  const valid=observations.filter(o=>o.seconds!==null),positive=valid.filter(o=>o.seconds>0),excluded=threshold===undefined?[]:valid.filter(o=>o.seconds>threshold);
  const result={graded_reviews:observations.length,missing_duration_reviews:observations.filter(o=>o.state==='missing').length,invalid_duration_reviews:observations.filter(o=>o.state==='invalid').length,zero_duration_reviews:valid.length-positive.length,unfiltered:distribution(valid.map(o=>o.seconds)),positive_only:distribution(positive.map(o=>o.seconds)),filtered:threshold===undefined?null:distribution(valid.filter(o=>o.seconds<=threshold).map(o=>o.seconds)),filtered_positive_only:threshold===undefined?null:distribution(positive.filter(o=>o.seconds<=threshold).map(o=>o.seconds)),excluded_by_threshold:{reviews:excluded.length,recorded_seconds:excluded.reduce((s,o)=>s+o.seconds,0)}};
  return result;
}
export function timingAccumulator(args={}) {
  const observations=[];
  return {
    add(e) {
      const rating=e.isFakeSimulated===true?null:ratings.get(e.score);if(!rating)return;
      const t=eventTiming(e,args);
      observations.push({seconds:t.recorded_seconds,state:t.response_time_state,rating,mode:e.isCram===true?'cram':e.isCram===false?'regular':'unknown',origin:eventOrigin(e),structure:Array.isArray(e.subCardScores)||typeof e.isFullMultiLineRep==='boolean'?'multiline':'no_multiline_evidence'});
    },
    result() {
      const group=(key,values)=>Object.fromEntries(values.flatMap(value=>{
        const selected=observations.filter(o=>o[key]===value);if(!selected.length)return [];
        const {positive_only,filtered_positive_only,...summary}=partition(selected,args.max_review_seconds);
        return [[value,summary]];
      }));
      return {max_review_seconds:args.max_review_seconds??null,...partition(observations,args.max_review_seconds),by_rating:group('rating',['again','hard','good','easy']),by_practice_mode:group('mode',['regular','cram','unknown']),by_origin:group('origin',['standard_or_unknown','externally_added','anki_import','native_mobile']),by_structure:group('structure',['multiline','no_multiline_evidence'])};
    },
  };
}
export function timingChange(earlier,recent,minimum,{reset=false,invalid=false}={}) {
  const compare=(a,b)=>{
    const status=invalid?'incomplete_history':reset?'reset_in_period':a.samples<minimum||b.samples<minimum?'insufficient_timed_reviews':'available';
    return {status,earlier_samples:a.samples,recent_samples:b.samples,median_seconds_change:status==='available'?b.median_seconds-a.median_seconds:null,median_ratio:status==='available'&&a.median_seconds>0?b.median_seconds/a.median_seconds:null};
  };
  return {unfiltered:compare(earlier.unfiltered,recent.unfiltered),positive_only:compare(earlier.positive_only,recent.positive_only),filtered:earlier.filtered?compare(earlier.filtered,recent.filtered):null,filtered_positive_only:earlier.filtered_positive_only?compare(earlier.filtered_positive_only,recent.filtered_positive_only):null,interpretation:'Descriptive elapsed-time change, not proof of improved recall or active effort. Check timing quality, rating mix and multiline/origin groups.'};
}
