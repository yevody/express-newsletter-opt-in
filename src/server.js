import './core/env.js';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import ejs from 'ejs';
import config from './core/config.js';
import {service,jsonSchema} from './core/service.js';
import {requireAdmin,responseHeaders} from './core/security.js';
import {handle,failResponse} from './core/http.js';
import {formFields,detailsHtml,rowsHtml} from './core/views.js';
import express from 'express';
function webRequest(req){const headers=new Headers();for(const [key,value] of Object.entries(req.headers)){if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):String(value))}const method=req.method;const body=['GET','HEAD'].includes(method)?undefined:JSON.stringify(req.body||{});if(body!==undefined){headers.set('content-type','application/json');headers.delete('content-length')}return new Request((process.env.APP_URL||'http://localhost:3000')+(req.url||'/'),{method,headers,body})}
async function rootPage(req){try{if(config.adminOnly)requireAdmin(new Headers(req.headers));return new Response(await ejs.renderFile(resolve('views/index.ejs'),{config,model:service().publicView(),formFields,detailsHtml,rowsHtml}),{headers:responseHeaders({'content-type':'text/html; charset=utf-8'})})}catch(error){return failResponse(error)}}
export async function createServer(){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
 app.use(express.urlencoded({extended:false,limit:'16kb'}));app.use(express.json({limit:'16kb'}));
 app.use(express.static(resolve('public'),{index:false}));
 const send=async(res,response)=>{res.status(response.status);response.headers.forEach((value,key)=>res.set(key,value));res.send(Buffer.from(await response.arrayBuffer()))};
 app.get('/',async(req,res)=>send(res,await rootPage(req)));
 app.all(['/api/submit','/api/admin','/api/redeem','/admin','/access/:token','/health'],async(req,res)=>send(res,await handle(webRequest(req),req.socket.remoteAddress||'shared-client')));
 app.use((error,req,res,next)=>{res.status(error.status||500).send('The request could not be read. Check its size and format.');});
 return app;
}
async function start(app){const port=Number(process.env.PORT||3000);await new Promise(resolve=>app.listen(port,process.env.HOST||'127.0.0.1',resolve));console.log(`Ready at http://${process.env.HOST||'127.0.0.1'}:${port}`)}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const app=await createServer();await start(app);}
