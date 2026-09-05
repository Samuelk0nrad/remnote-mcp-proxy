// Read-only parity check against the actual native history functions extracted
// from the pinned installed app. Does not execute the full app or change notes.
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import {cardLabels,readLeechThreshold,createAdapterVerifier,STATUS_ADAPTER} from '../src/card-status.mjs';
const databasePath=process.env.REMNOTE_DB;
if(!databasePath)throw new Error('REMNOTE_DB is required.');
const asar=process.env.REMNOTE_APP_ASAR??'/opt/remnote/app/resources/app.asar';
await createAdapterVerifier(asar)();
const file=await open(asar,'r');let source;
try{
 const prefix=Buffer.alloc(16);await file.read(prefix,0,16,0);const bytes=Buffer.alloc(prefix.readUInt32LE(12));await file.read(bytes,0,bytes.length,16);
 const header=JSON.parse(bytes.toString());const entry=header.files.build.files.js.files[STATUS_ADAPTER.bundle];
 const bundle=Buffer.alloc(entry.size);await file.read(bundle,0,bundle.length,8+prefix.readUInt32LE(4)+Number(entry.offset));source=bundle.toString();
}finally{await file.close();}
function moduleSource(id){const start=source.indexOf(`${id}:function`);if(start<0)throw new Error('Native module changed');const tail=source.slice(start);const end=/},\d+:function/.exec(tail);if(!end)throw new Error('Native module boundary changed');return tail.slice(0,end.index+1);}
function functionSource(module,name){const start=module.indexOf(`function ${name}(`);if(start<0)throw new Error('Native helper changed');let depth=0,body=false;for(let i=start;i<module.length;i++){if(module[i]==='{'){depth++;body=true;}if(module[i]==='}'&&--depth===0&&body)return module.slice(start,i+1);}throw new Error('Incomplete native function');}
const nativeTrailing=functionSource(moduleSource(698579),'p');
const nativeHistory=functionSource(moduleSource(142529),'Y');
const nativeReset=functionSource(moduleSource(142529),'$');
const nativeLeech=functionSource(moduleSource(547092),'eE');
const context=vm.createContext({});
vm.runInContext(`const c={wy:{AGAIN:0,GOOD:1,EASY:1.5,RESET:3}};const l=c;const p={Yl:(${nativeTrailing})};${nativeHistory};${nativeReset};const R={z8:$};${nativeLeech};globalThis.check=(history,threshold)=>({leech:eE(history,threshold),struggling:eE(history,2),new:Y(history,[3]).length===0});`,context,{timeout:1000});
const db=new DatabaseSync(databasePath,{readOnly:true});
try{
 const threshold=readLeechThreshold(db);const native=vm.runInContext('check',context);let compared=0,leeches=0;
 for(const row of db.prepare("SELECT doc FROM cards WHERE COALESCE(json_extract(doc,'$.b'),0) <> 1").iterate()){
  const card=JSON.parse(row.doc);const actual=native(card.h??[],threshold.value);const expected=cardLabels(card,{},threshold.value).labels;
  for(const name of ['leech','struggling','new'])assert.equal(expected[name],actual[name],`Native label mismatch for ${card._id}: ${name}`);
  compared++;if(actual.leech)leeches++;
 }
 console.log(JSON.stringify({verified:true,source:'Installed native app history functions',cards_compared:compared,labels_compared:3,leech_threshold:threshold,leech_cards:leeches}));
}finally{db.close();}
