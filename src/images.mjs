import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import https from 'node:https';
import {isIP} from 'node:net';

const id={type:'string',pattern:'^[A-Za-z0-9_-]{3,128}$'};
const imageId={type:'string',pattern:'^[a-f0-9]{64}$',description:'Copy image_id from a fresh read_flashcard. IDs identify a stored image occurrence and change when it changes or moves within a side.'};
const dimension={type:'integer',minimum:1,maximum:20000};
export const imageSourceSchema={oneOf:[
 {type:'object',additionalProperties:false,properties:{url:{type:'string',maxLength:8192,description:'Public HTTPS image URL, stored as a link. No upload or hosting is performed.'},width:dimension,height:dimension},required:['url']},
 {type:'object',additionalProperties:false,properties:{source_rem_id:id,image_id:imageId},required:['source_rem_id','image_id']}
]};
export const imageArraySchema={type:'array',maxItems:10,items:imageSourceSchema,description:'Images appended after the literal text, in order. Use a hosted HTTPS image or copy an existing image returned by read_flashcard.'};
export const imageChangesSchema={type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['add','replace','remove']},target_rem_id:{...id,description:'Omit for the question. Otherwise a surviving direct multiline answer item ID.'},side:{type:'string',enum:['front','back']},image_id:imageId,image:imageSourceSchema,position:{type:'integer',minimum:0,maximum:10000,description:'Add only: rich-text element index, default end. Operations apply in order.'}},required:['action','side']},description:'Explicit image operations. Replace/remove require a current image_id; add/replace require image. Other rich elements remain protected. Requires request_id.'};
const strict=(v,keys,required=[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(v,k)))throw new TypeError('Invalid image fields.');};
const validId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{3,128}$/.test(v);
const validImageId=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const isImage=v=>v&&typeof v==='object'&&v.i==='i';
export function imageEntries(rich,remId,side,location='question'){
 return (Array.isArray(rich)?rich:[]).flatMap((node,index)=>isImage(node)?[{image_id:createHash('sha256').update(JSON.stringify(canonical([remId,side,index,node]))).digest('hex'),rem_id:remId,side,location,element_index:index,source:typeof node.url==='string'&&node.url.startsWith('%LOCAL_FILE%')?'remnote_managed_local':typeof node.url==='string'&&node.url.startsWith('https:')?'https':'unsupported',url:node.url??null,title:node.title??null,width:node.width??node.dimensions?.width??null,height:node.height??node.dimensions?.height??null}]:[]);
}
export function snapshotImages(snapshot){
 const images=[];
 const walk=(node,location)=>{images.push(...imageEntries(node.front_rich_text,node.rem_id,'front',location),...imageEntries(node.back_rich_text,node.rem_id,'back',location));for(const child of node.children??[])if(typeof child==='object')walk(child,'answer_item');};
 walk({...snapshot,children:snapshot.answer_items},'question');for(const note of snapshot.context_items??[])walk({...note,children:[]},'context');return images;
}
export function publicAddress(address){
 // IPv4 only for network retrieval. This rejects IPv6 transition/mapped ranges too.
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a>=224);
}
export function imageUrl(value){
 if(typeof value!=='string'||value.length>8192)throw new TypeError('Use a public HTTPS image URL.');
 let url;try{url=new URL(value);}catch{throw new TypeError('Invalid image URL.');}
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||url.hostname.endsWith('.')||url.hostname==='localhost'||!url.hostname.includes('.')||isIP(url.hostname.replace(/^\[|\]$/g,''))&&!publicAddress(url.hostname))throw new TypeError('Use a public HTTPS image URL without credentials, fragments or custom ports.');
 return url;
}
export function validateImageSource(value){
 if(value?.url!==undefined){strict(value,['url','width','height'],['url']);imageUrl(value.url);for(const k of ['width','height'])if(value[k]!==undefined&&(!Number.isInteger(value[k])||value[k]<1||value[k]>20000))throw new TypeError('Image dimensions must be 1-20000 pixels.');}
 else{strict(value,['source_rem_id','image_id'],['source_rem_id','image_id']);if(!validId(value.source_rem_id)||!validImageId(value.image_id))throw new TypeError('Copy source_rem_id and image_id from a reader.');}
}
export function validateImageArray(value){if(value===undefined)return;if(!Array.isArray(value)||value.length>10)throw new TypeError('At most 10 images per field.');value.forEach(validateImageSource);}
export async function buildImage(run,source){
 validateImageSource(source);
 if(source.url!==undefined){const value=await run('remnote_rich_text',{operation:'image',...source});if(!Array.isArray(value?.richText)||value.richText.length!==1||!isImage(value.richText[0])||value.richText[0].url!==source.url)throw new Error('SDK image builder returned an unexpected structure.');return value.richText[0];}
 const rem=(await run('remnote_rem',{operation:'get',remId:source.source_rem_id}))?.rem;
 if(!rem)throw new Error('Source image Rem no longer exists.');
 for(const [side,rich]of [['front',rem.text],['back',rem.backText]]){const found=imageEntries(rich,source.source_rem_id,side).find(x=>x.image_id===source.image_id);if(found){const node=rich[found.element_index];if(JSON.stringify(node).length>50000)throw new Error('Source image node is too large to copy safely.');if(typeof node.url!=='string'||!node.url.startsWith('%LOCAL_FILE%'))imageUrl(node.url);return structuredClone(node);}}
 throw new Error('Stale or missing source image. Read its owner Rem again.');
}
export async function appendImages(run,text,images){validateImageArray(images);const rich=[text];for(const source of images??[])rich.push(await buildImage(run,source));return rich;}
export async function applyImageChanges(run,changes,targets){
 if(changes===undefined)return;
 if(!Array.isArray(changes)||!changes.length||changes.length>20)throw new TypeError('Supply 1-20 image changes.');
 const used=new Set();
 // Resolve original identities before applying index shifts caused by earlier operations.
 const originals=new Map(targets.map(t=>[`${t.id}:${t.side}`,imageEntries(t.rich,t.id,t.side).map(e=>({...e,node:t.rich[e.element_index]}))]));
 for(const change of changes){
  strict(change,['action','target_rem_id','side','image_id','image','position'],['action','side']);
  if(!['add','replace','remove'].includes(change.action)||!['front','back'].includes(change.side))throw new TypeError('Invalid image operation.');
  const target=targets.find(t=>t.side===change.side&&(change.target_rem_id===undefined?t.root:t.id===change.target_rem_id));if(!target)throw new Error('Image destination must be this card side or a surviving direct answer front.');
  const add=change.action==='add',remove=change.action==='remove';
  if(add?change.image_id!==undefined:!validImageId(change.image_id))throw new TypeError('Replace/remove require image_id; add forbids it.');
  if(remove?change.image!==undefined:change.image===undefined)throw new TypeError('Add/replace require image; remove forbids it.');
  if(!add&&change.position!==undefined)throw new TypeError('position is only valid for adding an image.');
  let index=change.position??target.rich.length;
  if(!add){if(used.has(change.image_id))throw new TypeError('Each image may only be changed once per request.');used.add(change.image_id);const old=originals.get(`${target.id}:${target.side}`).find(e=>e.image_id===change.image_id);index=old?target.rich.indexOf(old.node):-1;if(index<0)throw new Error('Stale image ID or wrong side. Read the card again.');}
  if(!Number.isInteger(index)||index<0||index>target.rich.length)throw new TypeError('Image position is outside the rich-text array.');
  if(remove)target.rich.splice(index,1);else target.rich.splice(index,add?0:1,await buildImage(run,change.image));
 }
}
export function imageMime(bytes){
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return 'image/gif';
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 throw new Error('Unsupported image bytes. Only PNG, JPEG, GIF and WebP are returned; SVG/HTML are not images here.');
}
export async function fetchImage(value,maxBytes,{resolve=lookup,request=https.get}={}){
 let url=imageUrl(value);const deadline=Date.now()+20000;
 for(let redirects=0;redirects<=3;redirects++){
  let dnsTimer,addresses;try{addresses=await Promise.race([resolve(url.hostname,{all:true,family:4}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(new Error('Image DNS timeout.')),Math.max(1,deadline-Date.now()));dnsTimer.unref();})]);}finally{clearTimeout(dnsTimer);}
  if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('Image host resolves to a non-public address.');
  const chosen=addresses[0];
  const result=await new Promise((resolve,reject)=>{
   const req=request(url,{agent:false,lookup:(_host,options,cb)=>cb(null,options?.all?[chosen]:chosen.address,chosen.family),headers:{Accept:'image/png,image/jpeg,image/gif,image/webp'},timeout:Math.max(1,deadline-Date.now())},res=>{
    if([301,302,303,307,308].includes(res.statusCode)){res.resume();resolve({redirect:res.headers.location});return;}
    if(res.statusCode!==200){res.resume();reject(new Error(`Image host returned HTTP ${res.statusCode}.`));return;}
    if(Number(res.headers['content-length'])>maxBytes){res.destroy();reject(new Error('Image exceeds the requested byte limit.'));return;}
    const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(new Error('Image exceeds the requested byte limit.'));}else chunks.push(chunk);});res.on('error',()=>reject(new Error('Image download failed.')));res.on('end',()=>resolve({bytes:Buffer.concat(chunks)}));
   });
   const timer=setTimeout(()=>req.destroy(new Error('Image download timeout.')),Math.max(1,deadline-Date.now()));timer.unref();req.on('close',()=>clearTimeout(timer));req.on('timeout',()=>req.destroy(new Error('Image download timeout.')));req.on('error',()=>reject(new Error('Image download failed or timed out.')));
  });
  if(result.bytes)return {bytes:result.bytes,mimeType:imageMime(result.bytes)};
  if(!result.redirect||redirects===3)throw new Error('Too many or invalid image redirects.');url=imageUrl(new URL(result.redirect,url).href);
 }
}
export const GET_IMAGE_TOOL={name:'get_flashcard_image',description:'Return one stored image as native MCP image content so the model can inspect its pixels. First read_flashcard, then pass the image owner rem_id and image_id from images. Supports RemNote-managed local images through the runtime and public HTTPS PNG/JPEG/GIF/WebP images. Does not upload files, render the whole practice card, apply occlusion masks, or infer picture contents from metadata. A URL fetch contacts its host without user credentials; private network destinations are refused.',inputSchema:{type:'object',additionalProperties:false,properties:{rem_id:id,image_id:imageId,max_bytes:{type:'integer',minimum:1024,maximum:5242880,default:5242880}},required:['rem_id','image_id']},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}};
export function createImageReader(run,{download=fetchImage}={}){
 return async args=>{
  strict(args,['rem_id','image_id','max_bytes'],['rem_id','image_id']);if(!validId(args.rem_id)||!validImageId(args.image_id))throw new TypeError('Copy the image owner Rem ID and image ID from read_flashcard.');
  const max=args.max_bytes??5242880;if(!Number.isInteger(max)||max<1024||max>5242880)throw new TypeError('max_bytes must be 1024-5242880.');
  const get=async()=>{const rem=(await run('remnote_rem',{operation:'get',remId:args.rem_id}))?.rem;if(!rem)throw new Error('Image Rem no longer exists.');return [...imageEntries(rem.text,args.rem_id,'front'),...imageEntries(rem.backText,args.rem_id,'back')].find(e=>e.image_id===args.image_id);};
  const entry=await get();if(!entry)throw new Error('Stale or missing image. Read the card again.');let block;
  if(entry.source==='https'){const {bytes,mimeType}=await download(entry.url,max);if(bytes.length>max)throw new Error('Image exceeds byte limit.');block={type:'image',data:bytes.toString('base64'),mimeType:imageMime(bytes)};if(block.mimeType!==mimeType)throw new Error('Image MIME mismatch.');}
  else if(entry.source==='remnote_managed_local'){
   const field=entry.side==='front'?'text':'backText';
   const note=await run('remnote_read_note',{remId:args.rem_id,includeMediaMetadata:true,depth:0});
   const media=note.media?.find(m=>m.field===field&&m.elementIndex===entry.element_index);if(!media)throw new Error('Runtime could not locate this managed image.');
   const result=await run('remnote_get_media',{remId:args.rem_id,field,mediaId:media.mediaId,maxInlineBytes:max},{raw:true});
   const blocks=result?.content?.filter(c=>c.type==='image');if(blocks?.length!==1)throw new Error('Runtime did not return image pixels.');block=blocks[0];
   const bytes=Buffer.from(block.data,'base64');if(bytes.length>max||imageMime(bytes)!==block.mimeType)throw new Error('Invalid or oversized runtime image.');block={type:'image',data:bytes.toString('base64'),mimeType:block.mimeType};
  }else throw new Error('Unsupported image location. A managed local image or public HTTPS URL is required.');
  if(!await get())throw new Error('Image changed during retrieval. Read again.');
  const metadata={...entry,size_bytes:Buffer.byteLength(block.data,'base64'),mime_type:block.mimeType,rendered_practice:false};
  return {content:[{type:'text',text:JSON.stringify(metadata)},block],structuredContent:metadata};
 };
}
