// Updates only disposable cards created by this script, never existing user cards.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CreationJournal} from '../src/create-flashcards.mjs';
import {createRuntimeMcpRunner,createMcpHandler,EditLaterRepository} from '../src/server.mjs';
if(!process.env.REMNOTE_DB)throw new Error('REMNOTE_DB required.');
const config=JSON.parse(await readFile(path.join(os.homedir(),'.config/RemNote/config.json'),'utf8'));
const auth=JSON.parse(await readFile(path.join(os.homedir(),'.remnote-agent/auth.json'),'utf8'));
const run=createRuntimeMcpRunner({token:auth.httpToken});
const dir=await mkdtemp(path.join(os.tmpdir(),'remnote-update-smoke-')),journal=new CreationJournal(path.join(dir,'requests.sqlite'));
const repo=new EditLaterRepository(process.env.REMNOTE_DB),created=new Set();
const handler=createMcpHandler({expectedToken:config.remNoteMcpAccessToken,upstreamUrl:'http://127.0.0.1:7788/mcp',repository:repo,runtimeMcpRunner:run,creationJournal:journal,logger:{error(){}}});
const rem=(operation,remId,more={})=>run('remnote_rem',{operation,remId,...more});
async function call(name,args){
 const body=JSON.stringify({jsonrpc:'2.0',id:'update-smoke',method:'tools/call',params:{name,arguments:args}});let rpc;
 if(process.env.MCP_PROXY_URL)rpc=await(await fetch(process.env.MCP_PROXY_URL,{method:'POST',headers:{authorization:`Bearer ${config.remNoteMcpAccessToken}`,'content-type':'application/json'},body,signal:AbortSignal.timeout(60000)})).json();
 else await handler({url:'/mcp',method:'POST',headers:{authorization:`Bearer ${config.remNoteMcpAccessToken}`},async *[Symbol.asyncIterator](){yield Buffer.from(body);}},{writeHead(){return this;},end(value){rpc=JSON.parse(value);}});
 const value=rpc.result?.structuredContent;for(const id of value?.created_rem_ids??[])created.add(id);
 if(rpc.error||rpc.result?.isError||!value)throw new Error(rpc.error?.data?.message??value?.message??'Missing tool result');return value;
}
async function fixture(text,parentRemId){const id=(await rem('create_single_markdown',undefined,{markdown:`[MCP-TEST] ${text}`,parentRemId})).rem?.remId;assert.ok(id);created.add(id);return id;}
async function read(id){for(let i=0;i<4;i++){try{return await call('read_flashcard',{rem_id:id});}catch(e){if(i===3||!/changed while reading/.test(e.message))throw e;await new Promise(r=>setTimeout(r,100));}}}
async function update(rem_id, fields){const args={rem_id,expected_revision:(await read(rem_id)).revision,request_id:randomUUID(),...fields};const result=await call('update_flashcard',args);assert.equal(result.verified,true,result.message);return {result,args};}
try{
 const root=await fixture('typed update root');await rem('set_document',root,{value:true});
 const made=await call('create_flashcards',{parent_rem_id:root,cards:[{type:'basic',front:'[MCP-TEST] Basic question',back:'Old answer',notes:['Source']},{type:'multiline',front:'[MCP-TEST] Steps?',back:{items:[{text:'One'},{text:'Two'}]},notes:['Context']}],request_id:randomUUID()});
 const [basic,multi]=made.cards,practiceIds=made.cards.flatMap(c=>c.card_ids);
 for(let i=0;i<30&&repo.cardHistorySnapshot(practiceIds).length!==practiceIds.length;i++)await new Promise(r=>setTimeout(r,100));
 const history=repo.cardHistorySnapshot(practiceIds),schedule=repo.cardScheduleSnapshot(practiceIds);
 const edited=await update(basic.rem_id,{type:'basic',back:'New → literal ↔ answer',notes:['Updated source','Extra context']});
 assert.equal(edited.result.card.front,'[MCP-TEST] Basic question');assert.equal(edited.result.card.back,'New → literal ↔ answer');assert.equal((await call('update_flashcard',edited.args)).replayed,true);
 const changed=await update(multi.rem_id,{type:'multiline',front:'[MCP-TEST] Updated steps?',back:{items:[{text:'First'},{text:'Second'}]}});
 assert.deepEqual(changed.result.card.answer_items.map(c=>c.rem_id),multi.answer_item_rem_ids);
 const [one,two]=multi.answer_item_rem_ids;
 const reordered=await update(multi.rem_id,{type:'multiline',back:{items:[{rem_id:two,text:'Second'},{text:'Third'},{rem_id:one,text:'First'}]}});
 assert.deepEqual(reordered.result.card.answer_items.map(c=>c.front_rich_text[0]),['Second','Third','First']);
 const third=reordered.result.created_rem_ids[0];
 const removed=await update(multi.rem_id,{type:'multiline',back:{items:[{rem_id:two,text:'Second'},{rem_id:one,text:'First'}]},delete_item_rem_ids:[third]});assert.equal(removed.result.deleted_rem_ids[0],third);
 assert.deepEqual(repo.cardHistorySnapshot(practiceIds),history);assert.deepEqual(repo.cardScheduleSnapshot(practiceIds),schedule);
 for(const direction of ['both','backward','forward']){const r=await update(basic.rem_id,{type:'basic',direction});assert.equal(r.result.card.practice_direction,direction);assert.equal(r.result.spaced_repetition.history_verified,true);}
 const stale={rem_id:basic.rem_id,expected_revision:(await read(basic.rem_id)).revision,type:'basic',notes:['Replacement','Extra context'],request_id:randomUUID()};
 await rem('set_text',basic.note_rem_ids[0],{richText:['Concurrent source edit']});await assert.rejects(()=>call('update_flashcard',stale),/Revision conflict/);
 await assert.rejects(()=>update(multi.rem_id,{type:'basic',front:'Wrong conversion'}),/Type conversion/);
 console.log(JSON.stringify({verified:true,typed_basic:true,multiline_item_ids_preserved:true,add_reorder_explicit_delete:true,literal_arrows:true,notes_unmarked:true,directions:3,retry_no_repeat:true,history_preserved:true,schedule_preserved:true,stale_context_rejected:true,type_conversion_rejected:true}));
}finally{
 for(const id of [...created].reverse()){if((await rem('find_many',undefined,{remIds:[id]})).total)await rem('remove',id);}
 assert.equal((await rem('find_many',undefined,{remIds:[...created]})).total,0);journal.close();await rm(dir,{recursive:true,force:true});console.log('Temporary update fixtures removed and absence verified.');
}
