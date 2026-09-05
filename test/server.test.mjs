import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMcpHandler, createRuntimeMcpRunner, EditLaterRepository, normalizeToolResult, readJsonResponse } from '../src/server.mjs';
import { createFlashcardService } from '../src/flashcards.mjs';

const copy = value => structuredClone(value);
function fixture({text = ['Question'], back = ['Old answer'], type = 'forward', children = [], document = false} = {}) {
  let rem = {remId:'testRem123', parentRemId:null, children, text, ...(back === undefined ? {} : {backText:back}), updatedAt:1};
  const state = {isDocument:document, isFolder:false, isCardItem:false, enablePractice:true, practiceDirection:type};
  const cards = back == null ? [] : [{cardId:'practiceCard123',remId:'testRem123',type}];
  let queued = true;
  let feedback = 'Too vague';
  let queueTime = 1;
  const writes=[];
  const run = async (_, args) => {
    const {operation} = args;
    if (operation === 'find_many') return {rems: rem ? [copy(rem)] : [], total:rem ? 1 : 0};
    if (!rem) throw new Error('Missing test Rem');
    if (operation === 'get') return {rem:copy(rem)};
    if (operation === 'state') return copy(state);
    if (operation === 'cards') return {cards:copy(cards)};
    if (operation === 'has_powerup') return {hasPowerup:args.powerupCode==='e'?queued:false};
    writes.push(copy(args));
    if (operation === 'set_text') rem.text=copy(args.richText);
    else if (operation === 'set_back_text') rem.backText=copy(args.richText);
    else if (operation === 'remove_powerup') queued=false;
    else if (operation === 'remove') {rem=null; return {applied:true};}
    else throw new Error(`Unexpected operation ${operation}`);
    rem.updatedAt++;
    return {applied:true};
  };
  const repository={get:()=> queued ? {feedback_rich_text:[feedback],added_at:queueTime} : null};
  return {run,repository,writes,state,cards,get rem(){return rem;},get queued(){return queued;},
    changeBack(value){rem.backText=[value];rem.updatedAt++;},changeFeedback(value){feedback=value;queueTime++;},
    service:createFlashcardService(run,repository,'test-secret')};
}
async function route(handler,name,args,authorized=true) {
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
  let result, status;
  await handler({url:'/mcp',method:'POST',headers:{authorization:authorized?'Bearer test-secret':''},async *[Symbol.asyncIterator](){yield Buffer.from(body);}},
    {writeHead(s){status=s;return this;},end(value){result=value?JSON.parse(value):null;}});
  return {status,body:result};
}

test('updates only the back, preserving front, literal arrows, direction and card IDs', async()=>{
  const f=fixture({type:'backward'});
  const before=await f.service.read('testRem123');
  const result=await f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back:'Factors → effects ↔ risks ― literal'},'flashcard');
  assert.equal(result.card.front,'Question');
  assert.equal(result.card.back,'Factors → effects ↔ risks ― literal');
  assert.equal(result.card.practice_direction,'backward');
  assert.deepEqual(result.card.cards,before.cards);
  assert.deepEqual(f.writes.map(w=>w.operation),['set_back_text']);
  assert.equal(result.verified,true);
});

test('updates both sides separately and resolves only with the verified result', async()=>{
  const f=fixture(); const before=await f.service.read('testRem123');
  const result=await f.service.update({rem_id:before.rem_id,expected_revision:before.revision,front:'New question',back:'New answer'},'flashcard');
  assert.deepEqual(f.rem.text,['New question']); assert.deepEqual(f.rem.backText,['New answer']);
  await assert.rejects(()=>f.service.resolve({id:before.rem_id}),/required/);
  const resolved=await f.service.resolve({id:before.rem_id,verification_token:result.verification_token});
  assert.equal(resolved.verified,true); assert.equal(f.queued,false);
});

test('stale revisions reject edits before writes',async()=>{
  const f=fixture(); const before=await f.service.read('testRem123'); f.changeBack('User edited meanwhile');
  await assert.rejects(()=>f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back:'Overwrite'},'flashcard'),/Revision conflict/);
  assert.equal(f.writes.length,0);
});

test('serializes competing proxy edits to the same Rem',async()=>{
  const f=fixture(); const before=await f.service.read('testRem123');
  const results=await Promise.allSettled(['First','Second'].map(back=>f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back},'flashcard')));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(f.writes.length,1);
});

