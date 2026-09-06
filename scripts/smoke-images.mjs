// Updates only disposable cards created by this script, never existing user cards.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
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
 if(name==='get_flashcard_image'){if(rpc.error||rpc.result?.isError)throw new Error(rpc.error?.data?.message??rpc.error?.message??'Image retrieval failed');return rpc.result;}
 const value=rpc.result?.structuredContent;for(const id of value?.created_rem_ids??[])created.add(id);
 if(rpc.error||rpc.result?.isError||!value)throw new Error(rpc.error?.data?.message??value?.message??'Missing tool result');return value;
}
async function fixture(text,parentRemId){const id=(await rem('create_single_markdown',undefined,{markdown:`[MCP-TEST] ${text}`,parentRemId})).rem?.remId;assert.ok(id);created.add(id);return id;}
async function read(id){for(let i=0;i<4;i++){try{return await call('read_flashcard',{rem_id:id});}catch(e){if(i===3||!/changed while reading/.test(e.message))throw e;await new Promise(r=>setTimeout(r,100));}}}
async function update(rem_id, fields){const args={rem_id,expected_revision:(await read(rem_id)).revision,request_id:randomUUID(),...fields};const result=await call('update_flashcard',args);assert.equal(result.verified,true,result.message);return {result,args};}
const imageFile=path.join(process.env.SMOKE_MEDIA_DIR??path.join(path.dirname(process.env.REMNOTE_DB),'files'),`mcp-image-smoke-${randomUUID()}.png`);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
try{
 await writeFile(imageFile,png,{flag:'wx',mode:0o600});
 const root=await fixture('image support root');await rem('set_document',root,{value:true});
 const sourceId=await fixture('synthetic image source',root);await rem('set_text',sourceId,{richText:['[MCP-TEST] Image source',{i:'i',url:`%LOCAL_FILE%${path.basename(imageFile)}`,width:1,height:1}]});
 const sourceRead=await read(sourceId),source={source_rem_id:sourceId,image_id:sourceRead.images[0].image_id};
 const pixels=await call('get_flashcard_image',{rem_id:sourceId,image_id:source.image_id});assert.deepEqual(Buffer.from(pixels.content.find(c=>c.type==='image').data,'base64'),png);
 const made=await call('create_flashcards',{parent_rem_id:root,cards:[{type:'basic',front:'[MCP-TEST] Image question',front_images:[source],back:'Image answer',back_images:[source]},{type:'multiline',front:'[MCP-TEST] Illustrated steps',back:{items:[{text:'Step',images:[source]}]}}],request_id:randomUUID()});
 const [basic,multi]=made.cards,ids=made.cards.flatMap(c=>c.card_ids);
 for(let i=0;i<30&&repo.cardHistorySnapshot(ids).length!==ids.length;i++)await new Promise(r=>setTimeout(r,100));
 const history=repo.cardHistorySnapshot(ids),schedule=repo.cardScheduleSnapshot(ids);
 const basicRead=await read(basic.rem_id);assert.equal(basicRead.images.length,2);assert.equal((await read(multi.rem_id)).images[0].location,'answer_item');
 const image_id=basicRead.images.find(i=>i.side==='back').image_id;
 const hosted={url:'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png',width:272,height:92};
 const replacement=await update(basic.rem_id,{image_changes:[{action:'replace',side:'back',image_id,image:hosted}]});assert.equal(replacement.result.card.images.find(i=>i.side==='back').url,hosted.url);
 const hostedImage=replacement.result.card.images.find(i=>i.side==='back');const downloaded=await call('get_flashcard_image',{rem_id:basic.rem_id,image_id:hostedImage.image_id});assert.equal(downloaded.content.find(c=>c.type==='image').mimeType,'image/png');
 assert.equal((await call('update_flashcard',replacement.args)).replayed,true);
 await assert.rejects(()=>call('get_flashcard_image',{rem_id:basic.rem_id,image_id}),/Stale|missing/);
 const changed=await update(multi.rem_id,{image_changes:[{action:'add',side:'front',target_rem_id:multi.answer_item_rem_ids[0],image:source}]});assert.equal(changed.result.card.images.length,2);assert.deepEqual(changed.result.card.answer_items.map(c=>c.rem_id),multi.answer_item_rem_ids);
 const removed=await update(basic.rem_id,{image_changes:[{action:'remove',side:'back',image_id:hostedImage.image_id}]});assert.deepEqual(removed.result.card.back_rich_text,['Image answer']);
 const list=await call('list_flashcards',{root_rem_id:root,filters:{has_images:true},sort:[{field:'image_count',order:'desc'}]});assert.equal(list.total,2);assert.equal(list.items[0].rem_id,multi.rem_id);assert.equal(list.items[0].image_count,2);
 assert.deepEqual(repo.cardHistorySnapshot(ids),history);assert.deepEqual(repo.cardScheduleSnapshot(ids),schedule);
 console.log(JSON.stringify({verified:true,managed_image_pixels:true,hosted_image_pixels:true,basic_images:true,multiline_images:true,add_replace_remove:true,retry_safe:true,stale_image_rejected:true,image_filter_and_sort:true,history_preserved:true,schedule_preserved:true}));
}finally{
 for(const id of [...created].reverse()){if((await rem('find_many',undefined,{remIds:[id]})).total)await rem('remove',id);}
 assert.equal((await rem('find_many',undefined,{remIds:[...created]})).total,0);await rm(imageFile,{force:true});journal.close();await rm(dir,{recursive:true,force:true});console.log('Temporary image fixtures removed and absence verified.');
}
