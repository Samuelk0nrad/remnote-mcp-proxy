// Read-only parity checks; outputs counts/booleans, never question or answer text.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createFlashcardListing} from '../src/list-flashcards.mjs';
import {createAdapterVerifier} from '../src/card-status.mjs';
import {createWorkloadService} from '../src/workload.mjs';
import {createFlashcardService} from '../src/flashcards.mjs';
import {EditLaterRepository,createRuntimeMcpRunner} from '../src/server.mjs';
if(!process.env.REMNOTE_DB)throw new Error('REMNOTE_DB is required.');
const repository=new EditLaterRepository(process.env.REMNOTE_DB);
const auth=JSON.parse(await readFile(path.join(os.homedir(),'.remnote-agent/auth.json'),'utf8'));
const run=createRuntimeMcpRunner({token:auth.httpToken});
const verify=createAdapterVerifier(process.env.REMNOTE_APP_ASAR??'/opt/remnote/app/resources/app.asar');
const local=createFlashcardListing(repository,verify),workload=createWorkloadService(repository,run,verify),reader=createFlashcardService(run,repository,'read-only-verification');
const config=process.env.MCP_PROXY_URL?JSON.parse(await readFile(path.join(os.homedir(),'.config/RemNote/config.json'),'utf8')):null;
async function list(args){if(!config)return local.list(args);const rpc=await(await fetch(process.env.MCP_PROXY_URL,{method:'POST',headers:{authorization:`Bearer ${config.remNoteMcpAccessToken}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'verify-list',method:'tools/call',params:{name:'list_flashcards',arguments:args}}),signal:AbortSignal.timeout(60000)})).json();if(rpc.error||rpc.result?.isError)throw new Error(rpc.error?.data?.message??'Listing failed');assert.ok(rpc.result?.structuredContent);return rpc.result.structuredContent;}
const period={timezone:'UTC',start_date:new Date(Date.now()-13*86400000).toISOString().slice(0,10),end_date:new Date().toISOString().slice(0,10),day_start_hour:0};
const args={include_retired:true,include_content:false,period,limit:50,sort:[{field:'recorded_review_seconds',order:'desc'}]};
const all=[];let cursor;do{const r=await list({...args,...(cursor?{cursor}:{})});all.push(...r.items);cursor=r.next_cursor;}while(cursor);
assert.equal(new Set(all.map(i=>i.rem_id)).size,all.length);
let sawNull=false,previous=Infinity;for(const item of all){const value=item.metrics.recorded_review_seconds;if(value===null)sawNull=true;else{assert.equal(sawNull,false);assert.ok(value<=previous);previous=value;}}
const summary=await workload.summary({...period});
// Orphaned rows cannot have question content, so exclude them from parity totals.
const stats=[];let statsCursor;do{const r=await workload.list({...period,limit:100,...(statsCursor?{cursor:statsCursor}:{})});stats.push(...r.items.filter(i=>!i.orphaned));statsCursor=r.next_cursor;}while(statsCursor);
assert.equal(all.reduce((n,i)=>n+i.metrics.review_count,0),stats.reduce((n,i)=>n+i.period.graded_reviews,0));
for(const [field,get]of [['recorded_review_seconds',s=>s.timing.period.unfiltered.recorded_seconds],['recorded_reveal_seconds',s=>s.timing.period.reveal.unfiltered.recorded_seconds]])assert.ok(Math.abs(all.reduce((n,i)=>n+(i.metrics[field]??0),0)-stats.reduce((n,i)=>n+(get(i)??0),0))<0.00001);
const sample=await list({limit:8,content_limit:20000,sort:[{field:'updated_at',order:'desc'}]});let compared=0;
for(const item of sample.items){
 const read=await reader.read(item.rem_id);if(!item.content_truncated){assert.equal(item.front,read.front);assert.equal(item.back,read.back);}
 assert.equal(item.parent_rem_id,read.parent_rem_id);
 assert.equal(item.updated_at,read.updated_at==null?null:new Date(read.updated_at).toISOString());
 if(item.type!=='other')assert.equal(item.direction,read.practice_direction);
 if(read.answer_inspection.inspected){assert.deepEqual(item.answer_items.map(i=>i.rem_id),read.answer_items.map(i=>i.rem_id));}
 compared++;
}
console.log(JSON.stringify({verified:true,question_rems:all.length,practice_rows:stats.length,graded_reviews:all.reduce((n,i)=>n+i.metrics.review_count,0),period_timing_parity:true,rank_before_pagination:true,unique_question_rows:true,live_sdk_samples:compared,source_inventory_cards:summary.inventory.stored_card_rows}));
