// Explicit text spans are built by the SDK. Embedded objects are never reconstructed.
export const formats=['bold','italic','underline'];
export const formattedSchema={type:'object',additionalProperties:false,properties:{spans:{type:'array',minItems:1,maxItems:100,items:{oneOf:[{type:'object',additionalProperties:false,properties:{text:{type:'string',minLength:1,maxLength:50000},formats:{type:'array',maxItems:3,uniqueItems:true,items:{type:'string',enum:formats},description:'Omit or use [] for unformatted text.'}},required:['text']},{type:'object',additionalProperties:false,properties:{preserve_element:{type:'integer',minimum:0,maximum:9999,description:'Update only: copy this exact element index from the same side/item rich-text array. Every embedded/unsupported node must be retained once, in order.'}},required:['preserve_element']}]}}},required:['spans'],description:'Explicit formatted text. No Markdown or separator parsing. Preserve images, links, references, clozes and unknown formatting with preserve_element; do not flatten them.'};
export const contentSchema=plain=>({anyOf:[plain,formattedSchema]});
export const isFormatted=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const strict=(v,keys,required=[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||required.some(k=>!Object.hasOwn(v,k)))throw new TypeError('Invalid formatted text fields.');};
export function validateContent(value){
 if(typeof value==='string'){if(!value.trim()||value.length>50000)throw new TypeError('Text must be nonblank and at most 50000 characters.');return;}
 strict(value,['spans'],['spans']);if(!Array.isArray(value.spans)||!value.spans.length||value.spans.length>100)throw new TypeError('Formatted content requires 1-100 spans.');
 let length=0;
 for(const span of value.spans){
  if(Object.hasOwn(span??{},'preserve_element')){strict(span,['preserve_element'],['preserve_element']);if(!Number.isInteger(span.preserve_element)||span.preserve_element<0||span.preserve_element>9999)throw new TypeError('Invalid preserve_element index.');}
  else{strict(span,['text','formats'],['text']);if(typeof span.text!=='string'||!span.text.length)throw new TypeError('Each text span must be nonempty.');length+=span.text.length;if(span.formats!==undefined&&(!Array.isArray(span.formats)||span.formats.length>3||new Set(span.formats).size!==span.formats.length||span.formats.some(f=>!formats.includes(f))))throw new TypeError('Supported formats: bold, italic, underline.');}
 }
 if(length>50000)throw new TypeError('Formatted text exceeds 50000 characters.');
}
export function editableText(node){return typeof node==='string'||!!node&&node.i==='m'&&typeof node.text==='string'&&Object.keys(node).every(k=>['i','text','b','l','u'].includes(k))&&['b','l','u'].every(k=>node[k]===undefined||typeof node[k]==='boolean');}
export function contentView(rich){return {spans:(rich??[]).flatMap((node,index)=>typeof node==='string'?(node?[{text:node}]:[]):editableText(node)&&node.text?[{text:node.text,formats:formats.filter((_,i)=>node[['b','l','u'][i]]===true)}]:[{preserve_element:index}])};}
export async function buildContent(run,value,current=[]){
 validateContent(value);if(typeof value==='string')return [value];
 const preserved=value.spans.filter(s=>s.preserve_element!==undefined).map(s=>s.preserve_element);
 if(new Set(preserved).size!==preserved.length||preserved.some(i=>i>=current.length))throw new TypeError('Preserved element is missing or repeated. Read this side again.');
 const required=current.flatMap((node,i)=>editableText(node)?[]:[i]);
 const retained=preserved.filter(i=>required.includes(i));if(JSON.stringify(retained)!==JSON.stringify(required))throw new Error('Preserve every embedded or unsupported rich element once, in its original relative order.');
 const rich=[];
 for(const span of value.spans){
  if(span.preserve_element!==undefined){rich.push(structuredClone(current[span.preserve_element]));continue;}
  const selected=span.formats??[];
  if(!selected.length){rich.push(span.text);continue;}
  const result=await run('remnote_rich_text',{operation:'text',text:span.text,formats:selected});
  if(!Array.isArray(result?.richText)||result.richText.length!==1||!editableText(result.richText[0])||result.richText[0].text!==span.text||formats.some((format,i)=>(result.richText[0][['b','l','u'][i]]===true)!==selected.includes(format)))throw new Error('SDK formatting result did not match the requested text and styles.');
  rich.push(result.richText[0]);
 }
 if(!rich.some(n=>typeof n==='string'?n.trim():typeof n?.text==='string'?n.text.trim():true))throw new TypeError('Formatted content must not be blank.');
 return rich;
}

export function countSpans(value){return Array.isArray(value)?value.reduce((n,v)=>n+countSpans(v),0):value&&typeof value==='object'?(Array.isArray(value.spans)?value.spans.length:0)+Object.entries(value).filter(([k])=>k!=='spans').reduce((n,[,v])=>n+countSpans(v),0):0;}
