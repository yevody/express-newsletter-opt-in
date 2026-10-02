import './env.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import config from './config.js';
import { openStore } from './store.js';
import { sendMail, sendBatch, escapeHtml } from './mail.js';
import { AppError, baseUrl, rateLimit } from './security.js';

const fieldSchema = field => {
  if (field.type === 'checkbox') return z.enum(['on','true'], {error:`${field.label} is required.`});
  let value=z.string().trim().min(1,`${field.label} is required.`).max(field.type==='textarea'?2000:300,`${field.label} is too long.`);
  if(field.type==='email') value=value.email('Enter a valid email address.').transform(s=>s.toLowerCase());
  if(field.type==='url') value=value.refine(s=>{try{return ['https:','http:'].includes(new URL(s).protocol)}catch{return false}},'Enter an HTTP or HTTPS URL.');
  if(field.type==='datetime-local') value=value.refine(s=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && Number.isFinite(Date.parse(s+'Z')) && new Date(s+'Z').toISOString().slice(0,16)===s, 'Enter a valid date and time.');
  if(field.options) value=value.refine(s=>field.options.some(option=>option.value===s),'Choose one of the listed options.');
  return value;
};
export const submissionSchema=z.object(Object.fromEntries(config.fields.map(f=>[f.name,fieldSchema(f)])));
export const jsonSchema={type:'object',required:config.fields.map(f=>f.name),properties:Object.fromEntries(config.fields.map(f=>[f.name,{type:'string',minLength:1,maxLength:f.type==='textarea'?2000:300,...(f.options?{enum:f.options.map(o=>o.value)}:{})}]))};

