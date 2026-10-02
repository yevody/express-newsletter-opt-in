import test from 'node:test';
import assert from 'node:assert/strict';
import {settings,sendMail,escapeHtml} from '../src/core/mail.js';
const base={MAIL_FROM:'sender@example.com',MAILTRAP_SANDBOX_TOKEN:'sandbox-token',MAILTRAP_PRODUCTION_TOKEN:'production-token',MAILTRAP_INBOX_ID:'123'};
const message={to:['reader@example.com'],subject:'Hello',text:'<script>unsafe</script>',replyTo:'reply@example.com',category:'receipt',customVariables:{record_id:'r1'},headers:{'X-Workflow-Reference':'r1'}};
const response=(body,status=200)=>({ok:status===200,status,json:async()=>body});
test('email content is escaped',()=>assert.equal(escapeHtml('<img src=x>'), '&lt;img src=x&gt;'));
test('missing credentials fail before a network call',async()=>{
  let called=false;await assert.rejects(()=>sendMail(message,{env:{MAIL_FROM:base.MAIL_FROM},fetch:()=>{called=true}}),/credentials/);assert.equal(called,false);
});
test('log transport cannot run in a production process',()=>assert.throws(()=>settings({MAIL_MODE:'log',NODE_ENV:'production'}),/disabled/));
test('Sandbox and live calls keep credentials and endpoints separate',async()=>{
  for(const mode of ['sandbox','production']) {
    let url,options;const result=await sendMail(message,{env:{...base,MAIL_MODE:mode},fetch:async(u,o)=>{url=u;options=o;return response({success:true,message_ids:['id-1']})}});
    assert.equal(url,mode==='sandbox'?'https://sandbox.api.mailtrap.io/api/send/123':'https://send.api.mailtrap.io/api/send');
    assert.equal(options.headers.Authorization,`Bearer ${mode==='sandbox'?'sandbox':'production'}-token`);
    assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(result.status,'accepted');assert.equal(result.providerId,'id-1');
    const payload=JSON.parse(options.body);assert.deepEqual(payload.to,[{email:'reader@example.com'}]);assert.equal(payload.reply_to.email,'reply@example.com');assert.match(payload.html,/&lt;script&gt;/);assert.equal(payload.category,'receipt');assert.deepEqual(payload.custom_variables,{record_id:'r1'});assert.equal(payload.headers['X-Workflow-Reference'],'r1');
  }
});
test('malformed success responses cannot become accepted or safely retryable',async()=>{
  for(const body of [{},{success:true},{success:true,message_ids:[]},{success:true,message_ids:['']},{success:true,message_ids:['a','b']},null,{success:false,message_ids:['accepted-before-error']}]) {
    await assert.rejects(()=>sendMail(message,{env:base,fetch:async()=>response(body)}),error=>error.uncertain===true);
  }
});
test('server errors and timeouts remain uncertain while explicit rejection can be retried',async()=>{
  for(const status of [400,401,422,429,408,500,503])await assert.rejects(()=>sendMail(message,{env:base,fetch:async()=>response({},status)}),error=>error.uncertain===(status>=500||status===408));
  await assert.rejects(()=>sendMail(message,{env:base,fetch:async()=>{throw new Error('timeout')}}),error=>error.uncertain===true);
  await assert.rejects(()=>sendMail(message,{env:base,fetch:async()=>response({success:false,errors:['rejected']})}),error=>error.uncertain===false);
  await assert.rejects(()=>sendMail(message,{env:base,fetch:async()=>({ok:true,json:async()=>{throw new Error('bad json')}})}),error=>error.uncertain===true);
});
test('invalid sender and Sandbox ID are rejected locally',()=>{
  assert.throws(()=>settings({...base,MAIL_FROM:'bad\r\nBcc: x@example.com'}));
  assert.throws(()=>settings({...base,MAILTRAP_INBOX_ID:'../../send'}));
});

test('batch endpoint isolates recipients and preserves partial outcomes',async()=>{
  const {sendBatch}=await import('../src/core/mail.js');
  for(const mode of ['sandbox','production'])for(const stream of ['bulk','transactional']) {
    let url,payload;const result=await sendBatch([{...message,stream},{...message,to:['other@example.com'],stream}],{env:{...base,MAIL_MODE:mode},fetch:async(u,o)=>{url=u;payload=JSON.parse(o.body);return response({success:true,responses:[{success:true,message_ids:['a']},{success:false,errors:['recipient rejected']}]})}});
    assert.equal(url,mode==='sandbox'?'https://sandbox.api.mailtrap.io/api/batch/123':`https://${stream==='bulk'?'bulk':'send'}.api.mailtrap.io/api/batch`);
    assert.deepEqual(result.map(r=>r.status),['accepted','failed']);assert.equal(payload.requests[0].to.length,1);assert.notDeepEqual(payload.requests[0].to,payload.requests[1].to);assert.equal(payload.base.from.email,base.MAIL_FROM);
  }
  await assert.rejects(()=>sendBatch([message,message],{env:base,fetch:async()=>response({responses:[{success:true,message_ids:['a']}]})}),error=>error.uncertain===true);
  const outcomes=await sendBatch([message,message],{env:base,fetch:async()=>response({responses:[{}, {success:true,message_ids:['b']}]})});assert.deepEqual(outcomes.map(r=>r.status),['unknown','accepted']);
});
