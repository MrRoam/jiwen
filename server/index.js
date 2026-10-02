import {createAnswerRouter,routingConfig} from './answer-router.js';
import {initAccounts,registerAccount,isAdmin,normalizeEmail,validEmail} from './accounts.js';
import {createServiceConfig} from './service-config.js';
import {initPasswordResets,issueResetCode,applyPasswordReset} from './password-reset.js';
import {mailConfigured,sendMail} from './mail.js';
import {requestBudget} from './limits.js';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, createReadStream, createWriteStream, rmSync, statSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { openDatabase } from './db.js';
import { AudioTimeline } from './audio-timeline.js';
import { snapshotContext, modelMessages, resolveContext } from './context.js';
import { paraformer, testService } from './providers.js';
import {localASR,testLocalASR} from './local-asr.js';
import {createImportanceService} from './importance.js';
import {createTeacherQuestionService} from './teacher-questions.js';
import {registerHelpRoute} from './help.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=path.resolve(process.env.DATA_DIR||path.join(root,'data'));
const db=openDatabase(dataDir),app=express(),server=createServer(app);
// 暂停 Jev 功能；仅显式启用时才读取密钥和处理队列。
const jevEnabled=process.env.JEV_ENABLED==='true';
const jevOptions=jevEnabled?{}:{key:''};
const importance=createImportanceService(db,jevOptions);
const teacherQuestions=createTeacherQuestionService(db,jevOptions);
if(!jevEnabled){importance.close();teacherQuestions.close();}
initAccounts(db);
initPasswordResets(db);
const id=()=>randomUUID(),now=()=>new Date().toISOString();
const get=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
const serviceConfig=createServiceConfig(dataDir);
let serviceEnv,asrKey,asrUrl,asrModel,localMode,asrReady,localUrl,runtimeRouter;
const audioLimit=Number(process.env.MONTHLY_AUDIO_SECONDS||36000),questionLimit=Number(process.env.DAILY_QUESTIONS||120);
const secure=process.env.SECURE_COOKIE==='true',maxUsers=Number(process.env.MAX_USERS||100);
const adminEmail=normalizeEmail(process.env.ADMIN_EMAIL||'');
if(adminEmail&&!validEmail(adminEmail))throw new Error('ADMIN_EMAIL 格式不正确。');
const globalDaily=Number(process.env.GLOBAL_DAILY_QUESTIONS||800),perMinute=Number(process.env.GLOBAL_REQUESTS_PER_MINUTE||18);
if(![maxUsers,questionLimit,globalDaily,perMinute].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('账号名额及问答额度必须是正整数。');
const reserveRequest=requestBudget(db,{perUser:questionLimit,daily:globalDaily,perMinute});
function applyServiceConfig(){
  serviceEnv=serviceConfig.env();
  asrKey=serviceEnv.DASHSCOPE_API_KEY||'';asrUrl=serviceEnv.ASR_WS_URL;asrModel=serviceEnv.ASR_MODEL;
  localMode=serviceEnv.ASR_PROVIDER==='local';asrReady=localMode||!!asrKey;
  localUrl=serviceEnv.LOCAL_ASR_URL.replace(/\/$/,'');
  if(localMode&&!['127.0.0.1','localhost','[::1]'].includes(new URL(localUrl).hostname))throw new Error('本地转写地址必须指向本机。');
  runtimeRouter=createAnswerRouter({db,reserveRequest,...routingConfig(serviceEnv)});
}
applyServiceConfig();
// HELP 路由持有这个稳定对象，保存设置后也使用新配置。
const answerRouter={get ready(){return runtimeRouter.ready;},status(){return runtimeRouter.status();},answer(options){return runtimeRouter.answer(options);}};
const active=new Map(),liveASR=new Map(),chatBusy=new Set(),chatControllers=new Map(),finalizing=new Set();
if(process.env.HOST && !['localhost','127.0.0.1','::1'].includes(process.env.HOST) && !secure)throw new Error('对外服务必须配置 HTTPS 安全 Cookie。');
app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');if(req.path.startsWith('/api'))res.setHeader('Cache-Control','no-store');next();});
app.use('/api',(req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && new URL(origin).host!==req.headers.host)return res.status(403).json({error:'请求来源不匹配。'});
  if(['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'不允许跨站请求。'});
  next();
});
app.use(express.json({limit:'100kb'}));
function userFor(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tingjian='))?.slice(9);return token?get('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND users.email IS NOT NULL',createHash('sha256').update(token).digest('hex'),Date.now()):null;}
function session(res,userId){const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',createHash('sha256').update(token).digest('hex'),userId,Date.now()+30*86400000);res.cookie('tingjian',token,{httpOnly:true,sameSite:'strict',secure,maxAge:30*86400000,path:'/'});}
function verifyPassword(password,stored){const [salt,key]=stored.split(':');return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(key,'hex'));}
const attempts=new Map();
app.post('/api/auth/:action',async(req,res)=>{
  const address=req.socket.remoteAddress;let entry=attempts.get(address);if(!entry||entry.until<Date.now())entry={count:0,until:Date.now()+600000};attempts.set(address,entry);
  if(++entry.count>40)return res.status(429).json({error:'尝试过于频繁，请稍后再试。'});
  if(req.params.action==='register'){
    const result=registerAccount(db,req.body,maxUsers);
    if(result.error)return res.status(result.status).json({error:result.error});
    session(res,result.user.id);return res.json(result.user);
  }
  if(req.params.action==='change-password'){
    const user=userFor(req);
    if(!user)return res.status(401).json({error:'请先登录。'});
    const {oldPassword,newPassword}=req.body;
    if(typeof oldPassword!=='string'||typeof newPassword!=='string'||newPassword.length<8||newPassword.length>128)return res.status(400).json({error:'请填写当前密码和 8～128 位新密码。'});
    if(!verifyPassword(oldPassword,user.password))return res.status(401).json({error:'当前密码不正确。'});
    const salt=randomBytes(16).toString('hex');
    run('UPDATE users SET password=? WHERE id=?',`${salt}:${scryptSync(newPassword,salt,64).toString('hex')}`,user.id);
    return res.json({ok:true});
  }
  if(req.params.action==='request-reset'){
    const email=normalizeEmail(typeof req.body.email==='string'?req.body.email:'');
    if(!validEmail(email))return res.status(400).json({error:'请填写有效邮箱。'});
    if(!mailConfigured())return res.status(503).json({error:'邮件服务尚未配置，请联系管理员重置密码。'});
    // 只给已注册邮箱发码，未注册邮箱返回同样的话术，避免暴露注册情况。
    if(get('SELECT id FROM users WHERE email=? COLLATE NOCASE',email)){
      const issued=issueResetCode(db,email);
      if(issued.error)return res.status(issued.status).json({error:issued.error});
      try{const english=req.body.locale==='en';await sendMail({to:email,
        subject:english?`Jiwen · Password reset code ${issued.code}`:`即问 · 重置密码验证码 ${issued.code}`,
        text:english?`You requested a password reset for Jiwen. Your verification code is ${issued.code}. It expires in 10 minutes. If you did not request this, please ignore this email.`:`你正在重置即问的登录密码，验证码是 ${issued.code}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`});}
      catch(error){console.error('验证码邮件发送失败:',error.message);return res.status(502).json({error:'验证码邮件发送失败，请稍后再试。'});}
    }
    return res.json({ok:true,message:'如果该邮箱已注册，验证码已发出，请查收（10 分钟内有效）。'});
  }
  if(req.params.action==='reset-password'){
    const result=applyPasswordReset(db,req.body);
    if(result.error)return res.status(result.status).json({error:result.error});
    return res.json({ok:true});
  }
  if(req.params.action!=='login')return res.sendStatus(404);
  const email=normalizeEmail(req.body.email),password=req.body.password;
  if(!validEmail(email)||typeof password!=='string'||password.length<8||password.length>128)return res.status(400).json({error:'请填写有效邮箱和 8～128 位密码。'});
  const user=get('SELECT * FROM users WHERE email=? COLLATE NOCASE',email);
  if(!user||!verifyPassword(password,user.password))return res.status(401).json({error:'邮箱或密码不正确。'});
  session(res,user.id);res.json({id:user.id,email:user.email});
});
function publicConfig(){return {asrReady,jevEnabled,jevReady:importance.ready,llmReady:answerRouter.ready,asrProvider:localMode?'local':'remote',asrModel:localMode?serviceEnv.LOCAL_ASR_MODEL:asrModel,registrationOpen:get('SELECT COUNT(*) n FROM users WHERE email IS NOT NULL').n<maxUsers,dailyQuestions:questionLimit,mailReady:mailConfigured()};}
app.get('/api/me',(req,res)=>{const user=userFor(req);res.json({user:user?{id:user.id,email:user.email,isAdmin:isAdmin(db,user,adminEmail)}:null,config:publicConfig()});});
app.use('/api',(req,res,next)=>{req.user=userFor(req);if(!req.user)return res.status(401).json({error:'请先登录。'});next();});
app.post('/api/logout',(req,res)=>{const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tingjian='))?.slice(9);if(token)run('DELETE FROM sessions WHERE token=?',createHash('sha256').update(token).digest('hex'));res.clearCookie('tingjian',{path:'/'});res.json({ok:true});});
const serviceTests=new Set();
function requireAdmin(req,res,next){if(!isAdmin(db,req.user,adminEmail))return res.status(403).json({error:'只有实例管理员可以修改 API 配置。'});next();}
function configIdle(req,res,next){if(active.size||liveASR.size||finalizing.size||chatBusy.size||serviceTests.size)return res.status(409).json({error:'有人正在录音、保存、回答或测试，请结束后再修改 API 配置。'});next();}
app.get('/api/services/config',requireAdmin,(req,res)=>res.json(serviceConfig.summary()));
app.put('/api/services/config',requireAdmin,configIdle,(req,res)=>{
  try{const settings=serviceConfig.update(req.body);applyServiceConfig();res.json({settings,config:publicConfig()});}
  catch(error){res.status(error.cause?500:400).json({error:error.message});}
});
app.delete('/api/services/config/:service',requireAdmin,configIdle,(req,res)=>{
  try{const settings=serviceConfig.clear(req.params.service);applyServiceConfig();res.json({settings,config:publicConfig()});}
  catch(error){res.status(error.cause?500:400).json({error:error.message});}
});

app.post('/api/services/test',async(req,res)=>{
  const service=req.body.service;
  if(service==='jev'&&!jevEnabled)return res.status(503).json({error:'Jev 功能已暂停。'});
  if(!['asr','llm','jev'].includes(service))return res.status(400).json({error:'请选择转写或问答服务。'});
  const token=`${req.user.id}:${service}`;
  if(serviceTests.has(token))return res.status(409).json({error:'正在测试，请稍候。'});
  if(service==='llm'&&!answerRouter.ready)return res.status(503).json({error:'问答服务尚未配置。'});
  serviceTests.add(token);
  const waiting=new AbortController();res.on('close',()=>{if(!res.writableEnded)waiting.abort();});
  let permit;
  try{if(service==='llm'){permit=await reserveRequest.acquire(req.user.id,waiting.signal);if(permit.error){serviceTests.delete(token);return res.status(429).json({error:permit.error});}}}catch(error){serviceTests.delete(token);if(waiting.signal.aborted)return;throw error;}
  try{
    if(service==='jev'){try{await importance.test(req.user.id,waiting.signal);return res.json(await teacherQuestions.test(req.user.id,waiting.signal));}catch(error){return res.json({ok:false,message:error.message});}}
    if(service==='llm'){
      const started=Date.now();let text='';
      try{const route=await answerRouter.answer({userId:req.user.id,permit,signal:AbortSignal.any([waiting.signal,AbortSignal.timeout(30000)]),messages:[{role:'user',content:'请只回复“连接成功”。'}],onText:value=>text+=value});if(!text.trim())throw new Error('问答服务没有返回内容。');return res.json({ok:true,message:'问答接口已返回测试回答。',model:route.model,elapsedMs:Date.now()-started});}
      catch(error){return res.json({ok:false,message:error.message,elapsedMs:Date.now()-started});}
    }
    if(localMode)return res.json(await testLocalASR(localUrl));
    res.json(await testService({service,key:asrKey,url:asrUrl,model:asrModel}));
  }
  finally{permit?.release();serviceTests.delete(token);}
});
function lesson(req,res,lessonId=req.params.lessonId){const row=get('SELECT * FROM lessons WHERE id=? AND user_id=?',lessonId,req.user.id);if(!row)res.status(404).json({error:'课堂不存在。'});return row;}
function recording(req,res){const row=get('SELECT recordings.* FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE recordings.id=? AND lessons.user_id=?',req.params.recordingId,req.user.id);if(!row)res.status(404).json({error:'录音不存在。'});return row;}
function conversation(req,res){const row=get('SELECT conversations.* FROM conversations JOIN lessons ON lessons.id=conversations.lesson_id WHERE conversations.id=? AND lessons.user_id=?',req.params.conversationId,req.user.id);if(!row)res.status(404).json({error:'对话不存在。'});return row;}
registerHelpRoute(app,{db,lesson,reserveRequest,answerRouter,chatBusy,chatControllers});
app.get('/api/lessons/:lessonId/importance',(req,res)=>{const row=lesson(req,res);if(row)res.json(jevEnabled?importance.snapshot(row.id):{enabled:false,ready:false,results:[],pending:0,failed:0,error:null});});
app.get('/api/lessons/:lessonId/teacher-questions',(req,res)=>{const row=lesson(req,res);if(row)res.json({ready:teacherQuestions.ready,questions:jevEnabled?teacherQuestions.results(row.id):[]});});
app.patch('/api/lessons/:lessonId/importance',(req,res)=>{
  const row=lesson(req,res);if(!row)return;
  if(!jevEnabled)return res.status(503).json({error:'Jev 功能已暂停。'});
  if(typeof req.body.enabled!=='boolean')return res.status(400).json({error:'开关状态无效。'});
  try{importance.setEnabled(row.id,req.body.enabled);res.json(importance.snapshot(row.id));}catch(error){res.status(503).json({error:error.message});}
});
app.post('/api/lessons/:lessonId/importance/analyze',(req,res)=>{
  const row=lesson(req,res);if(!row)return;
  if(!jevEnabled)return res.status(503).json({error:'Jev 功能已暂停。'});
  if(!importance.ready)return res.status(503).json({error:'重点标记尚未配置。'});
  try{importance.backfill(row.id);res.json(importance.snapshot(row.id));}catch(error){res.status(409).json({error:error.message});}
});
app.get('/api/lessons',(req,res)=>res.json(all('SELECT lessons.*, (SELECT COALESCE(SUM(duration_ms),0) FROM recordings WHERE lesson_id=lessons.id) AS duration_ms,(SELECT COUNT(*) FROM conversations WHERE lesson_id=lessons.id) AS conversation_count FROM lessons WHERE user_id=? AND (EXISTS(SELECT 1 FROM recordings WHERE lesson_id=lessons.id) OR EXISTS(SELECT 1 FROM segments WHERE lesson_id=lessons.id) OR EXISTS(SELECT 1 FROM conversations WHERE lesson_id=lessons.id)) ORDER BY created_at DESC',req.user.id)));
app.post('/api/lessons',(req,res)=>{if(req.body.importanceEnabled===true&&!importance.ready)return res.status(503).json({error:'重点标记尚未配置。'});const lid=id();run('INSERT INTO lessons VALUES(?,?,?,?,0)',lid,req.user.id,String(req.body.title||'未命名课堂').slice(0,80),now());if(req.body.importanceEnabled===true)importance.setEnabled(lid,true);res.json({id:lid});});
app.get('/api/lessons/:lessonId',(req,res)=>{const row=lesson(req,res);if(!row)return;res.json({...row,recordings:all('SELECT * FROM recordings WHERE lesson_id=? ORDER BY offset_ms',row.id),segments:all('SELECT * FROM segments WHERE lesson_id=? ORDER BY start_ms',row.id),conversations:all('SELECT id,title,anchor_ms,created_at FROM conversations WHERE lesson_id=? ORDER BY created_at DESC',row.id)});});
app.patch('/api/lessons/:lessonId',(req,res)=>{const row=lesson(req,res);if(!row)return;const title=String(req.body.title||'').trim().slice(0,80);if(!title)return res.status(400).json({error:'请输入课堂名称。'});run('UPDATE lessons SET title=? WHERE id=?',title,row.id);res.json({ok:true});});
app.delete('/api/lessons/:lessonId',(req,res)=>{const row=lesson(req,res);if(!row)return;const recs=all('SELECT id FROM recordings WHERE lesson_id=?',row.id);if(recs.some(r=>active.has(r.id)||finalizing.has(r.id)||playbackFiles.has(r.id)))return res.status(409).json({error:'请先停止录音并等待保存。'});const cs=all('SELECT id FROM conversations WHERE lesson_id=?',row.id);if(cs.some(c=>chatBusy.has(c.id)))return res.status(409).json({error:'请等待回答完成后删除。'});importance.setEnabled(row.id,false);run('DELETE FROM lessons WHERE id=?',row.id);for(const r of recs)rmSync(path.join(dataDir,r.id),{recursive:true,force:true});res.json({ok:true});});

app.post('/api/lessons/:lessonId/conversations',(req,res)=>{
  const row=lesson(req,res);if(!row)return;
  const anchor=Number(req.body.anchorMs);if(!Number.isFinite(anchor)||anchor<0||anchor>86400000)return res.status(400).json({error:'课堂时间无效。'});
  const segments=all('SELECT * FROM segments WHERE lesson_id=? ORDER BY start_ms',row.id);
  const selected=req.body.selectedId||null;if(selected&&!segments.some(s=>s.id===selected))return res.status(400).json({error:'所选转写不属于此课堂。'});
  const quotes=req.body.quotes??[];
  if(!Array.isArray(quotes)||quotes.length>20||quotes.some(q=>!q||typeof q.text!=='string'||!q.text.trim()||!segments.some(s=>s.id===q.id&&s.text.includes(q.text)))||quotes.reduce((n,q)=>n+q.text.length,0)>6000)return res.status(400).json({error:'引用无效或过长，请重新选择（最多 20 处、6000 字）。'});
  const verified=quotes.map(q=>{const s=segments.find(s=>s.id===q.id);return {id:s.id,text:q.text,startMs:s.start_ms,endMs:s.end_ms};});
  const snapshot=snapshotContext(segments,verified[0]?.startMs??anchor,selected,verified),cid=id();run('INSERT INTO conversations VALUES(?,?,?,?,?,?)',cid,row.id,String(req.body.title||'新问题').slice(0,60),snapshot.anchorMs,JSON.stringify(snapshot),now());res.json({id:cid,snapshot});
});
function classroomContext(row){return resolveContext(JSON.parse(row.snapshot),all('SELECT * FROM segments WHERE lesson_id=? ORDER BY start_ms',row.lesson_id));}
app.get('/api/conversations/:conversationId',(req,res)=>{const row=conversation(req,res);if(!row)return;res.json({...row,snapshot:classroomContext(row),messages:all('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid',row.id)});});
// 编辑问题创建独立分支，保留原对话及其后续回答。
app.post('/api/conversations/:conversationId/fork',(req,res)=>{
  const row=conversation(req,res);if(!row)return;
  if(chatBusy.has(row.id))return res.status(409).json({error:'请先停止当前回答。'});
  const history=all('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid',row.id);
  const index=history.findIndex(m=>m.id===req.body.messageId&&m.role==='user');
  if(index<0)return res.status(400).json({error:'找不到要修改的问题。'});
  const title=String(req.body.title||'').trim();if(!title||title.length>4000)return res.status(400).json({error:'问题需为 1～4000 字。'});
  const cid=id();run('INSERT INTO conversations VALUES(?,?,?,?,?,?)',cid,row.lesson_id,title.slice(0,60),row.anchor_ms,row.snapshot,now());
  for(const m of history.slice(0,index))run('INSERT INTO messages VALUES(?,?,?,?,?,?)',id(),cid,m.role,m.content,m.status,m.created_at);
  res.json({id:cid});
});
app.post('/api/conversations/:conversationId/stop',(req,res)=>{
  const row=conversation(req,res);if(!row)return;
  const task=chatControllers.get(row.id);if(task){task.stopped=true;task.controller.abort();}
  res.json({ok:true});
});
app.post('/api/conversations/:conversationId/messages',async(req,res)=>{
  const row=conversation(req,res);if(!row)return;
  if(!answerRouter.ready)return res.status(503).json({error:'问答服务尚未配置，请在侧栏「API 配置」中保存并测试。'});
  const content=String(req.body.content||'').trim();if(!content||content.length>4000)return res.status(400).json({error:'问题需为 1～4000 字。'});
  if(chatBusy.has(row.id))return res.status(409).json({error:'这段对话正在回答，请稍候。'});
  const history=all('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid',row.id);if(history.reduce((n,m)=>n+m.content.length,0)>48000)return res.status(400).json({error:'这段对话已较长，请新建问题继续。'});
  chatBusy.add(row.id);
  const waiting=new AbortController();res.on('close',()=>{if(!res.writableEnded)waiting.abort();});
  const task={controller:waiting,stopped:false};chatControllers.set(row.id,task);
  let permit;
  try{permit=await reserveRequest.acquire(req.user.id,waiting.signal);}catch(error){chatBusy.delete(row.id);chatControllers.delete(row.id);if(waiting.signal.aborted){if(!res.destroyed)res.end();return;}throw error;}
  if(permit.error){chatBusy.delete(row.id);chatControllers.delete(row.id);return res.status(429).json({error:permit.error});}
  const snapshot=classroomContext(row);run('UPDATE conversations SET snapshot=? WHERE id=?',JSON.stringify(snapshot),row.id);
  console.info(JSON.stringify({event:'question-context',conversationId:row.id,at:now(),anchorMs:snapshot.anchorMs,segmentCount:snapshot.segments.length,firstMs:snapshot.segments[0]?.startMs,lastMs:snapshot.segments.at(-1)?.endMs}));
  const mid=id(),aid=id();run('INSERT INTO messages VALUES(?,?,?,?,?,?)',mid,row.id,'user',content,'complete',now());run('INSERT INTO messages VALUES(?,?,?,?,?,?)',aid,row.id,'assistant','','streaming',now());
  chatBusy.add(row.id);res.setHeader('Content-Type','text/event-stream');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();const emit=value=>{if(!res.destroyed)res.write(`data: ${JSON.stringify(value)}\n\n`);};
  const controller=waiting,timeout=setTimeout(()=>controller.abort(),90000);let answer='';
  emit({type:'started',userId:mid,assistantId:aid,snapshot});
  try{await answerRouter.answer({userId:req.user.id,permit,messages:modelMessages(snapshot,[...history,{role:'user',content,status:'complete'}],req.body.locale),signal:controller.signal,onText:text=>{answer+=text;emit({type:'delta',text});}});if(task.stopped)throw new DOMException('Stopped','AbortError');if(!answer)throw new Error('问答服务没有返回内容，请重试。');run("UPDATE messages SET content=?,status='complete' WHERE id=?",answer,aid);emit({type:'done'});}
  catch(error){run("UPDATE messages SET content=?,status=? WHERE id=?",answer,task.stopped?'stopped':'failed',aid);if(task.stopped)emit({type:'done',stopped:true});else emit({type:'error',error:error.name==='AbortError'?'回答中断或超时，已保存收到的内容。':error.message});}
  finally{permit.release();clearTimeout(timeout);chatBusy.delete(row.id);chatControllers.delete(row.id);res.end();}
});

app.post('/api/lessons/:lessonId/recordings',(req,res)=>{
  const row=lesson(req,res);if(!row)return;
  if([...active.values()].some(r=>r.userId===req.user.id))return res.status(409).json({error:'账号已有录音进行中，请先停止。'});
  const used=get("SELECT COALESCE(SUM(duration_ms),0)/1000 AS seconds FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE lessons.user_id=? AND recordings.created_at>=?",req.user.id,now().slice(0,7)+'-01').seconds;
  if(used>=audioLimit)return res.status(429).json({error:'已达到本月录音额度。'});
  const mime=String(req.body.mime||'');if(!['audio/webm','audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/mp4;codecs=mp4a.40.2'].includes(mime))return res.status(400).json({error:'不支持此录音格式。'});
  const offset=get('SELECT COALESCE(MAX(offset_ms+duration_ms),0) AS t FROM recordings WHERE lesson_id=?',row.id).t,rid=id();
  mkdirSync(path.join(dataDir,rid),{recursive:true});run('INSERT INTO recordings(id,lesson_id,offset_ms,mime,created_at) VALUES(?,?,?,?,?)',rid,row.id,offset,mime,now());
  const timer=setTimeout(()=>{liveASR.get(rid)?.close();active.delete(rid);run("UPDATE recordings SET status='interrupted' WHERE id=? AND status='recording'",rid);},Math.min(audioLimit-used,3*3600)*1000+60000);timer.unref();active.set(rid,{userId:req.user.id,timer,started:Date.now()});res.json({id:rid,offsetMs:offset,maxSeconds:Math.min(audioLimit-used,3*3600),asrReady});
});
app.put('/api/recordings/:recordingId/chunks/:seq',express.raw({type:'application/octet-stream',limit:'8mb'}),(req,res)=>{
  const row=recording(req,res);if(!row)return;
  const seq=Number(req.params.seq);if(!Number.isInteger(seq)||seq<0||seq>12000||!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'录音分段无效。'});
  const hash=createHash('sha256').update(req.body).digest('hex'),existing=get('SELECT * FROM chunks WHERE recording_id=? AND seq=?',row.id,seq);
  if(existing)return existing.hash===hash?res.json({ok:true}):res.status(409).json({error:'录音分段内容冲突。'});
  if(!['recording','interrupted'].includes(row.status))return res.status(409).json({error:'录音已经结束。'});
  const chunkCount=get('SELECT COUNT(*) AS n FROM chunks WHERE recording_id=?',row.id).n;if(seq!==chunkCount)return res.status(409).json({error:'请按顺序补传录音。'});
  const duration=Number(req.headers['x-duration-ms']);if(!Number.isFinite(duration)||duration<0||duration>10860000)return res.status(400).json({error:'录音时长无效。'});
  const destination=path.join(dataDir,row.id,`${seq}.chunk`);writeFileSync(destination+'.tmp',req.body);renameSync(destination+'.tmp',destination);run('INSERT INTO chunks VALUES(?,?,?,?)',row.id,seq,req.body.length,hash);run('UPDATE recordings SET duration_ms=MAX(duration_ms,?) WHERE id=?',duration,row.id);res.json({ok:true});
});
async function finalize(row,expected){
  if(finalizing.has(row.id))throw new Error('录音正在处理，请稍候。');
  const chunks=all('SELECT * FROM chunks WHERE recording_id=? ORDER BY seq',row.id);
  if(!chunks.length)throw new Error('尚未收到音频，请先恢复上传。');
  if(expected!==undefined&&chunks.length!==expected)throw new Error('还有录音分段没有上传，请恢复上传后再试。');
  finalizing.add(row.id);const a=active.get(row.id);if(a)clearTimeout(a.timer);active.delete(row.id);liveASR.get(row.id)?.finish();run("UPDATE recordings SET status='processing' WHERE id=?",row.id);
  const folder=path.join(dataDir,row.id),input=path.join(folder,'source.bin'),output=path.join(folder,'audio.m4a');
  try{const writer=createWriteStream(input);let writeError;writer.on('error',error=>{writeError=error;});for(const chunk of chunks){for await(const buffer of createReadStream(path.join(folder,`${chunk.seq}.chunk`))){if(writeError)throw writeError;if(!writer.write(buffer))await once(writer,'drain');}}writer.end();await once(writer,'finish');
    await new Promise((resolve,reject)=>{const child=spawn(ffmpeg,['-y','-i',input,'-vn','-ac','1','-c:a','aac','-b:a','64k','-movflags','+faststart',output],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',d=>error=(error+d).slice(-2000));const timer=setTimeout(()=>{child.kill();reject(new Error('录音处理超时，原始分段已保留。'));},180000);child.on('error',()=>{clearTimeout(timer);reject(new Error('音频处理程序无法启动。'));});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('录音处理失败，原始分段已保留，可重试。'));});});
    run("UPDATE recordings SET status='ready' WHERE id=?",row.id);rmSync(input,{force:true});for(const chunk of chunks)rmSync(path.join(folder,`${chunk.seq}.chunk`),{force:true});
  }catch(error){run("UPDATE recordings SET status='interrupted' WHERE id=?",row.id);throw error;}finally{finalizing.delete(row.id);}
}
app.post('/api/recordings/:recordingId/finish',async(req,res)=>{const row=recording(req,res);if(!row)return;if(row.status==='ready')return res.json({ok:true});try{await finalize(row,req.body.chunks);res.json({ok:true});}catch(error){res.status(409).json({error:error.message});}});
app.post('/api/recordings/:recordingId/interrupt',(req,res)=>{const row=recording(req,res);if(!row)return;const a=active.get(row.id);if(a)clearTimeout(a.timer);active.delete(row.id);run("UPDATE recordings SET status='interrupted' WHERE id=? AND status='recording'",row.id);res.json({ok:true});});
app.post('/api/recordings/:recordingId/cancel',(req,res)=>{const row=recording(req,res);if(!row)return;if(get('SELECT COUNT(*) AS n FROM chunks WHERE recording_id=?',row.id).n)return res.status(409).json({error:'录音已有内容，请恢复保存。'});const a=active.get(row.id);if(a)clearTimeout(a.timer);active.delete(row.id);liveASR.get(row.id)?.close();run('DELETE FROM recordings WHERE id=?',row.id);rmSync(path.join(dataDir,row.id),{recursive:true,force:true});res.json({ok:true});});
const playbackFiles=new Map();
async function playbackFile(rid){
  const file=path.join(dataDir,rid,'audio.mp3');
  if(existsSync(file))return file;
  if(!playbackFiles.has(rid)){
    const job=new Promise((resolve,reject)=>{
      const temp=path.join(dataDir,rid,'playback.tmp.mp3');
      const child=spawn(ffmpeg,['-y','-i',path.join(dataDir,rid,'audio.m4a'),'-vn','-c:a','libmp3lame','-b:a','96k',temp],{windowsHide:true,stdio:'ignore'});
      const timer=setTimeout(()=>child.kill(),180000);
      child.on('error',()=>{clearTimeout(timer);reject(new Error('回放转换程序无法启动。'));});
      child.on('exit',code=>{clearTimeout(timer);if(code!==0){rmSync(temp,{force:true});reject(new Error('兼容回放转换失败，请重试。'));return;}try{renameSync(temp,file);resolve(file);}catch(error){reject(error);}});
    }).finally(()=>playbackFiles.delete(rid));
    playbackFiles.set(rid,job);
  }
  return playbackFiles.get(rid);
}
app.get('/api/recordings/:recordingId/audio',async(req,res)=>{const row=recording(req,res);if(!row)return;if(row.status!=='ready')return res.status(409).json({error:'录音还未完成保存。'});try{const file=req.query.format==='mp3'?await playbackFile(row.id):path.join(dataDir,row.id,'audio.m4a');res.sendFile(file);}catch(error){res.status(503).json({error:error.message});}});
app.get('/api/usage',(req,res)=>{const month=now().slice(0,7)+'-01';const seconds=get('SELECT COALESCE(SUM(seconds),0) AS n FROM asr_usage WHERE user_id=? AND created_at>=?',req.user.id,month).n;res.json({asrSeconds:seconds,estimatedAsrCost:seconds*.00024,llm:reserveRequest.usage(req.user.id)});});

const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
server.on('upgrade',(req,socket,head)=>{
  const url=new URL(req.url,'http://localhost');if(url.pathname!=='/api/asr'){if(!process.argv.includes('--production'))return;socket.destroy();return;}
  const user=userFor(req),origin=req.headers.origin;if(!user||!origin||new URL(origin).host!==req.headers.host){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}
  const rid=url.searchParams.get('recordingId'),row=get('SELECT recordings.* FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE recordings.id=? AND lessons.user_id=?',rid,user.id);
  if(!row||!asrReady||liveASR.has(rid)){socket.write('HTTP/1.1 409 Conflict\r\n\r\n');socket.destroy();return;}
  if(!active.has(rid)){
    const used=get("SELECT COALESCE(SUM(duration_ms),0)/1000 AS seconds FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE lessons.user_id=? AND recordings.created_at>=?",user.id,now().slice(0,7)+'-01').seconds;
    const remaining=Math.min((3*3600000-row.duration_ms)/1000,audioLimit-used);
    if(row.status!=='interrupted'||[...active.values()].some(r=>r.userId===user.id)||remaining<=0){socket.write('HTTP/1.1 409 Conflict\r\n\r\n');socket.destroy();return;}
    const timer=setTimeout(()=>{liveASR.get(rid)?.close();active.delete(rid);run("UPDATE recordings SET status='interrupted' WHERE id=? AND status='recording'",rid);},remaining*1000+60000);timer.unref();
    active.set(rid,{userId:user.id,timer,started:Date.now()});run("UPDATE recordings SET status='recording' WHERE id=?",rid);
    console.info(JSON.stringify({event:'asr-resumed',at:now(),recordingId:rid}));
  }
  wss.handleUpgrade(req,socket,head,client=>{
    let base=Number(url.searchParams.get('offsetMs')||0);if(!Number.isFinite(base)||base<0||base>10860000){client.close();return;}
    const timeline=new AudioTimeline(base);let packetOffset,lastDiagnostic=0,lastSegmentDiagnostic=0,pendingSentenceId=null,sentenceCount=0;
    const uid=id();run('INSERT INTO asr_usage VALUES(?,?,?,?)',uid,user.id,0,now());let bytes=0,reported=0,drainTimer;
    const emit=value=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(value));};
    const provider=(localMode?localASR:paraformer)({key:asrKey,url:localMode?localUrl:asrUrl,model:asrModel,onReady:()=>emit({type:'ready'}),onSentence:s=>{
      const start=row.offset_ms+timeline.at(s.begin_time),end=Math.max(start,row.offset_ms+timeline.at(s.end_time,true)),sid=pendingSentenceId||`${uid}-${sentenceCount++}`;
      pendingSentenceId=s.sentence_end?null:sid;
      if(Date.now()-lastSegmentDiagnostic>=30000){lastSegmentDiagnostic=Date.now();console.info(JSON.stringify({event:'asr-segment',at:now(),recordingId:rid,startMs:start,endMs:end,audioMs:timeline.duration,recordingMs:timeline.at(timeline.duration,true),final:!!s.sentence_end}));}
      run('INSERT INTO segments VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms,end_ms=excluded.end_ms,text=excluded.text,final=excluded.final',sid,row.lesson_id,rid,start,end,s.text,s.sentence_end?1:0);
      importance.enqueue({id:sid,lesson_id:row.lesson_id,start_ms:start,end_ms:end,text:s.text,final:s.sentence_end?1:0});
      teacherQuestions.enqueue({id:sid,lesson_id:row.lesson_id,start_ms:start,end_ms:end,text:s.text,final:s.sentence_end?1:0});
      emit({type:'segment',segment:{id:sid,lesson_id:row.lesson_id,recording_id:rid,start_ms:start,end_ms:end,text:s.text,final:s.sentence_end?1:0}});
    },onUsage:value=>{reported=Math.max(reported,value);run('UPDATE asr_usage SET seconds=? WHERE id=?',Math.max(reported,bytes/32000),uid);},onError:(error,diagnostic)=>{console.warn(JSON.stringify({event:'asr-error',at:now(),recordingId:rid,diagnostic}));emit({type:'error',error});client.close();},onFinish:()=>{emit({type:'finished'});client.close();}});
    liveASR.set(rid,provider);const life=setTimeout(()=>{emit({type:'error',error:'本段转写已达时长上限，请暂停后继续。'});provider.finish();},3*3600000);life.unref();
    client.on('message',(data,isBinary)=>{if(isBinary){if(provider.send(data)){timeline.append(data.length,packetOffset);packetOffset=undefined;bytes+=data.length;if(Date.now()-lastDiagnostic>=30000){lastDiagnostic=Date.now();console.info(JSON.stringify({event:'asr-timeline',at:now(),recordingId:rid,audioMs:timeline.duration,recordingMs:timeline.at(timeline.duration,true),spans:timeline.spans.length}));}if(bytes%32000<6400)run('UPDATE asr_usage SET seconds=? WHERE id=?',Math.max(reported,bytes/32000),uid);}}else{try{const message=JSON.parse(data.toString());if(message.type==='offset'&&bytes===0&&Number.isFinite(message.offsetMs)&&message.offsetMs>=0&&message.offsetMs<=10860000){base=message.offsetMs;timeline.base=base;}if(message.type==='packet'&&Number.isFinite(message.offsetMs)&&message.offsetMs>=0&&message.offsetMs<=10860000)packetOffset=message.offsetMs;if(message.type==='finish'){provider.finish();drainTimer=setTimeout(()=>client.close(),localMode?120000:15000);}}catch{client.close();}}});
    client.on('close',()=>{clearTimeout(life);clearTimeout(drainTimer);provider.close();liveASR.delete(rid);run('UPDATE asr_usage SET seconds=? WHERE id=?',Math.max(reported,bytes/32000),uid);});
  });
});

app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在。'}));
if(process.argv.includes('--production')){app.use(express.static(path.join(root,'dist')));app.get('/{*path}',(req,res)=>res.sendFile(path.join(root,'dist','index.html')));}
else{const {createServer:createVite}=await import('vite');const vite=await createVite({root,server:{middlewareMode:true,hmr:{server}},appType:'spa'});app.use(vite.middlewares);}
app.use((error,req,res,next)=>{console.error(error.name,error.code||'request failed');if(!res.headersSent)res.status(500).json({error:'服务暂时无法完成请求，请重试。'});});
const port=Number(process.env.PORT||4317);server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`即问已启动：http://${process.env.HOST||'127.0.0.1'}:${port} · 转写${asrKey?'已配置':'未配置'} · 问答${answerRouter.ready?'已配置':'未配置'}`));
