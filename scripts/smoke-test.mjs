// Only writes to temporary Rems created by this script. Never changes existing notes.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRuntimeMcpRunner,createMcpHandler,EditLaterRepository} from '../src/server.mjs';
const databasePath=process.env.REMNOTE_DB;
if(!databasePath)throw new Error('REMNOTE_DB is required.');
const config=JSON.parse(await readFile(path.join(os.homedir(),'.config/RemNote/config.json'),'utf8'));
const auth=JSON.parse(await readFile(path.join(os.homedir(),'.remnote-agent/auth.json'),'utf8'));
const runtime=createRuntimeMcpRunner({token:auth.httpToken});
const handler=createMcpHandler({expectedToken:config.remNoteMcpAccessToken,upstreamUrl:'http://127.0.0.1:7788/mcp',repository:new EditLaterRepository(databasePath),runtimeMcpRunner:runtime,logger:{error(){}}});
async function call(name,args){
 const body=JSON.stringify({jsonrpc:'2.0',id:'smoke',method:'tools/call',params:{name,arguments:args}});
 let result;
 if(process.env.MCP_PROXY_URL){
  const response=await fetch(process.env.MCP_PROXY_URL,{method:'POST',headers:{authorization:`Bearer ${config.remNoteMcpAccessToken}`,'content-type':'application/json'},body,signal:AbortSignal.timeout(60000)});
  result=await response.json();
 }else{
  await handler({url:'/mcp',method:'POST',headers:{authorization:`Bearer ${config.remNoteMcpAccessToken}`},async *[Symbol.asyncIterator](){yield Buffer.from(body);}},
  {writeHead(){return this;},end(value){result=JSON.parse(value);}});
 }
 if(result.error)throw new Error(result.error.data?.message??result.error.message);
 return result.result.structuredContent;
}
const created=new Set();
async function create(markdown){
 const result=await runtime('remnote_rem',{operation:'create_single_markdown',markdown:`[MCP-TEST] ${markdown}`});
 const id=result.rem?.remId;if(!id)throw new Error('No synthetic Rem ID');created.add(id);
 if(/>>|<<|<>/.test(markdown)){
  let ready=false;
  for(let i=0;i<30;i++){const cards=await runtime('remnote_rem',{operation:'cards',remId:id});if(cards.cards?.length){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
  if(!ready)throw new Error('Temporary practice card was not generated.');
  await new Promise(resolve=>setTimeout(resolve,300));
 }
 return id;
}
async function remove(id){const before=await call('read_flashcard',{rem_id:id});await call('delete_rem',{rem_id:id,expected_revision:before.revision,allow_descendants:true});created.delete(id);}
const results={};
try{
 const id=await create('front/back integrity >> Old answer');
 await runtime('remnote_rem',{operation:'add_powerup',remId:id,powerupCode:'e'});
 // SQLite persistence may trail SDK writes; wait for this test item only.
 for(let i=0;i<20;i++){if(new EditLaterRepository(databasePath).get(id))break;await new Promise(resolve=>setTimeout(resolve,100));}
 const before=await call('read_flashcard',{rem_id:id});
 const changed=await call('update_flashcard',{rem_id:id,expected_revision:before.revision,back:'Branche → Faktoren ↔ Risiken ― literal'});
 assert.equal(changed.card.front,before.front);assert.equal(changed.card.back,'Branche → Faktoren ↔ Risiken ― literal');assert.deepEqual(changed.card.cards,before.cards);
 await assert.rejects(()=>call('update_flashcard',{rem_id:id,expected_revision:before.revision,back:'Stale overwrite'}),/Revision conflict/);
 const resolved=await call('resolve_edit_later_item',{id,verification_token:changed.verification_token});assert.equal(resolved.verified,true);
 results.back_update_and_edit_later=true;
 const current=await call('read_flashcard',{rem_id:id});
 await assert.rejects(()=>call('update_rem',{id,text:'Question → answer',expected_revision:current.revision}),/cannot update flashcards/);
 results.legacy_card_write_rejected=true;
 const status=await call('get_card_status',{rem_id:id});assert.equal(status.total,1);assert.equal(typeof status.items[0].labels.leech,'boolean');
 results.status_labels=true;
 await remove(id);
 results.verified_deletion=true;
 for(const [name,separator]of [['backward','<<'],['both','<>']]){
  const id=await create(`direction ${name} ${separator} Old answer`);
  const before=await call('read_flashcard',{rem_id:id});
  const changed=await call('update_flashcard',{rem_id:id,expected_revision:before.revision,front:`[MCP-TEST] Updated ${name}`,back:'New answer'});
  assert.equal(changed.card.practice_direction,before.practice_direction);assert.deepEqual(changed.card.cards,before.cards);
  results[`${name}_direction_preserved`]=true;await remove(id);
 }
 const richId=await create('formatted **question** >> **Old answer**');
 const rich=await call('read_flashcard',{rem_id:richId});
 assert.ok(rich.back_rich_text.some(part=>typeof part==='object'));
 await assert.rejects(()=>call('update_flashcard',{rem_id:richId,expected_revision:rich.revision,back:'Flattened'}),/structured rich text/);
 const replacement=rich.back_rich_text.map(part=>typeof part==='object'&&typeof part.text==='string'?{...part,text:part.text.replace('Old','New')}:part);
 const richResult=await call('update_flashcard',{rem_id:richId,expected_revision:rich.revision,back_rich_text:replacement});
 assert.deepEqual(richResult.card.back_rich_text,replacement);results.formatting_preserved=true;await remove(richId);
 const documentId=await create('document guard');await runtime('remnote_rem',{operation:'set_document',remId:documentId,value:true});
 const document=await call('read_flashcard',{rem_id:documentId});assert.equal(document.state.isDocument,true);
 await assert.rejects(()=>call('delete_rem',{rem_id:documentId,expected_revision:document.revision}),/refuses documents/);
 await runtime('remnote_rem',{operation:'set_document',remId:documentId,value:false});await remove(documentId);results.document_guard=true;
 const labels=await call('list_cards_by_status',{status:'leech',limit:1});assert.equal(typeof labels.total,'number');results.status_query=true;
 console.log(JSON.stringify({verified:true,...results}));
}finally{
 for(const id of created){
  // All IDs here were returned by this script's own create call.
  await runtime('remnote_rem',{operation:'remove',remId:id});
  const remaining=await runtime('remnote_rem',{operation:'find_many',remIds:[id]});
  if(remaining.total!==0)throw new Error(`Temporary test cleanup failed: ${id}`);
 }
}