test('rejects flattening rich text but preserves its formatting and references in a structured edit',async()=>{
  const rich=[{i:'m',text:'Old',b:true},{i:'q',_id:'referencedRem'}];
  const f=fixture({back:rich}); const before=await f.service.read('testRem123');
  await assert.rejects(()=>f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back:'New'},'flashcard'),/structured rich text/);
  await assert.rejects(()=>f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back_rich_text:['New']},'flashcard'),/preserve/);
  const changed=[{i:'m',text:'New',b:true},{i:'q',_id:'referencedRem'}];
  const result=await f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back_rich_text:changed},'flashcard');
  assert.deepEqual(result.card.back_rich_text,changed);
});

test('refuses cloze and multiline card types, even through the front updater',async()=>{
  for (const type of ['cloze','multiline']) {
    const f=fixture({type}); const before=await f.service.read('testRem123');
    await assert.rejects(()=>f.service.update({rem_id:before.rem_id,expected_revision:before.revision,front:'New'},'front'),/Only basic/);
    assert.equal(f.writes.length,0);
  }
});

test('legacy updater cannot concatenate new question and answer onto an existing card',async()=>{
  const f=fixture();const before=await f.service.read('testRem123');
  await assert.rejects(()=>f.service.update({rem_id:before.rem_id,expected_revision:before.revision,front:'Question → new answer'},'legacy'),/cannot update flashcards/);
  assert.equal(f.writes.length,0);
});

test('plain Rem updater preserves the absence of a back',async()=>{
  const f=fixture({back:null});f.rem.backText=undefined;
  const before=await f.service.read('testRem123');
  const result=await f.service.update({rem_id:before.rem_id,expected_revision:before.revision,front:'Updated note'},'front');
  assert.equal(result.card.has_back,false);assert.equal(result.card.front,'Updated note');
});

test('no-op retains rich text and issues no correction receipt',async()=>{
  const f=fixture({text:[{i:'m',text:'Question',b:true}]});const before=await f.service.read('testRem123');
  const result=await f.service.update({rem_id:before.rem_id,expected_revision:before.revision,front:'Question'},'flashcard');
  assert.equal(result.changed,false); assert.equal(result.verification_token,undefined);assert.equal(f.writes.length,0);
});

test('rejects forged receipts, changed card content, and changed feedback',async()=>{
  for (const mutation of ['forged','content','feedback']) {
    const f=fixture(); const before=await f.service.read('testRem123');
    const result=await f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back:'New answer'},'flashcard');
    let token=result.verification_token;
    if(mutation==='forged') token=token.slice(0,-1)+(token.endsWith('0')?'1':'0');
    if(mutation==='content') f.changeBack('New user edit');
    if(mutation==='feedback') f.changeFeedback('New feedback');
    await assert.rejects(()=>f.service.resolve({id:before.rem_id,verification_token:token}));
    assert.equal(f.queued,true);assert.equal(f.writes.some(w=>w.operation==='remove_powerup'),false);
  }
});

test('signed correction receipt remains usable after proxy restart',async()=>{
  const f=fixture();const before=await f.service.read('testRem123');
  const result=await f.service.update({rem_id:before.rem_id,expected_revision:before.revision,back:'New'},'flashcard');
  const restarted=createFlashcardService(f.run,f.repository,'test-secret');
  assert.equal((await restarted.resolve({id:before.rem_id,verification_token:result.verification_token})).verified,true);
});

test('partial two-side write failure does not clear Edit Later, hide the partial result or retry',async()=>{
  const f=fixture();
  const service=createFlashcardService((name,args)=>args.operation==='set_back_text'?Promise.reject(new Error('Lost connection')):f.run(name,args),f.repository,'test-secret');
  const before=await service.read('testRem123');
  await assert.rejects(()=>service.update({rem_id:before.rem_id,expected_revision:before.revision,front:'New front',back:'New back'},'flashcard'),/one or both sides may have changed/);
  assert.deepEqual(f.rem.text,['New front']);assert.deepEqual(f.rem.backText,['Old answer']);assert.equal(f.queued,true);
});