export function createService({store=openStore(), deliver=sendMail, deliverBatch=sendBatch}={}) {
  const {db,records,get,find,insert,update,atomic,token,inspectToken,consume,queue}=store;
  const owner=()=>process.env.OWNER_EMAIL || 'owner@example.com';
  const link=raw=>`${baseUrl()}/access/${raw}`;
  const notify=(row,key,to,subject,text,replyTo)=>queue(`${row.id}:${key}`,{to:Array.isArray(to)?to:[to],subject,text,category:`${config.kind}.${key.split('-')[0]}`,customVariables:{record_id:row.id,workflow:config.kind},headers:{'X-Workflow-Reference':row.id},...(replyTo?{replyTo}:{})});
  const duplicate=(key,message='This request has already been recorded.')=>{if(find(key))throw new AppError(message,409)};
  const requirePending=(id,status='pending')=>{const row=get(id);if(!row || row.kind!==config.kind)throw new AppError('Record not found.',404);if(row.status!==status)throw new AppError('This record has already been updated.',409);return row};
  const onSubmit=data=>{const previous=find(data.email);if(previous && previous.status!=='unsubscribed')throw new AppError('A subscription request already exists for this address.',409);let row;if(previous){store.removeTokens(previous.id);row=update(previous.id,'pending',data)}else{row=insert(config.kind,data,'pending',data.email)}const confirm=token(row.id,'confirm_subscription',86400);const unsubscribe=token(row.id,'unsubscribe',31536000);notify(row,`confirm-${randomUUID()}`,data.email,'Confirm your subscription',`Hello ${data.name},\nConfirm your email to receive occasional project notes:\n${link(confirm)}\nThe confirmation expires in 24 hours.\nUnsubscribe at any time within one year: ${link(unsubscribe)}`);return row};
const accessDescription=grant=>grant.action==='unsubscribe'?'Unsubscribe this email address from project notes.':'Confirm that you want to receive occasional project notes.';
const onRedeem=grant=>{const row=get(grant.record_id);if(grant.action==='confirm_subscription'){if(row.status!=='pending')throw new AppError('This subscription is no longer pending.',409);update(row.id,'confirmed');return {ok:true,message:'Your subscription is confirmed.'}}if(grant.action==='unsubscribe'){update(row.id,'unsubscribed');db.prepare("UPDATE outbox SET status='cancelled',error=NULL WHERE status IN ('pending','failed') AND json_extract(payload,'$.subscriberId')=?").run(row.id);store.removeTokens(row.id);return {ok:true,message:'You have been unsubscribed.'}}throw new AppError('Invalid subscription action.')};
const publicView=()=>({count:records(config.kind).length,rows:[]});
  const adminExtra=()=>({editions:records('edition')});
  const onAction=input=>{
    if(input.action!=='send_newsletter')throw new AppError('Unknown operator action.',400);
    const parsed=z.object({edition:z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),subject:z.string().trim().min(1).max(150),body:z.string().trim().min(1).max(4000)}).safeParse(input);
    if(!parsed.success)throw new AppError('Provide an edition key, subject, and message within the form limits.');
    const {edition,subject,body}=parsed.data;
    duplicate(`edition:${edition}`,'This edition is already queued. Review its outbox instead of submitting it again.');
    const subscribers=records(config.kind).filter(row=>row.status==='confirmed');
    if(!subscribers.length)throw new AppError('No confirmed subscribers to send to.');
    if(subscribers.length>100)throw new AppError('This small app supports at most 100 confirmed subscribers per edition.');
    const address=(process.env.NEWSLETTER_POSTAL_ADDRESS || '').trim();
    if(!address)throw new AppError('Set NEWSLETTER_POSTAL_ADDRESS before sending an edition.');
    const editionRow=insert('edition',{edition,subject,body},'queued',`edition:${edition}`);
    for(const subscriber of subscribers) {
      const unsubscribe=link(token(subscriber.id,'unsubscribe',31536000));
      const text=`Hello ${subscriber.data.name},\n\n${body}\n\n${address}\nUnsubscribe: ${unsubscribe}\nThis link is valid for one year.`;
      queue(`${editionRow.id}:${subscriber.id}`,{to:[subscriber.email],subject,text,stream:'bulk',subscriberId:subscriber.id,
        category:'newsletter.digest',customVariables:{record_id:subscriber.id,edition_id:editionRow.id,edition},headers:{'X-Newsletter-Edition':edition},
        html:`<p>Hello ${escapeHtml(subscriber.data.name)},</p>${body.split('\n').map(line=>`<p>${escapeHtml(line)}</p>`).join('')}<p>${escapeHtml(address)}</p><p><a href="${escapeHtml(unsubscribe)}">Unsubscribe from project notes</a> (valid for one year)</p>`});
    }
    return {ok:true,message:`Edition ${edition} queued for ${subscribers.length} confirmed subscribers. Check each email status below.`};
  };
  let flushing=false;
  async function flush() {
    if(flushing)return; flushing=true;
    const save=(id,result)=>db.prepare('UPDATE outbox SET status=?,provider_id=?,error=? WHERE id=?').run(result.status,result.providerId || '',result.error || null,id);
    try {
      while(true) {
        const candidates=db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 20").all();
        if(!candidates.length)break;
        const claimed=[];
        for(const row of candidates) {
          const message=JSON.parse(row.payload);
          if(message.subscriberId && get(message.subscriberId)?.status!=='confirmed') {
            db.prepare("UPDATE outbox SET status='cancelled' WHERE id=? AND status='pending'").run(row.id);continue;
          }
          if(db.prepare("UPDATE outbox SET status='sending' WHERE id=? AND status='pending'").run(row.id).changes)claimed.push({...row,message});
        }
        for(const stream of ['transactional','bulk']) {
          const group=claimed.filter(row=>(row.message.stream || 'transactional')===stream).filter(row=>{if(row.message.subscriberId && get(row.message.subscriberId)?.status!=='confirmed'){save(row.id,{status:'cancelled'});return false}return true});
          if(!group.length)continue;
          // An injected single sender is useful for isolated workflow tests.
          if(group.length===1 || deliver!==sendMail) {
            for(const row of group) {
              try {const result=await deliver(row.message);if(!['accepted','logged'].includes(result?.status))throw Object.assign(new Error('Unrecognized send result.'),{uncertain:true});save(row.id,result);}
              catch(error){save(row.id,{status:error.uncertain?'unknown':'failed',error:error.message || 'Sending failed.'});}
            }
          } else {
            try {
              const results=await deliverBatch(group.map(row=>row.message));
              if(!Array.isArray(results)||results.length!==group.length||results.some(result=>!['accepted','logged','failed','unknown'].includes(result?.status)))throw Object.assign(new Error('Unrecognized batch results.'),{uncertain:true});
              results.forEach((result,index)=>save(group[index].id,result));
            } catch(error){group.forEach(row=>save(row.id,{status:error.uncertain?'unknown':'failed',error:error.message || 'Batch sending failed.'}));}
          }
        }
      }
    } finally {flushing=false;}
  }
  async function submit(input, identity='local') {
    const parsed=submissionSchema.safeParse(input);
    if(!parsed.success)throw new AppError(parsed.error.issues[0].message);
    const data=parsed.data;
    rateLimit(db,`ip:${identity}`);
    if(data.email)rateLimit(db,`recipient:${data.email}`,3);
    if(data.second_email)rateLimit(db,`recipient:${data.second_email}`,3);
    const result=atomic(()=>onSubmit(data));
    await flush();
    let message=result.message || config.success;
    if(result.id){
      const states=db.prepare('SELECT status FROM outbox WHERE dedupe_key LIKE ?').all(`${result.id}:%`).map(row=>row.status);
      if(states.some(state=>['failed','unknown','pending','sending'].includes(state)))message+=' The email has not been confirmed as sent yet; the operator can review its status.';
      else if(states.includes('logged'))message+=' The email was recorded locally; no message was sent.';
    }
    return {ok:true,message,id:result.id || null};
  }
  async function action(input) {
    const result=atomic(()=>onAction(input));await flush();return result;
  }
  function access(raw) {
    const grant=inspectToken(raw);
    if(!grant || !grant.record)throw new AppError('This link is invalid, expired, or already used.',410);
    return {action:grant.action, title:config.title, token:raw, description:accessDescription(grant), recordId:grant.record_id};
  }
  async function redeem(raw, decision) {
    const result=atomic(()=>{
      const grant=inspectToken(raw);
      if(!grant || !grant.record)throw new AppError('This link is invalid, expired, or already used.',410);
      const value=onRedeem(grant,decision);consume(raw);return value;
    });
    await flush();return result;
  }
  function adminView() {return {records:records(config.kind),outbox:db.prepare('SELECT id,status,error,provider_id,created_at FROM outbox ORDER BY created_at DESC LIMIT 200').all(),extra:adminExtra()};}
  function retryFailed() {db.prepare("UPDATE outbox SET status='pending',error=NULL WHERE status='failed'").run();return flush();}
  return {store,submit,action,access,redeem,publicView,adminView,flush,retryFailed};
}
let singleton;
export function service() {return singleton ||= createService();}
