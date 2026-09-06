import {imageEntries} from './images.mjs';
import {createHash} from 'node:crypto';
import {plainText,strictArgs} from './flashcards.mjs';
import {cardLabels,readLeechThreshold,STATUS_ADAPTER} from './card-status.mjs';
import {configuration,counter,addEvent,studyDate,dateFormatter} from './workload.mjs';
import {timingAccumulator,timingProperties,validateTiming,timingSemantics} from './timing.mjs';

const types=['basic','multiline','multiple_choice','other'];
const directions=['forward','backward','both','none','unknown'];
const labels=['leech','struggling','disabled','enabled','edit_later','new','not_yet_learned','stale'];
const numericFields=['image_count','review_count','again_count','hard_count','good_count','easy_count','again_share','hard_share','good_share','easy_share','recorded_review_seconds','median_review_seconds','recorded_reveal_seconds','median_reveal_seconds','timed_reviews','reveal_timed_reviews','filtered_review_seconds','filtered_median_review_seconds','filtered_reveal_seconds','filtered_median_reveal_seconds','practice_card_count'];
const dateFields=['created_at','updated_at','last_review_at','next_review_at'];
const sortFields=['front','type','direction',...dateFields,...numericFields];
const strings=(values,max=20)=>({type:'array',minItems:1,maxItems:max,uniqueItems:true,items:{type:'string',enum:values}});
const range={type:'object',additionalProperties:false,properties:{min:{type:'number',minimum:0},max:{type:'number',minimum:0}},minProperties:1};
const dateRange={type:'object',additionalProperties:false,properties:{min:{type:'string',format:'date-time'},max:{type:'string',format:'date-time'}},minProperties:1,description:'Inclusive ISO timestamps with explicit timezone. Unknown dates never match.'};
const filterProperties={has_images:{type:'boolean',description:'Images on stored front/back and marked answer items; excludes unmarked context notes and occlusion masks.'},types:strings(types),directions:strings(directions),enabled:{type:'boolean',description:'True means at least one included practice card is enabled; false means none. Does not account for deck pausing.'},labels_any:strings(labels),labels_all:strings(labels),...Object.fromEntries(numericFields.map(k=>[k,range])),...Object.fromEntries(dateFields.map(k=>[k,dateRange]))};
export const LIST_FLASHCARD_TOOL={
 name:'list_flashcards',description:'Read-only search, filter and rank flashcards across a knowledge base or topic outline, including question/answer content and marked child answers. One result per question Rem, with practice-card directions grouped underneath and statistics summed across included practice cards. Filters combine with AND; arrays within a field use OR, except labels_all. Sort across ALL matches before cursor pagination. Supports has_images/image_count, content/type/direction/state/labels, dates, review counts/rating shares and separate response/reveal timing. Missing metrics are null, sort last and do not match numeric ranges. Default period is all retained history; retired rows excluded unless include_retired=true. Database snapshot only: read_flashcard supplies a fresh SDK revision before edits. Other/unsupported structures remain visible as type other. No writes.',
 inputSchema:{type:'object',additionalProperties:false,properties:{
  root_rem_id:{type:'string',pattern:'^[A-Za-z0-9_-]{3,128}$',description:'Exact topic or heading Rem ID. Omit to search the knowledge base. Parent links only; no portal/tag expansion.'},
  include_descendants:{type:'boolean',default:true,description:'False limits scope to the root and its direct children; true includes the full outline.'},
  include_retired:{type:'boolean',default:false,description:'Include retained retired practice-card rows in membership and statistics. Orphaned rows without a question Rem are excluded.'},
  search:{type:'object',additionalProperties:false,properties:{text:{type:'string',minLength:1,maxLength:500},in:strings(['front','back','answer_items'],3)},required:['text'],description:'Case-insensitive literal substring search in full stored text before output truncation. Defaults to all three fields.'},
  filters:{type:'object',additionalProperties:false,properties:filterProperties},
  period:{type:'object',additionalProperties:false,properties:{timezone:{type:'string'},start_date:{type:'string'},end_date:{type:'string'},day_start_hour:{type:'integer',minimum:0,maximum:23}},required:['timezone','start_date'],description:'Optional inclusive study-date window, max 366 days. Omit for all retained history. Uses the configured study-day boundary unless overridden.'},
  ...timingProperties,
  sort:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,properties:{field:{type:'string',enum:sortFields},order:{type:'string',enum:['asc','desc']}},required:['field','order']},description:'Ordered sort keys; default front ascending. Null always last; Rem ID breaks ties.'},
  limit:{type:'integer',minimum:1,maximum:50,default:20},cursor:{type:'string',maxLength:2048},
  include_content:{type:'boolean',default:true,description:'False omits front/back/answer text from results but still searches and ranks on full stored text.'},
  content_limit:{type:'integer',minimum:100,maximum:20000,default:4000,description:'Per-result character budget for front/back/child answers; content_truncated explicitly reports clipping. Search always uses full content.'},
 },required:[]},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const bool=v=>v===true||v===1;
