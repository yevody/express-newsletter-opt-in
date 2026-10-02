import './env.js';
import { createHash, timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function baseUrl() {
  const value=process.env.APP_URL || 'http://localhost:3000';
  const url=new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('APP_URL must be an HTTP(S) origin.');
  return url.origin;
}
export function requireAdmin(headers) {
  const password=process.env.ADMIN_PASSWORD;
  if (!password || password.length < 16) throw new AppError('Configure an ADMIN_PASSWORD of at least 16 characters to use operator actions.',503);
  const auth=headers.get('authorization') || '';
  let supplied='';
  if (auth.startsWith('Basic ')) {
    const decoded=Buffer.from(auth.slice(6),'base64').toString();
    const colon=decoded.indexOf(':');
    if(decoded.slice(0,colon)==='admin') supplied=decoded.slice(colon+1);
  }
  const digest=s=>createHash('sha256').update(s).digest();
  if (!timingSafeEqual(digest(password),digest(supplied))) throw new AppError('Operator sign-in required.',401);
}
export function sameOrigin(headers) {
  const origin=headers.get('origin');
  if (origin !== baseUrl()) throw new AppError('The request origin does not match APP_URL.',403);
}
export function rateLimit(db, key, max=12, windowMs=3600000) {
  const now=Date.now();
  const bucket=createHash('sha256').update(key).digest('hex');
  db.prepare('DELETE FROM limits WHERE reset_at<=?').run(now);
  db.prepare('INSERT OR IGNORE INTO limits VALUES (?,0,?)').run(bucket,now+windowMs);
  const change=db.prepare('UPDATE limits SET count=count+1 WHERE bucket=? AND count<?').run(bucket,max);
  if (!change.changes) throw new AppError('Too many requests. Please try again later.',429);
}
export function safeError(error) { return error instanceof AppError ? error.message : 'The action could not be completed. Please try again.'; }
export function responseHeaders(extra={}) { return {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',...extra}; }
