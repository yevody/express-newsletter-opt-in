import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/core/store.js';
import {createService} from '../src/core/service.js';
import {adminHtml} from '../src/core/views.js';
import config from '../src/core/config.js';
process.env.APP_URL='http://localhost:3000';
process.env.NEWSLETTER_POSTAL_ADDRESS='10 Example Street, Test City';
const edition={action:'send_newsletter',edition:'october-notes',subject:'October notes',body:'New project <draft> updates.'};
test('editions require confirmed consent, use bulk mail, and cannot be submitted twice',async()=>{
  const store=openStore(':memory:');const sent=[];
  const app=createService({store,deliver:async message=>{sent.push(message);return {status:'accepted',providerId:'test'}}});
  try {
    await assert.rejects(()=>app.action(edition),/No confirmed/);
    store.insert(config.kind,{name:'Pending',email:'pending@example.com'},'pending','pending@example.com');
    store.insert(config.kind,{name:'Former',email:'former@example.com'},'unsubscribed','former@example.com');
    const subscriber=store.insert(config.kind,{name:'Alex',email:'alex@example.com'},'confirmed','alex@example.com');
    assert.match(adminHtml(app.adminView()),/Send project notes/);
    await app.action(edition);assert.equal(sent.length,1);assert.deepEqual(sent[0].to,['alex@example.com']);
    assert.equal(sent[0].stream,'bulk');assert.equal(sent[0].category,'newsletter.digest');assert.equal(sent[0].customVariables.edition,'october-notes');assert.match(sent[0].html,/&lt;draft&gt;/);
    await assert.rejects(()=>app.action(edition),/already queued/);assert.equal(sent.length,1);
    const raw=sent[0].text.match(/access\/([A-Za-z0-9_-]+)/)[1];
    app.access(raw);assert.equal(store.get(subscriber.id).status,'confirmed');
    await app.redeem(raw);assert.equal(store.get(subscriber.id).status,'unsubscribed');
    await assert.rejects(()=>app.action({...edition,edition:'november-notes'}),/No confirmed/);
  } finally {store.close();}
});
test('mixed batch results persist per recipient and unsubscribe cancels a failed entry',async()=>{
  const store=openStore(':memory:');let calls=0,messages;
  const app=createService({store,deliverBatch:async batch=>{calls++;messages=batch;return [{status:'accepted',providerId:'accepted-first'},{status:'failed',error:'rejected'}]}});
  try {
    for(const name of ['Alex','Sam'])store.insert(config.kind,{name,email:`${name.toLowerCase()}@example.com`},'confirmed',name);
    await app.action(edition);assert.equal(calls,1);assert.equal(messages.length,2);
    assert.deepEqual(store.db.prepare('SELECT status FROM outbox ORDER BY rowid').all().map(row=>row.status),['accepted','failed']);
    const raw=messages[1].text.match(/access\/([A-Za-z0-9_-]+)/)[1];await app.redeem(raw);await app.retryFailed();
    assert.equal(calls,1);assert.deepEqual(store.db.prepare('SELECT status FROM outbox ORDER BY rowid').all().map(row=>row.status),['accepted','cancelled']);
  } finally {store.close();}
});
test('an uncertain batch is never retried with the same edition or retry command',async()=>{
  const store=openStore(':memory:');let calls=0;
  const app=createService({store,deliverBatch:async()=>{calls++;throw Object.assign(new Error('timeout'),{uncertain:true})}});
  try {
    for(const name of ['Alex','Sam'])store.insert(config.kind,{name,email:`${name.toLowerCase()}@example.com`},'confirmed',name);
    await app.action(edition);await app.retryFailed();await assert.rejects(()=>app.action(edition),/already queued/);assert.equal(calls,1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='unknown'").get().n,2);
  } finally {store.close();}
});
