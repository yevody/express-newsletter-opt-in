import './env.js';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import config from './config.js';

export class MailError extends Error {
  constructor(message, uncertain = false) { super(message); this.uncertain = uncertain; }
}
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function settings(env = process.env, stream = 'transactional', batch = false) {
  const mode = env.MAIL_MODE || 'sandbox';
  if (!['sandbox', 'production', 'log'].includes(mode)) throw new MailError('MAIL_MODE must be sandbox, production, or log.');
  if (!['transactional', 'bulk'].includes(stream)) throw new MailError('Unknown sending stream.');
  if (mode === 'log' && env.NODE_ENV === 'production') throw new MailError('Log transport is disabled in production.');
  const from = env.MAIL_FROM || '';
  if (mode !== 'log' && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(from)) throw new MailError('Set MAIL_FROM to a valid sender address.');
  const apiToken = mode === 'production' ? env.MAILTRAP_PRODUCTION_TOKEN : env.MAILTRAP_SANDBOX_TOKEN;
  if (mode !== 'log' && !apiToken) throw new MailError('Email API credentials are not configured.');
  if (mode === 'sandbox' && !/^\d+$/.test(env.MAILTRAP_INBOX_ID || '')) throw new MailError('Set MAILTRAP_INBOX_ID to the Sandbox inbox ID.');
  const operation = batch ? 'batch' : 'send';
  const endpoint = mode === 'production'
    ? `https://${stream === 'bulk' ? 'bulk' : 'send'}.api.mailtrap.io/api/${operation}`
    : `https://sandbox.api.mailtrap.io/api/${operation}/${env.MAILTRAP_INBOX_ID}`;
  return {mode, from, apiToken, endpoint};
}

export function buildPayload(message, cfg, env = process.env) {
  const payload = {
    from: {email:cfg.from || 'preview@example.com', name:config.title},
    to: message.to.map(email => ({email})),
    custom_variables: message.customVariables || {},
    headers: message.headers || {},
    ...(message.replyTo ? {reply_to:{email:message.replyTo}} : {}),
    ...(message.attachments ? {attachments:message.attachments} : {})
  };
  const template = message.templateVariables && env[cfg.mode === 'production' ? 'MAILTRAP_TEMPLATE_UUID' : 'MAILTRAP_SANDBOX_TEMPLATE_UUID'];
  if (template) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(template)) throw new MailError('Configure a valid template UUID.');
    // Subject, content, and category belong to the hosted template.
    return {...payload, template_uuid:template, template_variables:message.templateVariables};
  }
  return {...payload, subject:message.subject, text:message.text,
    html:message.html || `<div style="font:16px/1.65 system-ui;color:#202939;max-width:600px"><h1 style="font-size:22px">${escapeHtml(message.subject)}</h1>${message.text.split('\n').map(line=>`<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('')}</div>`,
    category:message.category || config.kind};
}

function preview(payload, env) {
  const file = resolve(env.MAIL_LOG_PATH || '.data/emails.jsonl');
  mkdirSync(dirname(file), {recursive:true, mode:0o700});
  appendFileSync(file, JSON.stringify(payload)+'\n', {mode:0o600});
  return {providerId:'local-log', status:'logged'};
}
async function request(cfg, payload, dependencies) {
  let response;
  try {
    response = await (dependencies.fetch || fetch)(cfg.endpoint, {
      method:'POST', redirect:'error', headers:{'Content-Type':'application/json', Authorization:`Bearer ${cfg.apiToken}`},
      body:JSON.stringify(payload), signal:AbortSignal.timeout(15000)
    });
  } catch { throw new MailError('The send result is unknown. Check provider logs before retrying.', true); }
  // A server failure or request timeout can happen after acceptance.
  if (!response.ok) throw new MailError(`Email provider returned HTTP ${response.status}.`, response.status >= 500 || response.status === 408 || response.status < 400);
  try { return await response.json(); }
  catch { throw new MailError('Provider response could not be read. Check logs before retrying.', true); }
}
function accepted(result, recipients) {
  if (result?.success === false && (!result.message_ids || result.message_ids.length === 0)) throw new MailError('Email provider did not accept the message.');
  if (result?.success !== true || !Array.isArray(result.message_ids) || result.message_ids.length !== recipients || result.message_ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new MailError('Provider acceptance could not be verified. Check logs before retrying.', true);
  }
  return {providerId:result.message_ids.join(','), status:'accepted'};
}
export async function sendMail(message, dependencies = {}) {
  const env = dependencies.env || process.env;
  const cfg = settings(env, message.stream);
  const payload = buildPayload(message, cfg, env);
  if (cfg.mode === 'log') return preview(payload, env);
  return accepted(await request(cfg, payload, dependencies), payload.to.length);
}

export async function sendBatch(messages, dependencies = {}) {
  if (!messages.length || messages.length > 100) throw new MailError('This app batches between 1 and 100 messages.');
  const env = dependencies.env || process.env;
  const stream = messages[0].stream || 'transactional';
  if (messages.some(message => (message.stream || 'transactional') !== stream)) throw new MailError('Batch streams must match.');
  const cfg = settings(env, stream, true);
  const payloads = messages.map(message => buildPayload(message, cfg, env));
  if (cfg.mode === 'log') return payloads.map(payload => preview(payload, env));
  const result = await request(cfg, {base:{from:payloads[0].from}, requests:payloads.map(({from, ...item}) => item)}, dependencies);
  if (!Array.isArray(result?.responses) || result.responses.length !== messages.length) throw new MailError('Batch outcomes could not be matched. Check provider logs.', true);
  // HTTP 200 is not enough: preserve each recipient's individual outcome.
  return result.responses.map((item, index) => {
    try { return accepted(item, payloads[index].to.length); }
    catch (error) { return {status:error.uncertain ? 'unknown' : 'failed', error:error.message}; }
  });
}
