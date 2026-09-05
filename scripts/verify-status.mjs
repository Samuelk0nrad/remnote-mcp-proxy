// Read-only comparison with the running app's own label methods. No note text
// is printed or saved. Run on Example server with the RemNote desktop active.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cardLabels, readLeechThreshold, createAdapterVerifier } from '../src/card-status.mjs';
const databasePath=process.env.REMNOTE_DB;
if(!databasePath) throw new Error('REMNOTE_DB is required.');
await createAdapterVerifier(process.env.REMNOTE_APP_ASAR??'/opt/remnote/app/resources/app.asar')();
const db=new DatabaseSync(databasePath,{readOnly:true});
const threshold=readLeechThreshold(db);
const cards=db.prepare("SELECT doc FROM cards WHERE COALESCE(json_extract(doc,'$.b'),0) <> 1").all().map(r=>JSON.parse(r.doc));
db.close();
const targets=await fetch('http://127.0.0.1:9222/json/list',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
const target=targets.find(t=>t.type==='page' && !t.url.includes('widgetName='));
if(!target) throw new Error('No RemNote page for native comparison.');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
const pending=new Map();let nextId=1;
socket.addEventListener('message',event=>{const msg=JSON.parse(event.data);const waiter=pending.get(msg.id);if(waiter){pending.delete(msg.id);clearTimeout(waiter.timer);msg.error?waiter.reject(new Error(msg.error.message)):waiter.resolve(msg.result);}});
function command(method,params){return new Promise((resolve,reject)=>{const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native comparison timed out'));},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
try {
  const refs=cards.map(c=>({id:c._id,owner:c.owner}));
  const result=await command('Runtime.evaluate',{expression:`(async()=>{if(typeof window.Cards!=='function')throw new Error('Native Card collection is unavailable');const out=[];for(const ref of ${JSON.stringify(refs)}){const c=await window.Cards(ref.owner).findOne(ref.id);if(!c)throw new Error('Card missing during native comparison');out.push({id:ref.id,leech:c.isLeech(),struggling:c.isStruggling(),new:c.isNew(),stale:c.isStale(),not_yet_learned:c.isNotYetLearned()});}return out;})()`,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??'Native evaluation failed');
  const actual=result.result.value;assert.equal(actual.length,cards.length);
  const mismatches=[];
  for(let i=0;i<cards.length;i++){
    const expected=cardLabels(cards[i],{},threshold.value).labels;
    for(const label of ['leech','struggling','new','stale','not_yet_learned'])if(expected[label]!==actual[i][label])mismatches.push({card_id:cards[i]._id,label,expected:expected[label],actual:actual[i][label]});
  }
  assert.deepEqual(mismatches,[]);
  console.log(JSON.stringify({verified:true,cards_compared:cards.length,labels_compared:5,leech_threshold:threshold,leech_cards:actual.filter(c=>c.leech).length}));
}finally{socket.close();}