test('false acknowledgement and mismatched readback never report success',async()=>{
  for(const failure of ['false','no-write','other-side']) {
    const f=fixture();
    const service=createFlashcardService(async(name,args)=>{
      if(args.operation==='set_back_text') {
        if(failure==='false') return {applied:false};
        if(failure==='no-write') return {applied:true};
        const result=await f.run(name,args); f.rem.text=['Unexpected front']; return result;
      }
      return f.run(name,args);
    },f.repository,'test-secret');
    const before=await service.read('testRem123');
    await assert.rejects(()=>service.update({rem_id:before.rem_id,expected_revision:before.revision,back:'New'},'flashcard'),/could not be fully verified/);
    assert.equal(f.queued,true);
  }
});

test('deletion refuses documents, folders, unknown states and parents by default',async()=>{
  for(const target of ['document','folder','unknown','text-only','parent']) {
    const f=fixture({children:target==='parent'?['childRem123']:[]});
    if(target==='document') f.state.isDocument=true;
    if(target==='folder') f.state.isFolder=true;
    const safe=await f.service.read('testRem123');
    if(target==='unknown') delete f.state.isDocument;
    const service=target==='text-only'?createFlashcardService((name,args)=>args.operation==='state'?{content:[{type:'text',text:'{"isDocument":true}'}]}:f.run(name,args),f.repository,'test-secret'):f.service;
    await assert.rejects(()=>service.remove({rem_id:safe.rem_id,expected_revision:safe.revision}));
    assert.equal(f.writes.length,0);
  }
});

test('deletes a verified leaf and confirms absence; explicit subtree deletion works',async()=>{
  for(const children of [[],['childRem123']]) {
    const f=fixture({children});const before=await f.service.read('testRem123');
    const result=await f.service.remove({rem_id:before.rem_id,expected_revision:before.revision,...(children.length?{allow_descendants:true}:{})});
    assert.equal(result.verified,true);assert.equal(f.rem,null);
  }
});

test('missing deletion confirmation never becomes a verified deletion',async()=>{
  const f=fixture();const before=await f.service.read('testRem123');
  const service=createFlashcardService((name,args)=>args.operation==='find_many'?{rems:[]}:f.run(name,args),f.repository,'test-secret');
  await assert.rejects(()=>service.remove({rem_id:before.rem_id,expected_revision:before.revision}),/absence could not be verified/);
});

test('handler authenticates and strictly rejects extra fields and missing revisions',async()=>{
  const f=fixture();const handler=createMcpHandler({expectedToken:'test-secret',repository:f.repository,runtimeMcpRunner:f.run,logger:{error(){}}});
  assert.equal((await route(handler,'read_flashcard',{rem_id:'testRem123'},false)).status,401);
  const before=(await route(handler,'read_flashcard',{rem_id:'testRem123'})).body.result.structuredContent;
  assert.match(before.revision,/^[a-f0-9]{64}$/);
  for(const args of [{id:'testRem123',text:'Front',back:'New answer',expected_revision:before.revision},{id:'testRem123',text:'Front'}]) {
    assert.equal((await route(handler,'update_rem',args)).body.error.code,-32602);
  }
  assert.equal(f.writes.length,0);
});

function databaseFixture(t,count) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'remnote-proxy-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'fixture.db');const db=new DatabaseSync(file);
  db.exec('CREATE TABLE quanta (_id TEXT PRIMARY KEY,doc TEXT);CREATE TABLE cards (_id TEXT PRIMARY KEY,doc TEXT)');
  const insert=db.prepare('INSERT INTO quanta VALUES (?,?)');
  for(let i=0;i<count;i++) insert.run(`testRem${String(i).padStart(3,'0')}`,JSON.stringify({key:['Question'],value:['Answer'],createdAt:1,apu:{e:{v:true}},aph:{e_1:{v:[{v:true,t:2}]}}}));
  db.close();return {file,repository:new EditLaterRepository(file)};
}
test('queue paginates 101 items and does not skip after resolved items disappear',async t=>{
  const {file,repository}=databaseFixture(t,101);const first=repository.listPage(100);
  assert.equal(first.total,101);assert.equal(first.items.length,100);assert.equal(first.has_more,true);
  const db=new DatabaseSync(file);db.prepare('DELETE FROM quanta WHERE _id = ?').run(first.items[0].rem_id);db.close();
  const second=repository.listPage(100,first.next_cursor);
  assert.equal(second.items.length,1);assert.equal(second.items[0].rem_id,'testRem100');assert.equal(second.has_more,false);assert.equal(second.total,100);
  assert.throws(()=>repository.listPage(100,'not-a-cursor'),/Invalid queue cursor/);
});
test('queue handler returns totals and validates parameters',async t=>{
  const {repository}=databaseFixture(t,2);
  const handler=createMcpHandler({expectedToken:'test-secret',repository,runtimeMcpRunner:async()=>{},logger:{error(){}}});
  const result=(await route(handler,'get_edit_later_queue',{limit:1,include_context:false})).body.result.structuredContent;
  assert.equal(result.total,2);assert.equal(result.count,1);assert.equal(result.has_more,true);
  assert.equal((await route(handler,'get_edit_later_queue',{limit:1.5})).body.error.code,-32602);
});

