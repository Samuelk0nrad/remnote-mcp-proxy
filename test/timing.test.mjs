import test from 'node:test';
import assert from 'node:assert/strict';
import {timingAccumulator,eventTiming,subItemReviews,validateTiming} from '../src/timing.mjs';

test('timing retains long and zero observations; threshold does not clip or silently replace raw totals',()=>{
 const a=timingAccumulator({max_review_seconds:10});
 for(const responseTime of [0,1000,9000,10000,3600000,-1,undefined,'500'])a.add({score:1,responseTime,revealTime:500});
 a.add({score:.01,responseTime:100000});a.add({score:1,isFakeSimulated:true,responseTime:100000});
 const r=a.result();assert.equal(r.graded_reviews,8);assert.equal(r.unfiltered.samples,5);assert.equal(r.unfiltered.recorded_seconds,3620);assert.equal(r.unfiltered.median_seconds,9);
 assert.equal(r.filtered.recorded_seconds,20);assert.equal(r.filtered.samples,4);assert.equal(r.excluded_by_threshold.reviews,1);assert.equal(r.excluded_by_threshold.recorded_seconds,3600);
 assert.equal(r.positive_only.samples,4);assert.equal(r.zero_duration_reviews,1);assert.equal(r.invalid_duration_reviews,2);assert.equal(r.missing_duration_reviews,1);
 assert.equal(r.filtered_positive_only.median_seconds,9);assert.equal(r.by_rating.good.unfiltered.recorded_seconds,3620);
});
test('no cutoff, missing samples and quantile convention are explicit',()=>{
 const a=timingAccumulator();a.add({score:1});let r=a.result();assert.equal(r.filtered,null);assert.equal(r.unfiltered.recorded_seconds,null);assert.equal(r.unfiltered.median_seconds,null);assert.equal(r.max_review_seconds,null);
 for(const seconds of [1,2,3,4])a.add({score:1,responseTime:seconds*1000});r=a.result();assert.equal(r.unfiltered.q1_seconds,1.75);assert.equal(r.unfiltered.median_seconds,2.5);assert.equal(r.unfiltered.q3_seconds,3.25);
});
test('raw timings and independent reveal quality are preserved without adding reveal time',()=>{
 const t=eventTiming({responseTime:10000,revealTime:8000},{max_review_seconds:9.5});assert.equal(t.recorded_seconds,10);assert.equal(t.reveal_time_ms,8000);assert.equal(t.exceeds_selected_threshold,true);
 assert.ok(eventTiming({responseTime:1000,revealTime:2000}).quality_flags.includes('reveal_exceeds_response'));
 const bad=eventTiming({responseTime:-7,revealTime:null});assert.equal(bad.response_time_ms,-7);assert.equal(bad.recorded_seconds,null);assert.equal(bad.reveal_time_state,'missing');
 assert.equal(eventTiming({responseTime:Number.MAX_SAFE_INTEGER+1}).response_time_state,'invalid');
 for(const v of [0,-1,'10',null,Infinity,NaN,Number.MAX_SAFE_INTEGER])assert.throws(()=>validateTiming({max_review_seconds:v}));validateTiming({max_review_seconds:.5});validateTiming({});
});
test('multiline item scores have safe fields and never become extra timed reviews',()=>{
 const e={score:.5,responseTime:20000,subCardScores:[{remId:'itemAlpha',score:0,responseTime:12000,answer:'private'},{remId:'itemBeta',score:1,responseTime:12000},{remId:'itemBad',score:'bad'},7],metadata:{secret:'private'}};
 const r=subItemReviews(e);assert.equal(r.items.length,2);assert.equal(r.invalid_items,2);assert.equal(r.items[0].rating,'again');assert.equal(r.items[1].response_time_ms,12000);assert.equal(JSON.stringify(r).includes('private'),false);
 const a=timingAccumulator();a.add(e);assert.equal(a.result().unfiltered.recorded_seconds,20);assert.equal(a.result().by_structure.multiline.graded_reviews,1);
});
test('timing groups distinguish rating, practice mode and known origin markers',()=>{
 const a=timingAccumulator();for(const e of [{score:0,isCram:true},{score:.5,addedExternally:true},{score:1,metadata:{ankiImport:true}},{score:1.5,metadata:{fromNativeMobile:true}}])a.add({...e,responseTime:1000});
 const r=a.result();assert.equal(r.by_rating.again.unfiltered.samples,1);assert.equal(r.by_origin.anki_import.unfiltered.recorded_seconds,1);assert.equal(r.by_origin.externally_added.graded_reviews,1);assert.equal(r.by_practice_mode.cram.graded_reviews,1);
});