const power=(rem,code)=>bool(rem?.apu?.[code]?.v);
const timestamp=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=8640000000000000?v:null;
const iso=v=>v===null?null:new Date(v).toISOString();
const text=v=>plainText(Array.isArray(v)?v:typeof v==='string'?[v]:[]);
const normalized=v=>v.normalize('NFC').toLowerCase();
function choices(value,allowed){if(!Array.isArray(value)||!value.length||value.length>20||value.some(v=>!allowed.includes(v))||new Set(value).size!==value.length)throw new TypeError('Invalid filter alternatives.');}
function validate(args){
 strictArgs(args,Object.keys(LIST_FLASHCARD_TOOL.inputSchema.properties));validateTiming(args);
 if(args.root_rem_id!==undefined&&(typeof args.root_rem_id!=='string'||!/^[A-Za-z0-9_-]{3,128}$/.test(args.root_rem_id)))throw new TypeError('Invalid root_rem_id.');
 for(const key of ['include_descendants','include_retired','include_content'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new TypeError(`${key} must be boolean.`);
 for(const [key,min,max]of [['limit',1,50],['content_limit',100,20000]])if(args[key]!==undefined&&(!Number.isInteger(args[key])||args[key]<min||args[key]>max))throw new TypeError(`Invalid ${key}.`);
 if(args.search!==undefined){strictArgs(args.search,['text','in'],['text']);if(typeof args.search.text!=='string'||!args.search.text.trim()||args.search.text.length>500)throw new TypeError('Search text must be nonblank, at most 500 characters.');if(args.search.in!==undefined)choices(args.search.in,['front','back','answer_items']);}
 if(args.period!==undefined)strictArgs(args.period,['timezone','start_date','end_date','day_start_hour'],['timezone','start_date']);
 if(args.filters!==undefined){
  strictArgs(args.filters,Object.keys(filterProperties));
  for(const [key,values]of [['types',types],['directions',directions],['labels_any',labels],['labels_all',labels]])if(args.filters[key]!==undefined)choices(args.filters[key],values);
  if(args.filters.has_images!==undefined&&typeof args.filters.has_images!=='boolean')throw new TypeError('has_images must be boolean.');
  if(args.filters.enabled!==undefined&&typeof args.filters.enabled!=='boolean')throw new TypeError('enabled must be boolean.');
  for(const key of [...numericFields,...dateFields])if(args.filters[key]!==undefined){
   const value=args.filters[key];strictArgs(value,['min','max']);if(!Object.keys(value).length)throw new TypeError('Empty range.');
   for(const bound of Object.values(value)){
    if(dateFields.includes(key)){if(typeof bound!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(bound)||!Number.isFinite(Date.parse(bound))||new Date(Date.parse(bound.slice(0,10))).toISOString().slice(0,10)!==bound.slice(0,10))throw new TypeError('Use an ISO timestamp with timezone for date bounds.');}
    else if(typeof bound!=='number'||!Number.isFinite(bound)||bound<0||(key.endsWith('_share')&&bound>1))throw new TypeError('Invalid numeric range.');
   }
   const convert=v=>dateFields.includes(key)?Date.parse(v):v;
   if(value.min!==undefined&&value.max!==undefined&&convert(value.min)>convert(value.max))throw new TypeError('Range minimum exceeds maximum.');
  }
 }
 if(args.sort!==undefined){if(!Array.isArray(args.sort)||!args.sort.length||args.sort.length>3)throw new TypeError('Use 1-3 sort fields.');for(const s of args.sort){strictArgs(s,['field','order'],['field','order']);if(!sortFields.includes(s.field)||!['asc','desc'].includes(s.order))throw new TypeError('Invalid sort key.');}if(new Set(args.sort.map(s=>s.field)).size!==args.sort.length)throw new TypeError('Duplicate sort key.');}
 if(args.cursor!==undefined&&(typeof args.cursor!=='string'||args.cursor.length>2048))throw new TypeError('Invalid cursor.');
}
function metrics(count,timing){return {review_count:count.graded_reviews,...Object.fromEntries(['again','hard','good','easy'].flatMap(k=>[[`${k}_count`,count[k]],[`${k}_share`,count.graded_reviews?count[k]/count.graded_reviews:null]])),recorded_review_seconds:timing.unfiltered.recorded_seconds,median_review_seconds:timing.unfiltered.median_seconds,recorded_reveal_seconds:timing.reveal.unfiltered.recorded_seconds,median_reveal_seconds:timing.reveal.unfiltered.median_seconds,timed_reviews:timing.unfiltered.samples,reveal_timed_reviews:timing.reveal.unfiltered.samples,filtered_review_seconds:timing.filtered?.recorded_seconds??null,filtered_median_review_seconds:timing.filtered?.median_seconds??null,filtered_reveal_seconds:timing.reveal.filtered?.recorded_seconds??null,filtered_median_reveal_seconds:timing.reveal.filtered?.median_seconds??null};}
function content(rem,children){
 let visited=0,imageCount=imageEntries(rem.key,rem._id,'front').length+imageEntries(rem.value,rem._id,'back').length;
 const seen=new Set([rem._id]);
 function answers(id,depth){
  if(depth>16)throw new Error('Answer tree exceeds safe depth; narrow or inspect it separately.');
  return (children.get(id)??[]).filter(child=>power(child,'w')).map(child=>{
   if(seen.has(child._id)||++visited>1000)throw new Error('Cyclic or excessive marked-answer tree.');seen.add(child._id);
   imageCount+=imageEntries(child.key,child._id,'front').length+imageEntries(child.value,child._id,'back').length;
   return {rem_id:child._id,text:text(child.key),back:text(child.value),children:answers(child._id,depth+1)};
  });
 }
 const answer_items=answers(rem._id,0);return {front:text(rem.key),back:text(rem.value),answer_items,image_count:imageCount};
}
function answerText(items){return items.map(item=>[item.text,item.back,answerText(item.children)].join('\n')).join('\n');}
function projectContent(full,limit){
 let remaining=limit,truncated=false;
 const clip=value=>{if(value.length>remaining){truncated=true;const result=value.slice(0,remaining);remaining=0;return result;}remaining-=value.length;return value;};
 const front=clip(full.front),back=clip(full.back);
 const walk=items=>items.map(({text,back,children,...rest})=>({...rest,text:clip(text),back:clip(back),children:walk(children)}));
 const answer_items=walk(full.answer_items);
 return {front,back,answer_items,content_truncated:truncated};
}
function match(item,args){
 const filters=args.filters??{};
 if(filters.has_images!==undefined&&filters.has_images!==item.has_images)return false;
 if(filters.types&&!filters.types.includes(item.type)||filters.directions&&!filters.directions.includes(item.direction)||filters.enabled!==undefined&&filters.enabled!==item.enabled)return false;
 if(filters.labels_any&&!filters.labels_any.some(k=>item.labels[k]))return false;
 if(filters.labels_all&&!filters.labels_all.every(k=>item.labels[k]))return false;
 for(const key of [...numericFields,...dateFields])if(filters[key]){
  const value=dateFields.includes(key)?item[key]===null?null:Date.parse(item[key]):item.metrics[key];
  if(value===null||value===undefined)return false;
  for(const [bound,v]of Object.entries(filters[key])){const n=dateFields.includes(key)?Date.parse(v):v;if(bound==='min'?value<n:value>n)return false;}
 }
 if(args.search){const needle=normalized(args.search.text);if(!(args.search.in??['front','back','answer_items']).some(field=>normalized(field==='answer_items'?answerText(item.content.answer_items):item.content[field]).includes(needle)))return false;}
 return true;
}
export function createFlashcardListing(repository,verifyAdapter){
 return {async list(args){
  validate(args);await verifyAdapter();
  const query=hash({...args,cursor:undefined,limit:undefined});let cursor;
  if(args.cursor!==undefined){try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{throw new TypeError('Invalid cursor.');}if(!cursor||cursor.query!==query||!Number.isInteger(cursor.offset)||cursor.offset<0||!Number.isFinite(cursor.now)||cursor.now<0||cursor.now>Date.now()||typeof cursor.snapshot!=='string')throw new TypeError('Cursor does not belong to this query.');}
  return repository.withDatabase(db=>{db.exec('BEGIN');try{
   const now=cursor?.now??Date.now(),config=args.period?configuration(db,args.period,now):null,formatter=config?dateFormatter(config.timezone):null;
   const rawRems=db.prepare('SELECT _id,doc FROM quanta ORDER BY _id').all();
   const rawCards=db.prepare('SELECT _id,doc FROM cards ORDER BY _id').all();
   const threshold=readLeechThreshold(db);
   const snapshot=hash([config,threshold,rawRems,rawCards]);
   if(cursor&&cursor.snapshot!==snapshot)throw new Error('Card data changed between pages. Restart without cursor.');
   const rems=new Map(rawRems.map(row=>[row._id,{...JSON.parse(row.doc),_id:row._id}])),children=new Map();
   for(const rem of rems.values())if(rem.parent){if(!children.has(rem.parent))children.set(rem.parent,[]);children.get(rem.parent).push(rem);}
   for(const items of children.values())items.sort((a,b)=>typeof a.f==='string'&&typeof b.f==='string'?(a.f<b.f?-1:a.f>b.f?1:a._id.localeCompare(b._id)):a._id.localeCompare(b._id));
   let scope;
   if(args.root_rem_id){if(!rems.has(args.root_rem_id))throw new Error('Topic Rem is missing in the synced database.');scope=new Set([args.root_rem_id]);const queue=[args.root_rem_id];for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])??[]){if(scope.has(child._id))continue;scope.add(child._id);if(args.include_descendants!==false)queue.push(child._id);}}
   const grouped=new Map();let orphaned=0,retiredExcluded=0;
   for(const row of rawCards){const card=JSON.parse(row.doc),rem=rems.get(card.rId);if(!rem){orphaned++;continue;}if(scope&&!scope.has(rem._id))continue;const retired=!!card.b&&!power(rem,'e');if(retired&&!args.include_retired){retiredExcluded++;continue;}if(!grouped.has(rem._id))grouped.set(rem._id,[]);grouped.get(rem._id).push({...card,_id:row._id,retired});}
   const items=[];let invalidEvents=0;
   for(const [id,cards]of grouped){
    const rem=rems.get(id),full=content(rem,children),counts=counter(),timed=timingAccumulator(args),practice=[];
    let last=null,next=null,bad=0;
    for(const card of cards){
     if(card.h!==undefined&&!Array.isArray(card.h))throw new Error('Unsupported review-history shape.');
     const local=counter(),localTiming=timingAccumulator(args);let lastLocal=null;
     
     for(const event of card.h??[]){
      if(!event||typeof event.score!=='number'||!Number.isFinite(event.score)||timestamp(event.date)===null||event.date>now){bad++;continue;}
      const all=counter();const graded=addEvent(all,event);if(graded){lastLocal=lastLocal===null?event.date:Math.max(lastLocal,event.date);last=last===null?event.date:Math.max(last,event.date);}
      const day=config?studyDate(event.date,config.timezone,config.day_start_hour,formatter):null;
      if(config&&(day<config.start_date||day>config.end_date))continue;
      addEvent(local,event);addEvent(counts,event);timed.add(event);localTiming.add(event);
     }
     const labelEvents=(card.h??[]).filter(e=>e&&typeof e.score==='number'&&Number.isFinite(e.score));
     const derived=cardLabels({...card,h:labelEvents},rem,threshold.value,now);
     if(labelEvents.length!==(card.h??[]).length)for(const name of ['leech','struggling','new','stale'])derived.labels[name]=null;
     const enabled=!!card.a&&!card.retired;derived.labels.enabled=enabled;if(card.retired)derived.labels.disabled=false;
     const scheduled=timestamp(card.n);if(scheduled!==null)next=next===null?scheduled:Math.min(next,scheduled);
     practice.push({card_id:card._id,stored_type_code:card.c??null,direction:card.c==='f'?'forward':card.c==='b'?'backward':'other',enabled,retired:card.retired,labels:derived.labels,last_review_at:iso(lastLocal),next_review_at:iso(scheduled),metrics:metrics(local,localTiming.result())});
    }
    invalidEvents+=bad;const timing=timed.result();
    const kind=power(rem,'mc')?'multiple_choice':full.answer_items.length?'multiline':cards.every(c=>['f','b'].includes(c.c))&&Array.isArray(rem.value)?'basic':'other';
    const direction=cards.some(c=>!['f','b'].includes(c.c))?'unknown':bool(rem.efc)?bool(rem.enableBackSR)?'backward':'none':bool(rem.enableBackSR)?'both':'forward';
    const location=[];let ancestor=rem.parent;const seen=new Set([id]);
    while(ancestor&&rems.has(ancestor)){if(seen.has(ancestor)||location.length>=100)throw new Error('Cyclic or excessive outline ancestry.');seen.add(ancestor);const parent=rems.get(ancestor);location.unshift({rem_id:ancestor,title:text(parent.key).slice(0,500)});ancestor=parent.parent;}
    const item={rem_id:id,has_images:full.image_count>0,image_count:full.image_count,parent_rem_id:rem.parent??null,type:kind,direction,enabled:practice.some(c=>c.enabled),enabled_all:practice.every(c=>c.enabled),labels:Object.fromEntries(labels.map(k=>[k,practice.some(c=>c.labels[k]===true)?true:practice.some(c=>c.labels[k]===null)?null:false])),created_at:iso(timestamp(rem.createdAt)),updated_at:iso(timestamp(rem.u)),last_review_at:iso(last),next_review_at:iso(next),metrics:{...metrics(counts,timing),image_count:full.image_count,practice_card_count:practice.length},review_events:counts,timing,invalid_history_events:bad,practice_cards:practice,location,content:full};
    if(match(item,args))items.push(item);
   }
   const sort=args.sort??[{field:'front',order:'asc'}];
   const value=(item,field)=>field==='front'?item.content.front:numericFields.includes(field)?item.metrics[field]:dateFields.includes(field)?item[field]===null?null:Date.parse(item[field]):item[field];
   items.sort((a,b)=>{for(const {field,order}of sort){const av=value(a,field),bv=value(b,field);if(av===null&&bv===null)continue;if(av===null)return 1;if(bv===null)return -1;const compare=av<bv?-1:av>bv?1:0;if(compare)return order==='desc'?-compare:compare;}return a.rem_id<b.rem_id?-1:a.rem_id>b.rem_id?1:0;});
   const offset=cursor?.offset??0,limit=args.limit??20,page=items.slice(offset,offset+limit).map(({content,...item})=>({...item,...(args.include_content===false?{}:projectContent(content,args.content_limit??4000))}));
   const more=offset+page.length<items.length;
   return {items:page,count:page.length,total:items.length,has_more:more,next_cursor:more?Buffer.from(JSON.stringify({offset:offset+page.length,snapshot,now,query})).toString('base64url'):null,as_of:new Date(now).toISOString(),period:config??{scope:'all_retained_history'},sort,adapter:STATUS_ADAPTER,leech_threshold:threshold,timing_semantics:timingSemantics,coverage:{source:'Read-only local synced database snapshot; not live SDK state or rendered practice.',grouping:'One question Rem per row. Metrics sum included practice-card histories; directions remain separately inspectable. Labels are ANY included practice direction; enabled_all is separate.',history:args.include_retired?'Retained current and retired practice rows included.':'Retired rows excluded from both membership and metrics. Include them explicitly for retained historical workload.',scope:'Parent-linked outline only. No portal/tag expansion. Orphan counts are knowledge-base-wide.',orphaned_practice_rows_excluded:orphaned,retired_practice_rows_excluded:retiredExcluded,invalid_history_events:invalidEvents,complete_retained_history:invalidEvents===0,schedule:'next_review_at is the earliest stored schedule among included practice rows, including disabled ones. It is not the native queue or workload forecast.',content:'Stored inline sides and marked child answers, never a practice preview. Other structures remain visible as type other. Read read_flashcard for an SDK revision before editing.',dates:'created_at is Rem creation; updated_at is the synced Rem update timestamp. Last graded review is lifetime, independent of the selected metric period.'}};
  }finally{db.exec('COMMIT');}});
 }};
}
