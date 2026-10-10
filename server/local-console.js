import express from 'express';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import path from 'node:path';

// 独立监听回环地址，共享当前实例的运行状态和数据库；不经过公网应用的路由。
export async function createLocalConsole({root,port,overview,restart,isRestarting,production}){
  const app=express(),server=createServer(app);let vite;
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
    const forwarded=Object.keys(req.headers).some(name=>name==='forwarded'||name.startsWith('x-forwarded-')||name==='cf-connecting-ip'||name==='cf-ray');
    let originOK=true;try{if(req.headers.origin)originOK=new URL(req.headers.origin).origin===`http://${req.headers.host}`;}catch{originOK=false;}
    if(!allowedHosts.has(req.headers.host)||forwarded||!originOK||req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'控制台仅允许本机直接访问。'});
    if(isRestarting())return res.status(503).json({error:'服务正在重启，请稍后重试。'});
    next();
  });
  app.use(express.json({limit:'8kb'}));
  app.get('/api/me',(req,res)=>res.json({console:true}));
  app.get('/api/admin/overview',(req,res)=>res.json(overview()));
  app.post('/api/admin/restart',restart);
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在。'}));
  if(production){
    app.get('/',(req,res)=>res.sendFile(path.join(root,'dist-console','console.html')));
    app.use(express.static(path.join(root,'dist-console'),{index:false}));
  }else{
    const {createServer:createVite}=await import('vite');
    vite=await createVite({root,configFile:path.join(root,'vite.console.config.js'),server:{middlewareMode:true,hmr:{server}},appType:'mpa'});
    app.get('/',async(req,res,next)=>{try{const html=await vite.transformIndexHtml('/console.html',readFileSync(path.join(root,'console.html'),'utf8'));res.type('html').send(html);}catch(error){next(error);}});
    app.use(vite.middlewares);
  }
  app.use((req,res)=>res.sendStatus(404));
  app.use((error,req,res,next)=>{if(!res.headersSent)res.status(500).json({error:'控制台暂时无法完成请求，请重试。'});});
  server.on('upgrade',(req,socket)=>{
    if(production||![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)||req.headers.origin!==`http://${req.headers.host}`)socket.destroy();
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});}
  catch(error){await vite?.close();throw error;}
  return {server,async close(){await vite?.close();await new Promise(resolve=>server.close(resolve));}};
}
