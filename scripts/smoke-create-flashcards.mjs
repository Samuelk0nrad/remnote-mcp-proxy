// Writes only temporary fixtures created here. Never moves or edits user notes.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CreationJournal} from '../src/create-flashcards.mjs';
import {createRuntimeMcpRunner,createMcpHandler,EditLaterRepository} from '../src/server.mjs';
if(!process.env.REMNOTE_DB)throw new Error('REMNOTE_DB is required.');
const config=JSON.parse(await readFile(path.join(os.homedir(),'.config/RemNote/config.json'),'utf8'));
const auth=JSON.parse(await readFile(path.join(os.homedir(),'.remnote-agent/auth.json'),'utf8'));
const run=createRuntimeMcpRunner({token:auth.httpToken});
const dir=await mkdtemp(path.join(os.tmpdir(),'remnote-create-smoke-'));
const journal=new CreationJournal(path.join(dir,'requests.sqlite'));
const handler=createMcpHandler({expectedToken:config.remNoteMcpAccessToken,upstreamUrl:'http://127.0.0.1:7788/mcp',repository:new EditLaterRepository(process.env.REMNOTE_DB),runtimeMcpRunner:run,creationJournal:journal,logger:{error(){}}});
const created=new Set();
async function call(args){
 const body=JSON.stringify({jsonrpc:'2.0',id:'create-smoke',method:'tools/call',params:{name:'create_flashcards',arguments:args}});
 let rpc;
 if(process.env.MCP_PROXY_URL){rpc=await(await fetch(process.env.MCP_PROXY_URL,{method:'POST',headers:{authorization:`Bearer ${config.remNoteMcpAccessToken}`,'content-type':'application/json'},body,signal:AbortSignal.timeout(60000)})).json();}
 else await handler({url:'/mcp',method:'POST',headers:{authorization:`Bearer ${config.remNoteMcpAccessToken}`},async *[Symbol.asyncIterator](){yield Buffer.from(body);}},{writeHead(){return this;},end(value){rpc=JSON.parse(value);}});
 const result=rpc.result?.structuredContent;
 for(const id of result?.created_rem_ids??[])created.add(id);
 if(rpc.error||rpc.result?.isError||!result?.ok)throw new Error(rpc.error?.data?.message??result?.message??'No verified creation result');
 return result;
}
const rem=(operation,remId,more={})=>run('remnote_rem',{operation,remId,...more});
async function fixture(text,parentRemId){const id=(await rem('create_single_markdown',undefined,{markdown:`[MCP-TEST] ${text}`,parentRemId})).rem?.remId;assert.ok(id);created.add(id);return id;}
try {
 const root=await fixture('creation document');await rem('set_document',root,{value:true});
 const heading=await fixture('target heading',root),other=await fixture('other heading',root);
 const start=await fixture('first sibling',heading),end=await fixture('last sibling',heading);
 const cards=[];
 for(const type of ['basic','multiline'])for(const direction of ['forward','backward','both'])cards.push({type,direction,front:`[MCP-TEST] ${type} ${direction} → literal >> text`,back:type==='basic'?'Answer ↔ ― >> literal':{items:[{text:'First → literal'},{text:'Second ↔ literal'}]},notes:['Source is not an answer']});
 const args={parent_rem_id:heading,placement:{position:'before',sibling_rem_id:end},cards,request_id:randomUUID()};
 const result=await call(args);assert.equal(result.verified,true);assert.equal(result.cards.length,6);
 assert.deepEqual((await rem('get',root)).rem.children,[heading,other]);
 assert.deepEqual((await rem('get',heading)).rem.children,[start,...result.cards.map(c=>c.rem_id),end]);
 const retry=await call(args);assert.equal(retry.replayed,true);assert.deepEqual(retry.created_rem_ids,result.created_rem_ids);
 await assert.rejects(()=>call({...args,cards:[{type:'basic',front:'Changed',back:'Changed'}]}),/different arguments/);
 for(const card of result.cards){
  const live=(await rem('get',card.rem_id)).rem;assert.equal(live.text[0],card.front);assert.equal(live.parentRemId,heading);
  const ids=(await rem('cards',card.rem_id)).cards.map(c=>c.cardId).sort();assert.deepEqual(ids,[...card.card_ids].sort());
  if(card.type==='basic')assert.deepEqual(live.backText,[card.back]);
  else {assert.equal((live.backText??[]).length,0);assert.equal(card.answer_item_rem_ids.length,2);for(const id of card.answer_item_rem_ids)assert.equal((await rem('state',id)).isCardItem,true);}
  for(const id of card.note_rem_ids)assert.equal((await rem('state',id)).isCardItem,false);
 }
 for(const position of ['start','end','after']){
  const before=(await rem('get',heading)).rem.children;
  const placement={position,...(position==='after'?{sibling_rem_id:start}:{})};
  const added=await call({parent_rem_id:heading,placement,cards:[{type:'basic',front:'[MCP-TEST] position',back:'Answer'}],request_id:randomUUID()});
  const index=position==='start'?0:position==='end'?before.length:before.indexOf(start)+1;
  const expected=[...before];expected.splice(index,0,added.cards[0].rem_id);assert.deepEqual((await rem('get',heading)).rem.children,expected);
 }
 await assert.rejects(()=>call({parent_rem_id:heading,placement:{position:'before',sibling_rem_id:other},cards:[{type:'basic',front:'Q',back:'A'}],request_id:randomUUID()}),/direct child/);
 await assert.rejects(()=>call({parent_rem_id:result.cards[0].rem_id,cards:[{type:'basic',front:'Q',back:'A'}],request_id:randomUUID()}),/Destination is a flashcard/);
 console.log(JSON.stringify({verified:true,basic_directions:3,multiline_directions:3,placements:4,literal_sides:true,unmarked_notes:true,retry_no_duplicates:true,invalid_destinations_rejected:true}));
} finally {
 const ids=[...created];
 for(const id of ids.reverse()){const found=await rem('find_many',undefined,{remIds:[id]});if(found.total)await rem('remove',id);}
 assert.equal((await rem('find_many',undefined,{remIds:[...created]})).total,0);
 journal.close();await rm(dir,{recursive:true,force:true});
 console.log('Temporary creation fixtures removed and absence verified.');
}
