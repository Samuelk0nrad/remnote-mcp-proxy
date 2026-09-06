import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {imageEntries,snapshotImages,createImageReader,fetchImage,imageUrl,publicAddress,applyImageChanges,imageMime} from '../src/images.mjs';
import {createMcpHandler,createRuntimeMcpRunner} from '../src/server.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
const image={i:'i',url:'https://example.com/a.png'};
test('image occurrence IDs are stable across metadata key order but distinct across location and duplicates',()=>{const a=imageEntries([image,image],'owner','front');assert.notEqual(a[0].image_id,a[1].image_id);assert.equal(a[0].image_id,imageEntries([{url:image.url,i:'i'}],'owner','front')[0].image_id);assert.notEqual(a[0].image_id,imageEntries([image],'owner','back')[0].image_id);assert.notEqual(a[0].image_id,imageEntries([{...image,url:'https://example.com/b.png'}],'owner','front')[0].image_id);assert.equal(snapshotImages({rem_id:'owner',front_rich_text:[image],answer_items:[{rem_id:'child',front_rich_text:[image],children:[]}]}).length,2);});
test('image retrieval produces native MCP image blocks and refuses stale images',async()=>{
 const rem={text:[image],backText:[]};const run=async()=>({rem});const get=createImageReader(run,{download:async()=>({bytes:png,mimeType:'image/png'})});const args={rem_id:'owner',image_id:imageEntries(rem.text,'owner','front')[0].image_id};const result=await get(args);assert.equal(result.content[1].type,'image');assert.deepEqual(Buffer.from(result.content[1].data,'base64'),png);rem.text=[];await assert.rejects(()=>get(args),/Stale/);
});
test('managed image retrieval uses runtime media mapping and preserves pixels',async()=>{
 const rem={text:[{i:'i',url:'%LOCAL_FILE%fixture.png'}]};let rawFlag;
 const run=async(name,args,options)=>{if(name==='remnote_rem')return {rem};if(name==='remnote_read_note')return {media:[{field:'text',elementIndex:0,mediaId:'runtime-media'}]};rawFlag=options.raw;assert.equal(args.mediaId,'runtime-media');return {content:[{type:'image',data:png.toString('base64'),mimeType:'image/png'}]};};
 const r=await createImageReader(run)({rem_id:'owner',image_id:imageEntries(rem.text,'owner','front')[0].image_id});assert.equal(rawFlag,true);assert.equal(r.structuredContent.source,'remnote_managed_local');assert.equal(r.content[1].data,png.toString('base64'));
});
test('private networks, credentials, custom ports, malformed sources and SVG are refused',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.1.1','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:8.8.8.8','198.18.0.1','0.0.0.0'])assert.equal(publicAddress(ip),false,ip);
 for(const url of ['https://127.1/x','https://[::1]/x','https://name:pass@example.com/x','https://example.com:444/x','file:///tmp/x','data:image/png;base64,a'])assert.throws(()=>imageUrl(url));assert.throws(()=>imageMime(Buffer.from('<svg></svg>')),/Unsupported/);
});
function transport(responses,seen){return (url,options,cb)=>{const req=new EventEmitter();req.destroy=e=>{req.emit('error',e);req.emit('close');};queueMicrotask(()=>{seen.push(url.href);options.lookup(url.hostname,{all:true},(err,addresses)=>{assert.ifError(err);assert.equal(addresses[0].address,'8.8.8.8');});const response=responses.shift();const stream=Readable.from(response.chunks??[png]);stream.statusCode=response.status??200;stream.headers=response.headers??{};cb(stream);stream.on('end',()=>req.emit('close'));});return req;};}
test('HTTPS fetch pins DNS, refuses private redirect targets and bounds response bytes',async()=>{
 const resolve=async()=>[{address:'8.8.8.8',family:4}],seen=[];const out=await fetchImage('https://example.com/a.png',1024,{resolve,request:transport([{}],seen)});assert.deepEqual(out.bytes,png);assert.equal(out.mimeType,'image/png');
 await assert.rejects(()=>fetchImage('https://example.com/a.png',1024,{resolve:async()=>[{address:'10.0.0.1',family:4}],request:()=>{throw new Error('Must not connect');}}),/non-public/);
 await assert.rejects(()=>fetchImage('https://example.com/a.png',1024,{resolve,request:transport([{status:302,headers:{location:'https://169.254.169.254/x'}}],[])}),/public/);
 await assert.rejects(()=>fetchImage('https://example.com/a.png',1024,{resolve,request:transport([{chunks:[Buffer.alloc(1025)]}],[])}),/byte limit/);
});
test('multiple explicit image removals use original occurrence IDs despite shifts',async()=>{
 const rich=['text',image,{...image,url:'https://example.com/b.png'}],entries=imageEntries(rich,'owner','front');await applyImageChanges(async()=>{},entries.map(e=>({action:'remove',side:'front',image_id:e.image_id})),[{id:'owner',side:'front',root:true,rich}]);assert.deepEqual(rich,['text']);
});
test('runtime raw mode keeps image content while closing its session',async()=>{
 let closed=false;const result={content:[{type:'image',data:png.toString('base64'),mimeType:'image/png'}]};const run=createRuntimeMcpRunner({token:'fake',fetchImpl:async(_,o)=>{if(o.method==='DELETE'){closed=true;return new Response(null,{status:204});}const r=JSON.parse(o.body);if(r.method==='initialize')return Response.json({id:'proxy-init',result:{}},{headers:{'mcp-session-id':'fixture'}});if(r.method==='notifications/initialized')return new Response(null,{status:202});return Response.json({id:'proxy-call',result});}});assert.deepEqual(await run('remnote_get_media',{}, {raw:true}),result);assert.equal(closed,true);
});
test('public MCP handler transports managed image blocks without serializing pixels as text',async()=>{
 const rem={text:[{i:'i',url:'%LOCAL_FILE%fixture.png'}]};const run=async name=>name==='remnote_rem'?{rem}:name==='remnote_read_note'?{media:[{field:'text',elementIndex:0,mediaId:'local'}]}:{content:[{type:'image',mimeType:'image/png',data:png.toString('base64')}]};const handler=createMcpHandler({expectedToken:'test',repository:{},runtimeMcpRunner:run,logger:{error(){}}});let body;
 const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_flashcard_image',arguments:{rem_id:'owner',image_id:imageEntries(rem.text,'owner','front')[0].image_id}}};await handler({url:'/mcp',method:'POST',headers:{authorization:'Bearer test'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(request));}},{writeHead(){return this;},end(value){body=JSON.parse(value);}});assert.equal(body.result.content[1].type,'image');assert.equal(body.result.structuredContent.size_bytes,png.length);assert.equal(body.result.content[0].text.includes(png.toString('base64')),false);
});
