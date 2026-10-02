import config from './config.js';
import {service} from './service.js';
import {AppError, requireAdmin, sameOrigin, safeError, responseHeaders} from './security.js';
import {homeHtml,adminHtml,accessHtml,messageHtml} from './views.js';

export const html=(body,status=200,extra={})=>new Response(body,{status,headers:responseHeaders({'Content-Type':'text/html; charset=utf-8',...extra})});
export function failResponse(error) {
  const status=error instanceof AppError?error.status:500;
  return html(messageHtml(safeError(error),true),status,status===401?{'WWW-Authenticate':'Basic realm="Operator", charset="UTF-8"'}:{});
}
export async function parseBody(request) {
  const contentType=request.headers.get('content-type') || '';
  if(Number(request.headers.get('content-length') || 0)>16000)throw new AppError('The request is too large.',413);
  const reader=request.body?.getReader();let size=0;const chunks=[];
  if(reader){while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16000){await reader.cancel();throw new AppError('The request is too large.',413)}chunks.push(Buffer.from(value))}}
  const raw=Buffer.concat(chunks).toString('utf8');
  try {
    if(contentType.includes('application/json'))return JSON.parse(raw || '{}');
    if(contentType.includes('application/x-www-form-urlencoded'))return Object.fromEntries(new URLSearchParams(raw));
  }catch{throw new AppError('The request body could not be read.')}
  throw new AppError('Use JSON or a URL-encoded form.',415);
}
export async function handle(request,identity='shared-client') {
  try {
    const {pathname}=new URL(request.url);
    if(pathname==='/health')return Response.json({ok:true},{headers:responseHeaders()});
    if(request.method==='GET' && pathname==='/admin'){requireAdmin(request.headers);return html(adminHtml(service().adminView()))}
    if(request.method==='GET' && pathname.startsWith('/access/'))return html(accessHtml(service().access(decodeURIComponent(pathname.slice(8)))));
    if(request.method!=='POST')throw new AppError('Not found.',404);
    sameOrigin(request.headers);
    const input=await parseBody(request);
    if(pathname==='/api/submit') {
      if(config.adminOnly)requireAdmin(request.headers);
      const result=await service().submit(input,identity);
      if(request.headers.get('accept')?.includes('application/json'))return Response.json(result,{headers:responseHeaders()});
      return html(homeHtml(service().publicView(),result.message));
    }
    if(pathname==='/api/admin') {
      requireAdmin(request.headers);
      const result=await service().action(input);
      return html(adminHtml(service().adminView(),result.message,result.url));
    }
    if(pathname==='/api/redeem') {
      const result=await service().redeem(input.token,input.decision);
      if(result.download)return new Response(result.download,{headers:responseHeaders({'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="project-kickoff-checklist.txt"'})});
      return html(messageHtml(result.message));
    }
    throw new AppError('Not found.',404);
  }catch(error){
    if(request.headers.get('accept')?.includes('application/json'))return Response.json({ok:false,message:safeError(error)},{status:error instanceof AppError?error.status:500,headers:responseHeaders(error.status===401?{'WWW-Authenticate':'Basic realm="Operator"'}:{})});
    return failResponse(error);
  }
}