test('normalizes text-only JSON but rejects empty, ambiguous and failed runtime results',()=>{
  assert.deepEqual(normalizeToolResult({content:[{type:'text',text:'{"isDocument":true}'}]}),{isDocument:true});
  for(const result of [undefined,{content:[]},{content:[{type:'text',text:'not-json'}]},{structuredContent:{applied:false}},{structuredContent:{ok:false}}]) assert.throws(()=>normalizeToolResult(result));
});
test('SSE parser skips progress, supports multiline data and returns without waiting for stream closure',async()=>{
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: {"id":"wanted",\r\ndata: "result":{"ok":true}}\r\n\r\n'));}});
  const result=await readJsonResponse(new Response(stream,{headers:{'content-type':'text/event-stream'}}),'wanted');
  assert.equal(result.result.ok,true);
});
test('parser rejects empty and mismatched RPC replies',async()=>{
  await assert.rejects(()=>readJsonResponse(new Response(''),'id'),/empty/);
  await assert.rejects(()=>readJsonResponse(Response.json({id:'other',result:{}}),'id'),/mismatch/);
});
test('runtime runner normalizes text-only payloads and closes the session',async()=>{
  const methods=[];
  const run=createRuntimeMcpRunner({token:'fake',fetchImpl:async(_,options)=>{
    methods.push(options.method);
    if(options.method==='DELETE') return new Response(null,{status:204});
    const request=JSON.parse(options.body);
    if(request.method==='initialize') return Response.json({id:'proxy-init',result:{}},{headers:{'mcp-session-id':'test-session'}});
    if(request.method==='notifications/initialized') return new Response(null,{status:202});
    return Response.json({id:'proxy-call',result:{content:[{type:'text',text:'{"isDocument":true}'}]}});
  }});
  assert.deepEqual(await run('remnote_rem',{operation:'state',remId:'testRem123'}),{isDocument:true});
  assert.equal(methods.at(-1),'DELETE');
});

