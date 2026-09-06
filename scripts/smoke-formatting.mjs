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
const styled=(text,formats=['bold'])=>({spans:[{text,formats}]});
try{
 const root=await fixture('formatting root');await rem('set_document',root,{value:true});
 const made=await call('create_flashcards',{parent_rem_id:root,cards:[{type:'basic',front:styled('[MCP-TEST] Bold question'),back:styled('Italic answer',['italic']),notes:[styled('Underlined source',['underline'])],front_images:[{url:'https://example.com/fixture.png'}]},{type:'multiline',front:'[MCP-TEST] Steps',back:{items:[{text:styled('First step')},{text:'Second step'}]}}],request_id:randomUUID()});
 const [basic,multi]=made.cards,ids=made.cards.flatMap(c=>c.card_ids);
 for(let i=0;i<30&&repo.cardHistorySnapshot(ids).length!==ids.length;i++)await new Promise(r=>setTimeout(r,100));
 const history=repo.cardHistorySnapshot(ids),schedule=repo.cardScheduleSnapshot(ids);
 const initial=await read(basic.rem_id);assert.equal(initial.front_rich_text[0].b,true);assert.equal(initial.back_rich_text[0].l,true);assert.equal(initial.front_content.spans[1].preserve_element,1);
 const question=await update(basic.rem_id,{front:{spans:[{text:'[MCP-TEST] Emphasis',formats:['bold','italic','underline']},{preserve_element:1}]},back:styled('Now normal',[]),notes:[styled('Bold source')]});
 assert.deepEqual(question.result.card.front_rich_text[1],initial.front_rich_text[1]);assert.equal(question.result.card.front_rich_text[0].b,true);assert.equal(question.result.card.front_rich_text[0].l,true);assert.equal(question.result.card.front_rich_text[0].u,true);assert.deepEqual(question.result.card.back_rich_text,['Now normal']);
 const changed=await update(multi.rem_id,{back:{items:[{rem_id:multi.answer_item_rem_ids[0],text:styled('First step',[])},{rem_id:multi.answer_item_rem_ids[1],text:{spans:[{text:'Second',formats:['bold']},{text:' → **literal** step'}]}},{text:styled('Third step',['italic'])}]}});
 assert.equal(changed.result.verified,true);assert.deepEqual(changed.result.card.answer_items[0].front_rich_text,['First step']);assert.equal(changed.result.card.answer_items[1].front_rich_text[0].b,true);assert.equal(changed.result.card.answer_items[1].front_rich_text[1],' → **literal** step');assert.equal(changed.result.card.answer_items[2].front_rich_text[0].l,true);assert.deepEqual(changed.result.card.answer_items.slice(0,2).map(c=>c.rem_id),multi.answer_item_rem_ids);
 assert.equal((await call('update_flashcard',changed.args)).replayed,true);
 await assert.rejects(()=>update(basic.rem_id,{front:styled('Would discard image')}),/Preserve every/);
 assert.deepEqual(repo.cardHistorySnapshot(ids),history);assert.deepEqual(repo.cardScheduleSnapshot(ids),schedule);
 console.log(JSON.stringify({verified:true,bold_italic_underline:true,selective_and_combined:true,formatting_removal:true,multiline_creation_and_updates:true,new_formatted_answer:true,notes:true,images_preserved:true,embedded_drop_rejected:true,literal_separators:true,retry_safe:true,history_preserved:true,schedule_preserved:true}));
}finally{
 for(const id of [...created].reverse()){if((await rem('find_many',undefined,{remIds:[id]})).total)await rem('remove',id);}
 assert.equal((await rem('find_many',undefined,{remIds:[...created]})).total,0);journal.close();await rm(dir,{recursive:true,force:true});console.log('Temporary formatting fixtures removed and absence verified.');
}
