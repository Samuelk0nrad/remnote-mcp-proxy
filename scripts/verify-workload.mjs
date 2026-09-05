// Read-only parity check against the actual native history functions extracted
// from the pinned installed app. Does not execute the full app or change notes.
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import {createAdapterVerifier,STATUS_ADAPTER} from '../src/card-status.mjs';
import {createWorkloadService} from '../src/workload.mjs';
import {EditLaterRepository} from '../src/server.mjs';
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
const nativeGrade=functionSource(moduleSource(790719),'i');
const context=vm.createContext({});
vm.runInContext(`const r={wy:{AGAIN:0,HARD:0.5,GOOD:1,EASY:1.5}};globalThis.grade=(${nativeGrade});`,context,{timeout:1000});
const grade=vm.runInContext('grade',context);
const repository=new EditLaterRepository(databasePath);
const service=createWorkloadService(repository,null,createAdapterVerifier(asar));
// Compare the current UTC calendar year; no note content or IDs are printed.
const year=new Date().getUTCFullYear();
const result=await service.summary({timezone:'UTC',start_date:`${year}-01-01`,end_date:`${year}-12-31`,day_start_hour:0});
const cutoff=Date.parse(result.as_of);
const expected=repository.withDatabase(db=>{
 let reviews=0,events=0;const cards=new Set();
 for(const row of db.prepare('SELECT _id,doc FROM cards').iterate()){
  for(const event of JSON.parse(row.doc).h??[]){
   events++;
   if(event.isFakeSimulated===true||!Number.isFinite(event.date)||event.date>cutoff||new Date(event.date).getUTCFullYear()!==year)continue;
   if(grade(event.score)){reviews++;cards.add(row._id);}
  }
 }
 return {reviews,cards:cards.size,events};
});
assert.equal(result.reviews.graded_reviews,expected.reviews);
assert.equal(result.reviews.distinct_cards_reviewed,expected.cards);
console.log(JSON.stringify({verified:true,source:'Installed native grade predicate and retained history',events_checked:expected.events,graded_reviews:expected.reviews,distinct_cards_reviewed:expected.cards}));