// Native status rules, including the non-obvious multiple-of-threshold behavior.
const {cardLabels,readLeechThreshold,createStatusService,createAdapterVerifier}=await import('../src/card-status.mjs');
const scores=(...values)=>values.map(score=>({score}));
test('leech follows native positive threshold multiples, not total failures >= threshold',()=>{
  for(const [n,leech] of [[0,false],[3,false],[4,true],[5,false],[8,true]]) {
    const result=cardLabels({h:scores(...Array(n).fill(0))},{},4);
    assert.equal(result.labels.leech,leech,`failures=${n}`);
  }
  assert.equal(cardLabels({h:scores(0,0,0,0,0,0)},{},6).labels.leech,true);
});
test('native leech history starts after Reset and first Good/Easy, retaining later relearning failures',()=>{
  assert.equal(cardLabels({h:scores(0,0,0,0,3)},{},4).labels.leech,false);
  assert.equal(cardLabels({h:scores(0,0,0,1,0,0,0,0)},{},4).leech_failure_count,4);
  assert.equal(cardLabels({h:scores(1,0,1,0,1.5,0,1,0)},{},4).labels.leech,true);
  assert.equal(cardLabels({h:scores(0,0,0,0,3,0)},{},4).leech_failure_count,1);
});
test('Disabled excludes Edit Later and retired cards; New and Stale follow reset history',()=>{
  assert.equal(cardLabels({}, {},4).labels.disabled,true);
  assert.equal(cardLabels({}, {apu:{e:{v:true}}},4).labels.disabled,false);
  assert.equal(cardLabels({b:true}, {},4).labels.disabled,false);
  assert.equal(cardLabels({a:100}, {},4).labels.enabled,true);
  assert.equal(cardLabels({h:scores(1,3),st:1}, {},4,100).labels.new,true);
  assert.equal(cardLabels({h:scores(1,3),st:1}, {},4,100).labels.stale,false);
  assert.equal(cardLabels({h:scores(1),st:1}, {},4,100).labels.stale,true);
});
test('status adapter honors configured leech threshold and rejects ambiguous settings',t=>{
  const {file}=databaseFixture(t,0);const db=new DatabaseSync(file);db.exec('CREATE TABLE user_data (_id TEXT,doc TEXT)');
  assert.equal(readLeechThreshold(db).value,4);
  db.prepare('INSERT INTO user_data VALUES (?,?)').run('setting1',JSON.stringify({key:'leechThreshold',value:6}));
  assert.equal(readLeechThreshold(db).value,6);
  db.prepare('INSERT INTO user_data VALUES (?,?)').run('setting2',JSON.stringify({key:'leechThreshold',value:8}));
  assert.throws(()=>readLeechThreshold(db),/Ambiguous/);db.close();
});
test('status queries paginate actual matches and reject cursors from another label',async t=>{
  const {file,repository}=databaseFixture(t,3);const db=new DatabaseSync(file);db.exec('CREATE TABLE user_data (_id TEXT,doc TEXT)');
  const insert=db.prepare('INSERT INTO cards VALUES (?,?)');
  for(let i=0;i<3;i++)insert.run(`card${i}`,JSON.stringify({rId:`testRem00${i}`,c:'f',h:scores(0,0,0,0),a:100}));db.close();
  const service=createStatusService(repository,async()=>({rems:[{remId:'tagRem',text:['Hard Card']}],total:1,truncated:false}),async()=>{});
  const first=await service.list({status:'leech',limit:2});assert.equal(first.total,3);assert.equal(first.count,2);assert.equal(first.has_more,true);
  const second=await service.list({status:'leech',limit:2,cursor:first.next_cursor});assert.equal(second.count,1);assert.equal(second.has_more,false);
  await assert.rejects(()=>service.list({status:'disabled',cursor:first.next_cursor}),/does not belong/);
  const one=await service.get({rem_id:'testRem000'});assert.equal(one.items[0].labels.leech,true);assert.equal(one.tags[0].text,'Hard Card');
});
test('unverified app build prevents label claims',async t=>{
  const {repository}=databaseFixture(t,0);
  const service=createStatusService(repository,async()=>{},async()=>{throw new Error('app changed');});
  await assert.rejects(()=>service.list({status:'leech'}),/app changed/);
  await assert.rejects(()=>createAdapterVerifier('/nonexistent/test-only.asar')());
});
test('Edit Later cards hidden by getCards retain their persisted live SDK identities',async()=>{
  const f=fixture();
  const service=createFlashcardService((name,args)=>{
    if(name==='remnote_card'&&args.operation==='find_many')return {cards:copy(f.cards)};
    if(args.operation==='cards')return {cards:[]};
    return f.run(name,args);
  },{...f.repository,cardIds:()=>['practiceCard123']},'test-secret');
  const before=await service.read('testRem123');assert.equal(before.supported_basic_card,true);
  const result=await service.update({rem_id:before.rem_id,expected_revision:before.revision,back:'Corrected'},'flashcard');
  assert.deepEqual(result.card.cards,before.cards);assert.equal(result.verified,true);
});
test('persisted identity lookup includes dormant cards retained by Edit Later',t=>{
  const {file,repository}=databaseFixture(t,1);const db=new DatabaseSync(file);
  db.prepare('INSERT INTO cards VALUES (?,?)').run('dormantCard',JSON.stringify({rId:'testRem000',c:'f',b:true}));
  db.close();assert.deepEqual(repository.cardIds('testRem000'),['dormantCard']);
});
test('Edit Later status includes its dormant retained practice card',async t=>{
  const {file,repository}=databaseFixture(t,1);const db=new DatabaseSync(file);db.exec('CREATE TABLE user_data (_id TEXT,doc TEXT)');
  db.prepare('INSERT INTO cards VALUES (?,?)').run('dormantCard',JSON.stringify({rId:'testRem000',c:'f',b:true}));db.close();
  const service=createStatusService(repository,async()=>{},async()=>{});
  const result=await service.list({status:'edit_later'});assert.equal(result.total,1);assert.equal(result.items[0].labels.disabled,false);
});
