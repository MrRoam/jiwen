import {createAnswerRouter,routingConfig} from './answer-router.js';
import {runtimeMode,assertPersonalDirectory,assertHostedDirectory,personalOwner,personalRequestAllowed} from './personal.js';
import {initAccounts,registerAccount,isAdmin,normalizeEmail,validEmail} from './accounts.js';
import {createServiceConfig} from './service-config.js';
import {initPasswordResets,issueResetCode,applyPasswordReset} from './password-reset.js';
import {issueRegistrationCode,cancelRegistrationCode} from './registration-codes.js';
import {mailConfigured,sendMail} from './mail.js';
import {requestBudget} from './limits.js';
import {audioBudget} from './audio-budget.js';
import {audioQuotaMode,trialAudioSeconds} from './audio-allowance.js';
import {legalDocument,initLegal,validConsent,storageLimits} from './legal.js';
import {exportAccount,deleteAccountRows} from './account-data.js';
import {createStorageBudget} from './storage-budget.js';
import {createLifecycle} from './lifecycle.js';
import {appendDeletion} from './backup.js';
import {createWorkQueue} from './work-queue.js';
import {createTranscriptionRecovery} from './transcription-recovery.js';
import {createASRStartQueue} from './asr-start-queue.js';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream, createWriteStream, rmSync, statSync, renameSync } from 'node:fs';
import {Readable} from 'node:stream';
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
import {registerPaymentInterestRoutes} from './payment-interest.js';
import {createPresence,createConsole} from './console.js';
import {createLocalConsole} from './local-console.js';
import {createCosts} from './costs.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mode=runtimeMode(),personal=mode==='personal';
const quotaMode=personal?'monthly':audioQuotaMode(process.env.ASR_QUOTA_MODE||'monthly');
const dataDir=path.resolve(process.env.DATA_DIR||path.join(root,'data',...(personal?['personal']:[])));
if(personal)assertPersonalDirectory(dataDir);else assertHostedDirectory(dataDir);
const runtimeFile=path.join(dataDir,'runtime.json');
mkdirSync(dataDir,{recursive:true});
if(existsSync(runtimeFile)){
  const previous=JSON.parse(readFileSync(runtimeFile,'utf8'));
  if(!Number.isSafeInteger(previous.pid)||previous.pid<=0)throw new Error('运行标记无效，请核实服务已经停止。');
  let alive=true;try{process.kill(previous.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
  if(alive)throw new Error('此数据目录已有服务运行，请先结束该实例，不能同时打开同一数据库。');
  rmSync(runtimeFile);
}
writeFileSync(runtimeFile,JSON.stringify({pid:process.pid}),{flag:'wx'});
process.once('exit',()=>{try{if(JSON.parse(readFileSync(runtimeFile,'utf8')).pid===process.pid)rmSync(runtimeFile);}catch{}});
const db=openDatabase(dataDir),app=express(),server=createServer(app);
const costs=createCosts(db);
// 暂停 Jev 功能；仅显式启用时才读取密钥和处理队列。
const jevEnabled=process.env.JEV_ENABLED==='true';
const jevOptions=jevEnabled?{}:{key:''};
const importance=createImportanceService(db,jevOptions);
const teacherQuestions=createTeacherQuestionService(db,jevOptions);
if(!jevEnabled){importance.close();teacherQuestions.close();}
initAccounts(db,{quotaMode});
const owner=personal?personalOwner(db):null;
initPasswordResets(db);
initLegal(db);
const storage=createStorageBudget(db,{dataDir,accountBytes:personal?null:storageLimits.userBytes,globalBytes:personal?null:storageLimits.globalBytes,minFreeBytes:personal?0:storageLimits.minFreeBytes,maxRecordingSeconds:storageLimits.maxRecordingSeconds});
const conversionQueue=createWorkQueue(Number(process.env.FFMPEG_CONCURRENCY||1));
const deletionLog=path.resolve(process.env.DATA_DELETION_LOG||`${dataDir}.deletions.jsonl`);
if(!existsSync(deletionLog)){mkdirSync(path.dirname(deletionLog),{recursive:true});writeFileSync(deletionLog,'',{flag:'wx'});}
const id=()=>randomUUID(),now=()=>new Date().toISOString();
const get=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
const serviceConfig=createServiceConfig(dataDir);
let serviceEnv,asrKey,asrUrl,asrModel,localMode,localRecoveryEnabled,asrReady,localUrl,runtimeRouter;
const audioLimit=Number(process.env.MONTHLY_AUDIO_SECONDS||36000),questionLimit=Number(process.env.DAILY_QUESTIONS||20);
const secure=!personal&&process.env.SECURE_COOKIE==='true';
const adminEmail=personal?'':normalizeEmail(process.env.ADMIN_EMAIL||'');
const apiConfigEnabled=personal||process.env.API_CONFIG_ENABLED!=='false';
if(adminEmail&&!validEmail(adminEmail))throw new Error('ADMIN_EMAIL 格式不正确。');
const globalDaily=Number(process.env.GLOBAL_DAILY_QUESTIONS||800),perMinute=Number(process.env.GLOBAL_REQUESTS_PER_MINUTE||18);
if(![questionLimit,globalDaily,perMinute].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('问答额度必须是正整数。');
const reserveRequest=requestBudget(db,{perUser:questionLimit,daily:globalDaily,perMinute,unlimited:personal});
const reserveAudio=audioBudget(db,{perUser:audioLimit,globalDaily:Number(process.env.GLOBAL_DAILY_ASR_SECONDS||360000),mode:quotaMode,unlimited:personal});
const asrStarts=createASRStartQueue({startsPerSecond:Number(process.env.ASR_STARTS_PER_SECOND||15)});
function applyServiceConfig(){
  serviceEnv=serviceConfig.env();
  asrKey=serviceEnv.DASHSCOPE_API_KEY||'';asrUrl=serviceEnv.ASR_WS_URL;asrModel=serviceEnv.ASR_MODEL;
  localMode=serviceEnv.ASR_PROVIDER==='local';asrReady=localMode||!!asrKey;
  localRecoveryEnabled=localMode||serviceEnv.LOCAL_ASR_RECOVERY==='true';
  localUrl=serviceEnv.LOCAL_ASR_URL.replace(/\/$/,'');
  if(localRecoveryEnabled&&!['127.0.0.1','localhost','[::1]'].includes(new URL(localUrl).hostname))throw new Error('本地转写地址必须指向本机。');
  runtimeRouter=createAnswerRouter({db,reserveRequest,costs,...routingConfig(serviceEnv)});
}
applyServiceConfig();
// HELP 路由持有这个稳定对象，保存设置后也使用新配置。
const answerRouter={get ready(){return runtimeRouter.ready;},status(){return runtimeRouter.status();},answer(options){return runtimeRouter.answer(options);}};
const active=new Map(),liveASR=new Map(),liveASRUsers=new Map(),chatBusy=new Set(),chatControllers=new Map(),finalizing=new Set();
const audioReaders=new Map();
const presence=createPresence();
let restarting=false;
let recovery;
function currentLegal(){return personal?null:legalDocument(serviceEnv,mailConfigured(),jevEnabled);}
// adult 列仅兼容既有数据库；新记录不再收集年龄声明。
function rememberConsent(userId,value){run('INSERT INTO legal_consents(user_id,version,accepted_at,adult) VALUES(?,?,?,0) ON CONFLICT(user_id,version) DO NOTHING',userId,value.version,now());}
function lessonBusy(lid){return all('SELECT id FROM recordings WHERE lesson_id=?',lid).some(r=>active.has(r.id)||liveASR.has(r.id)||finalizing.has(r.id)||playbackFiles.has(r.id)||audioReaders.has(r.id)||recovery?.busy(r.id))||all('SELECT id FROM conversations WHERE lesson_id=?',lid).some(c=>chatBusy.has(c.id));}
function deleteLesson(row){
  if(lessonBusy(row.id)){const error=new Error('请结束录音、保存、回放和回答后再删除。');error.status=409;throw error;}
  const recs=all('SELECT id FROM recordings WHERE lesson_id=?',row.id);
  appendDeletion(deletionLog,{type:'lesson',id:row.id,recordingIds:recs.map(r=>r.id)});
  importance.setEnabled(row.id,false);
  // 删除文件失败时保留可重试的课堂元信息；清单已记录用户的删除要求。
  for(const r of recs){recovery?.cancel(r.id);rmSync(path.join(dataDir,r.id),{recursive:true,force:true});}
  run('DELETE FROM lessons WHERE id=?',row.id);for(const r of recs)storage.release(r.id);
  return recs.map(r=>r.id);
}
const lifecycle=createLifecycle(db,{days:personal?null:storageLimits.retentionDays,isBusy:lessonBusy,deleteLesson});
const recoveryCharges=new Map();
recovery=createTranscriptionRecovery({db,dataDir,getUrl:()=>localUrl,
  // 云端实时转写不占用本机模型；本地实时模式才需要全站优先。
  canRun:()=>localRecoveryEnabled&&!restarting&&(!localMode||(active.size===0&&liveASR.size===0)),
  isRecordingBusy:rid=>active.has(rid)||liveASR.has(rid)||finalizing.has(rid),
  prepare:row=>{
    if(!localRecoveryEnabled)throw Object.assign(new Error('本机后台补转写尚未启用，录音及原文字已保留。'),{status:503});
    const error=recoveryBudgetError(row);if(error)throw Object.assign(new Error(error),{status:429});
  },
  chargeThrough:(row,endMs)=>{
    const charged=get('SELECT transcription_charged_ms FROM recordings WHERE id=?',row.id)?.transcription_charged_ms||0;
    const target=Math.ceil(endMs/1000)*1000,delta=Math.max(0,target-charged);
    if(!delta)return;
    let permit=recoveryCharges.get(row.id);
    if(!permit){const sessionId=id();permit=reserveAudio.open(row.user_id,sessionId,(seconds,{day})=>{run('UPDATE recordings SET transcription_charged_ms=transcription_charged_ms+? WHERE id=?',seconds*1000,row.id);costs.recordAudio(sessionId,{seconds,day,local:true});});recoveryCharges.set(row.id,permit);}
    const result=permit.send(Buffer.alloc(delta*32),()=>true);
    if(!result.accepted)throw Object.assign(new Error(result.error||'补转写额度不足，请稍后重试。'),{status:429,code:result.code});
  },
  reserveText:(row,bytes)=>storage.reserveText(row.user_id,bytes),
  onState:(rid,value)=>{
    if(value.state!=='running')recoveryCharges.delete(rid);
    let retryAt='';
    if(value.state==='blocked'){
      const row=get('SELECT lessons.user_id FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE recordings.id=?',rid);
      if(row){const usage=reserveAudio.usage(row.user_id);if(!(usage.period==='lifetime'&&usage.remainingSeconds<1)){const resets=[...(usage.remainingSeconds<1?[usage.resetsAt]:[]),...(usage.globalRemainingSeconds<1?[usage.globalResetsAt]:[])];retryAt=resets.filter(Boolean).sort().at(-1)||'';}}
    }
    run('UPDATE recordings SET transcription_status=?,transcription_error=?,transcription_processed_ms=?,transcription_retry_at=? WHERE id=?',value.state,value.error||'',Math.round(value.processedMs||0),retryAt,rid);
  },
  onComplete:row=>{run('UPDATE recordings SET transcription_needed=0,transcription_covered_ms=duration_ms WHERE id=?',row.id);}
});
function markTranscriptionGap(rid){run("UPDATE recordings SET transcription_needed=1,transcription_status=CASE WHEN transcription_status IN ('queued','running') THEN transcription_status ELSE 'needed' END WHERE id=?",rid);}
function recoveryBudgetError(row){
  if(personal)return null;
  if(Math.ceil(row.duration_ms/1000)*1000<=row.transcription_charged_ms)return null;
  const userId=row.user_id||get('SELECT user_id FROM lessons WHERE id=?',row.lesson_id)?.user_id;
  const usage=reserveAudio.usage(userId);
  return usage.remainingSeconds<1?reserveAudio.personalExhausted:usage.globalRemainingSeconds<1?'全站今日转写额度已用完，录音仍会继续保存。':null;
}
function queueTranscriptionIfNeeded(rid){
  const row=get('SELECT * FROM recordings WHERE id=?',rid);if(!row||row.status!=='ready'||liveASR.has(rid))return;
  if((row.transcription_covered_ms===0&&row.duration_ms>0)||row.transcription_covered_ms+1000<row.duration_ms)markTranscriptionGap(rid);
  if(localRecoveryEnabled&&get('SELECT transcription_needed FROM recordings WHERE id=?',rid)?.transcription_needed){
    const error=recoveryBudgetError(row);
    if(error){
      const userId=get('SELECT user_id FROM lessons WHERE id=?',row.lesson_id).user_id,usage=reserveAudio.usage(userId);
      const retryAt=usage.period==='lifetime'&&usage.remainingSeconds<1?'':[...(usage.remainingSeconds<1?[usage.resetsAt]:[]),...(usage.globalRemainingSeconds<1?[usage.globalResetsAt]:[])].filter(Boolean).sort().at(-1)||'';
      run("UPDATE recordings SET transcription_status='blocked',transcription_error=?,transcription_retry_at=? WHERE id=?",error,retryAt,rid);return;
    }
  }
  if(localRecoveryEnabled&&get('SELECT transcription_needed FROM recordings WHERE id=?',rid)?.transcription_needed){try{recovery.enqueue(rid,{force:true});}catch(error){run("UPDATE recordings SET transcription_status='needed',transcription_error=? WHERE id=?",error.message,rid);}}
}
if(localRecoveryEnabled)for(const row of all("SELECT id FROM recordings WHERE status='ready' AND (transcription_status IN ('queued','running') OR (transcription_needed=1 AND transcription_status IN ('needed','blocked'))) ORDER BY created_at"))queueTranscriptionIfNeeded(row.id);
function resumePendingTranscriptions(userId){
  if(!localRecoveryEnabled||restarting)return;
  for(const row of all("SELECT recordings.id FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE lessons.user_id=? AND recordings.status='ready' AND transcription_needed=1 AND (transcription_status IN ('needed','queued') OR (transcription_status='blocked' AND transcription_retry_at='')) ORDER BY recordings.created_at LIMIT 128",userId))queueTranscriptionIfNeeded(row.id);
}
function retryExpiredTranscriptionBudgets(){
  if(!localRecoveryEnabled||restarting)return;
  for(const row of all("SELECT recordings.id,lessons.user_id FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE recordings.status='ready' AND transcription_status='blocked' AND transcription_retry_at<>'' AND transcription_retry_at<=? ORDER BY recordings.created_at LIMIT 128",now())){
    const usage=reserveAudio.usage(row.user_id);
    if(!personal&&(usage.remainingSeconds<1||usage.globalRemainingSeconds<1))continue;
    try{recovery.enqueue(row.id);}catch{break;}
  }
}
if(process.env.HOST && !['localhost','127.0.0.1','::1'].includes(process.env.HOST) && !secure)throw new Error('对外服务必须配置 HTTPS 安全 Cookie。');
app.disable('x-powered-by');
if(personal)app.use((req,res,next)=>personalRequestAllowed(req)?next():res.status(403).json({error:'个人资料只允许从本机页面访问。'}));
app.use((req,res,next)=>{if(/^\/api\/admin(?:\/|$)|^\/(?:admin|console)(?:\/|$|\.html$)|^\/src\/(?:console-main|admin-console)\./.test(req.path))return res.sendStatus(404);next();});
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');if(req.path.startsWith('/api'))res.setHeader('Cache-Control','no-store');next();});
app.use('/api',(req,res,next)=>{
  if(restarting)return res.status(503).json({error:'服务正在重启，请稍后重试。'});
  const origin=req.headers.origin;
  if(origin && new URL(origin).host!==req.headers.host)return res.status(403).json({error:'请求来源不匹配。'});
  if(['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'不允许跨站请求。'});
  next();
});
app.use(express.json({limit:'100kb'}));
const cookieName=personal?'jiwen_personal':'tingjian';
function userFor(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);if(!token)return null;const user=get('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?',createHash('sha256').update(token).digest('hex'),Date.now());return user&&(personal?user.id===owner.id:user.email!==null)?user:null;}
function session(res,userId){const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',createHash('sha256').update(token).digest('hex'),userId,Date.now()+30*86400000);res.cookie(cookieName,token,{httpOnly:true,sameSite:'strict',secure,maxAge:30*86400000,path:'/'});}
function verifyPassword(password,stored){const [salt,key]=stored.split(':');return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(key,'hex'));}
const attempts=new Map();
app.post('/api/auth/:action',async(req,res)=>{
  if(personal)return res.sendStatus(404);
  const address=req.socket.remoteAddress;let entry=attempts.get(address);if(!entry||entry.until<Date.now())entry={count:0,until:Date.now()+600000};attempts.set(address,entry);
  if(++entry.count>40)return res.status(429).json({error:'尝试过于频繁，请稍后再试。'});
  if(req.params.action==='request-registration'){
    const email=normalizeEmail(req.body.email);
    if(!validEmail(email))return res.status(400).json({error:'请填写有效邮箱。'});
    if(!mailConfigured())return res.status(503).json({error:'邮件服务尚未配置，暂时无法注册。'});
    if(get('SELECT id FROM users WHERE email=? COLLATE NOCASE OR username=? COLLATE NOCASE',email,email))return res.status(409).json({error:'该邮箱已注册，请直接登录。'});
    const issued=issueRegistrationCode(db,email);
    if(issued.error)return res.status(issued.status).json({error:issued.error});
    try{
      const english=req.body.locale==='en';
      await sendMail({to:email,
        subject:english?`Jiwen · Registration code ${issued.code}`:`即问 · 注册验证码 ${issued.code}`,
        text:english?`Your Jiwen registration code is ${issued.code}. It expires in 10 minutes. If you did not request this, please ignore this email.`:`你正在注册即问，验证码是 ${issued.code}，10 分钟内有效。如果不是你本人操作，请忽略这封邮件。`});
    }catch{
      cancelRegistrationCode(db,issued);
      return res.status(502).json({error:'验证码邮件发送失败，请稍后再试。'});
    }
    return res.json({ok:true,message:'验证码已发送，请查收邮箱（10 分钟内有效）。'});
  }
  if(req.params.action==='register'){
    const result=registerAccount(db,req.body,{quotaMode});
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
function publicConfig(){return {mode,apiConfigEnabled,asrReady,jevEnabled,jevReady:importance.ready,llmReady:answerRouter.ready,asrProvider:localMode?'local':'remote',asrModel:localMode?serviceEnv.LOCAL_ASR_MODEL:asrModel,asrQuotaMode:personal?null:quotaMode,trialAudioSeconds:quotaMode==='trial'?trialAudioSeconds:null,registrationOpen:!personal,registrationRequiresVerification:!personal,dailyQuestions:personal?null:questionLimit,mailReady:!personal&&mailConfigured(),legal:currentLegal()};}
app.get('/api/legal',(req,res)=>personal?res.sendStatus(404):res.json(currentLegal()));
app.get('/api/me',(req,res)=>{let user=userFor(req);if(personal&&!user){session(res,owner.id);user=owner;}if(user)resumePendingTranscriptions(user.id);res.json({user:user?{id:user.id,email:user.email,personal,isAdmin:personal||isAdmin(db,user,adminEmail),legalVersion:personal?null:get('SELECT version FROM legal_consents WHERE user_id=? AND version=?',user.id,currentLegal().version)?.version||null}:null,config:publicConfig()});});
app.use('/api',(req,res,next)=>{req.user=userFor(req);if(!req.user)return res.status(401).json({error:'请先登录。'});next();});
if(!personal)registerPaymentInterestRoutes(app,db);
if(personal)app.use(['/api/logout','/api/account/consent','/api/account'],(req,res,next)=>req.path==='/export'?next():res.sendStatus(404));
app.post('/api/logout',(req,res)=>{const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tingjian='))?.slice(9);if(token)run('DELETE FROM sessions WHERE token=?',createHash('sha256').update(token).digest('hex'));res.clearCookie('tingjian',{path:'/'});res.json({ok:true});});
app.post('/api/account/consent',(req,res)=>{if(!validConsent(req.body?.legalConsent,currentLegal().version))return res.status(400).json({error:'请同意当前隐私政策和服务协议。'});rememberConsent(req.user.id,req.body.legalConsent);resumePendingTranscriptions(req.user.id);res.json({ok:true});});
app.get('/api/account/export',(req,res)=>{res.setHeader('Content-Disposition','attachment; filename="jiwen-account.json"');res.json(exportAccount(db,req.user,personal?'personal-v1':currentLegal().version));});
app.delete('/api/account',(req,res)=>{
  if(isAdmin(db,req.user,adminEmail))return res.status(409).json({error:'当前账号是实例管理员，请联系运营者完成管理员交接后再注销。'});
  if(req.body.confirmation!=='删除账号'||typeof req.body.password!=='string'||!verifyPassword(req.body.password,req.user.password))return res.status(400).json({error:'请填写正确密码，并输入“删除账号”。'});
  const lessons=all('SELECT * FROM lessons WHERE user_id=?',req.user.id);
  if(lessons.some(l=>lessonBusy(l.id))||[...serviceTests].some(token=>token.startsWith(`${req.user.id}:`)))return res.status(409).json({error:'请结束录音、保存、回放、回答和服务测试后再注销。'});
  const recs=all('SELECT recordings.id FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE lessons.user_id=?',req.user.id);
  appendDeletion(deletionLog,{type:'account',id:req.user.id,recordingIds:recs.map(r=>r.id)});
  for(const row of lessons)importance.setEnabled(row.id,false);
  for(const r of recs){recovery.cancel(r.id);rmSync(path.join(dataDir,r.id),{recursive:true,force:true});}
  deleteAccountRows(db,req.user);for(const r of recs)storage.release(r.id);
  res.clearCookie('tingjian',{path:'/'});res.json({ok:true});
});
const serviceTests=new Set();
app.use('/api',(req,res,next)=>{
  if(req.method!=='POST')return next();
  const fork=req.path.match(/^\/conversations\/([^/]+)\/fork$/);
  if(!fork&&!/^\/conversations\/[^/]+\/messages$/.test(req.path)&&!/^\/lessons\/[^/]+\/(conversations|help)$/.test(req.path))return next();
  let bytes=128*1024+Buffer.byteLength(JSON.stringify(req.body||{}));
  if(fork){const conversation=get('SELECT conversations.id,snapshot FROM conversations JOIN lessons ON lessons.id=conversations.lesson_id WHERE conversations.id=? AND lessons.user_id=?',fork[1],req.user.id);if(conversation)bytes+=Buffer.byteLength(conversation.snapshot)+all('SELECT content FROM messages WHERE conversation_id=?',conversation.id).reduce((n,m)=>n+Buffer.byteLength(m.content)+256,0);}
  try{const permit=storage.reserveText(req.user.id,bytes);res.once('finish',()=>permit.release());res.once('close',()=>permit.release());next();}
  catch(error){res.status(error.status||500).json({error:error.message,code:error.code});}
});
function requireAdmin(req,res,next){if(!apiConfigEnabled)return res.status(403).json({error:'此实例的 API 配置由维护者管理。'});if(!personal&&!isAdmin(db,req.user,adminEmail))return res.status(403).json({error:'只有实例管理员可以修改 API 配置。'});next();}
const adminConsole=createConsole({db,presence,
  state:()=>({active,liveASR,chatBusy,finalizing,playback:playbackFiles,readers:audioReaders,tests:serviceTests,background:jevEnabled?get("SELECT (SELECT COUNT(*) FROM importance_results WHERE status IN ('queued','processing'))+(SELECT COUNT(*) FROM teacher_question_results WHERE status IN ('queued','processing')) n").n:0}),
  audioUsage:()=>reserveAudio.globalUsage(),storageUsage:()=>storage.usage(''),questionLimit:globalDaily,
  costUsage:(day,seconds)=>costs.snapshot(day,seconds,{asr:{local:localMode,model:asrModel,baseUrl:asrUrl},llm:routingConfig(serviceEnv).fallback}),
  asrConcurrency:Number(process.env.MAX_ASR_CONCURRENCY||50),
  services:()=>({asr:{configured:asrReady,model:localMode?serviceEnv.LOCAL_ASR_MODEL:asrModel},llm:{configured:answerRouter.ready,model:answerRouter.status().enabled?'OpenRouter → '+answerRouter.status().fallbackModel:answerRouter.status().fallbackModel}})
});
function restartFromConsole(req,res){
  if(req.body?.confirmation!=='restart')return res.status(400).json({error:'请确认重启服务。'});
  const status=adminConsole.snapshot().restart;
  if(!status.supported)return res.status(503).json({error:'当前启动方式不支持页面重启，请使用 npm start 或 npm run dev 启动。'});
  if(status.blockers||recovery.busy())return res.status(409).json({error:'仍有录音、补转写、待恢复录音、保存、回放或处理任务，请结束后再重启。'});
  restarting=true;
  res.once('finish',()=>process.send({type:'restart'},error=>{if(error){restarting=false;return;}shutdown();}));
  res.json({ok:true,instanceId:adminConsole.snapshot().instanceId});
}
function configIdle(req,res,next){if(active.size||liveASR.size||finalizing.size||chatBusy.size||serviceTests.size||recovery.busy())return res.status(409).json({error:'有人正在录音、补转写、保存、回答或测试，请结束后再修改 API 配置。'});next();}
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
    res.json(await testService({service,key:asrKey,url:asrUrl,model:asrModel,signal:waiting.signal,createASR:options=>asrStarts.create(()=>paraformer(options),options.onError)}));
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
app.post('/api/lessons',(req,res)=>{
  if(req.body.importanceEnabled===true&&!importance.ready)return res.status(503).json({error:'重点标记尚未配置。'});
  try{storage.preflightText(req.user.id,1024+Buffer.byteLength(String(req.body.title||'未命名课堂').slice(0,80)));}catch(error){return res.status(error.status||500).json({error:error.message});}
  const lid=id();run('INSERT INTO lessons(id,user_id,title,created_at,demo) VALUES(?,?,?,?,0)',lid,req.user.id,String(req.body.title||'未命名课堂').slice(0,80),now());lifecycle.created(lid);
  if(req.body.importanceEnabled===true)importance.setEnabled(lid,true);res.json({id:lid});
});
app.get('/api/lessons/:lessonId',(req,res)=>{const row=lesson(req,res);if(!row)return;res.json({...row,recordings:all('SELECT * FROM recordings WHERE lesson_id=? ORDER BY offset_ms',row.id),segments:all('SELECT * FROM segments WHERE lesson_id=? ORDER BY start_ms',row.id),conversations:all('SELECT id,title,anchor_ms,created_at FROM conversations WHERE lesson_id=? ORDER BY created_at DESC',row.id)});});
app.patch('/api/lessons/:lessonId',(req,res)=>{const row=lesson(req,res);if(!row)return;const title=String(req.body.title||'').trim().slice(0,80);if(!title)return res.status(400).json({error:'请输入课堂名称。'});run('UPDATE lessons SET title=? WHERE id=?',title,row.id);res.json({ok:true});});
app.delete('/api/lessons/:lessonId',(req,res)=>{const row=lesson(req,res);if(!row)return;try{const recordingIds=deleteLesson(row);res.json({ok:true,recordingIds});}catch(error){res.status(error.status||500).json({error:error.message});}});

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
  try{await answerRouter.answer({userId:req.user.id,permit,messages:modelMessages(snapshot,[...history,{role:'user',content,status:'complete'}],req.body.locale),signal:controller.signal,onText:text=>{if(Buffer.byteLength(answer)+Buffer.byteLength(text)>64*1024){controller.abort();throw new Error('回答过长，已保存收到的内容。');}answer+=text;emit({type:'delta',text});}});if(task.stopped)throw new DOMException('Stopped','AbortError');if(!answer)throw new Error('问答服务没有返回内容，请重试。');run("UPDATE messages SET content=?,status='complete' WHERE id=?",answer,aid);emit({type:'done'});}
  catch(error){run("UPDATE messages SET content=?,status=? WHERE id=?",answer,task.stopped?'stopped':'failed',aid);if(task.stopped)emit({type:'done',stopped:true});else emit({type:'error',error:error.name==='AbortError'?'回答中断或超时，已保存收到的内容。':error.message});}
  finally{permit.release();clearTimeout(timeout);chatBusy.delete(row.id);chatControllers.delete(row.id);res.end();}
});

app.post('/api/lessons/:lessonId/recordings',(req,res)=>{
  const row=lesson(req,res);if(!row)return;
  if([...active.values()].some(r=>r.userId===req.user.id))return res.status(409).json({error:'账号已有录音进行中，请先停止。'});
  const mime=String(req.body.mime||'');if(!['audio/webm','audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4','audio/mp4;codecs=mp4a.40.2'].includes(mime))return res.status(400).json({error:'不支持此录音格式。'});
  const offset=get('SELECT COALESCE(MAX(offset_ms+duration_ms),0) AS t FROM recordings WHERE lesson_id=?',row.id).t,rid=id();
  let permit;try{permit=storage.begin(rid,req.user.id);}catch(error){return res.status(error.status||500).json({error:error.message});}
  try{mkdirSync(path.join(dataDir,rid),{recursive:true});run('INSERT INTO recordings(id,lesson_id,offset_ms,mime,created_at) VALUES(?,?,?,?,?)',rid,row.id,offset,mime,now());}catch(error){storage.release(rid);rmSync(path.join(dataDir,rid),{recursive:true,force:true});throw error;}
  const timer=setTimeout(()=>{liveASR.get(rid)?.close();active.delete(rid);run("UPDATE recordings SET status='interrupted' WHERE id=? AND status='recording'",rid);storage.release(rid);recovery.notify();},permit.maxSeconds*1000+60000);timer.unref();active.set(rid,{userId:req.user.id,timer,started:Date.now()});recovery.notify();res.json({id:rid,offsetMs:offset,maxSeconds:permit.maxSeconds,asrReady});
});
app.put('/api/recordings/:recordingId/chunks/:seq',express.raw({type:'application/octet-stream',limit:'8mb'}),(req,res)=>{
  const row=recording(req,res);if(!row)return;
  const seq=Number(req.params.seq);if(!Number.isInteger(seq)||seq<0||seq>12000||!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'录音分段无效。'});
  const hash=createHash('sha256').update(req.body).digest('hex'),existing=get('SELECT * FROM chunks WHERE recording_id=? AND seq=?',row.id,seq);
  if(existing){if(existing.hash!==hash)return res.status(409).json({error:'录音分段内容冲突。'});const file=path.join(dataDir,row.id,`${seq}.chunk`);if(!existsSync(file)){try{storage.preflight(row.id,req.user.id,req.body.length);writeFileSync(file+'.tmp',req.body);renameSync(file+'.tmp',file);}catch(error){return res.status(error.status||500).json({error:error.message});}}if(req.headers['x-needs-transcription']==='true')markTranscriptionGap(row.id);return res.json({ok:true});}
  if(recovery.busy(row.id))return res.status(409).json({error:'录音正在补转写，请结束后再补传。'});
  if(audioReaders.has(row.id)||playbackFiles.has(row.id))return res.status(409).json({error:'录音正在回放或下载，请结束后再补传。'});
  if(finalizing.has(row.id)||row.status==='processing')return res.status(409).json({error:'录音正在处理，请稍候。'});
  if(!['recording','interrupted','ready'].includes(row.status))return res.status(409).json({error:'录音已经结束。'});
  const chunkCount=get('SELECT COUNT(*) AS n FROM chunks WHERE recording_id=?',row.id).n;if(seq!==chunkCount)return res.status(409).json({error:'请按顺序补传录音。'});
  const duration=Number(req.headers['x-duration-ms']);if(!Number.isFinite(duration)||duration<0||duration>10860000)return res.status(400).json({error:'录音时长无效。'});
  let permit;try{permit=storage.onChunk(row.id,req.user.id,req.body.length,duration);}catch(error){return res.status(error.status||500).json({error:error.message,code:error.code});}
  const destination=path.join(dataDir,row.id,`${seq}.chunk`);
  try{writeFileSync(destination+'.tmp',req.body);renameSync(destination+'.tmp',destination);db.exec('BEGIN IMMEDIATE');try{run('INSERT INTO chunks VALUES(?,?,?,?)',row.id,seq,req.body.length,hash);run("UPDATE recordings SET duration_ms=MAX(duration_ms,?),status=CASE WHEN status='ready' THEN 'interrupted' ELSE status END WHERE id=?",duration,row.id);if(req.headers['x-needs-transcription']==='true'||row.status==='ready')markTranscriptionGap(row.id);lifecycle.touch(row.lesson_id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}res.json({ok:true,stopSoon:permit.stopSoon});}
  catch{try{rmSync(destination+'.tmp',{force:true});}catch{}res.status(507).json({error:'服务器保存空间或文件写入异常，请停止录音并保留待同步分段后重试。',code:'storage_limit'});}
});
app.get('/api/recordings/:recordingId',(req,res)=>{const row=recording(req,res);if(row)res.json({...row,chunks:get('SELECT COUNT(*) AS n FROM chunks WHERE recording_id=?',row.id).n,active:active.has(row.id)});});
app.post('/api/recordings/:recordingId/transcription-gap',(req,res)=>{const row=recording(req,res);if(!row)return;markTranscriptionGap(row.id);queueTranscriptionIfNeeded(row.id);res.json({ok:true});});
app.post('/api/recordings/:recordingId/transcribe',(req,res)=>{
  const row=recording(req,res);if(!row)return;
  if(!localRecoveryEnabled)return res.status(503).json({error:'本机后台补转写尚未启用，录音及原文字已保留。'});
  if(row.status!=='ready'||active.has(row.id)||liveASR.has(row.id)||finalizing.has(row.id))return res.status(409).json({error:'请先完成录音保存，再补转写。'});
  try{markTranscriptionGap(row.id);res.status(202).json({ok:true,...recovery.enqueue(row.id,{force:true})});}
  catch(error){res.status(error.status||503).json({error:error.message});}
});
async function finalize(row,expected){
  expected=Math.max(expected||0,row.expected_chunks||0)||undefined;
  if(finalizing.has(row.id))throw new Error('录音正在处理，请稍候。');
  if(recovery.busy(row.id))throw new Error('录音正在补转写，请结束后再恢复保存。');
  if(audioReaders.has(row.id)||playbackFiles.has(row.id))throw new Error('录音正在回放或下载，请结束后再恢复保存。');
  if(active.has(row.id)&&expected===undefined)throw new Error('这段录音仍在其他页面进行，请先停止录音再恢复保存。');
  const chunks=all('SELECT * FROM chunks WHERE recording_id=? ORDER BY seq',row.id);
  if(!chunks.length)throw new Error('尚未收到音频，请先恢复上传。');
  if(expected!==undefined&&chunks.length!==expected)throw new Error('还有录音分段没有上传，请恢复上传后再试。');
  if(chunks.some((chunk,index)=>chunk.seq!==index||!existsSync(path.join(dataDir,row.id,`${chunk.seq}.chunk`))))throw new Error('旧录音的原始分段已缺失，补传内容和已有回放已保留，暂时无法合并完整录音。');
  finalizing.add(row.id);const a=active.get(row.id);if(a)clearTimeout(a.timer);active.delete(row.id);liveASR.get(row.id)?.finish();run("UPDATE recordings SET status='processing' WHERE id=?",row.id);
  const folder=path.join(dataDir,row.id),input=path.join(folder,'source.bin'),output=path.join(folder,'audio.tmp.m4a');
  try{await conversionQueue(async()=>{const owner=get('SELECT user_id FROM lessons WHERE id=?',row.lesson_id).user_id;storage.preflight(row.id,owner,chunks.reduce((n,c)=>n+c.size,0)+Math.ceil(row.duration_ms/1000)*10000+2*1024**2,{replace:true});async function* sourceChunks(){for(const chunk of chunks)for await(const buffer of createReadStream(path.join(folder,`${chunk.seq}.chunk`)))yield buffer;}await pipeline(Readable.from(sourceChunks()),createWriteStream(input));
    await runFFmpeg(['-y','-i',input,'-vn','-ac','1','-c:a','aac','-b:a','64k','-movflags','+faststart',output],'录音处理失败，原始分段已保留，可重试。');
    renameSync(output,path.join(folder,'audio.m4a'));rmSync(path.join(folder,'audio.mp3'),{force:true});run("UPDATE recordings SET status='ready' WHERE id=?",row.id);rmSync(input,{force:true});});
    // 保留原始分段，允许恢复迟到的分段，也避免转换失败破坏已有回放。
  }catch(error){run("UPDATE recordings SET status='interrupted' WHERE id=?",row.id);throw error;}finally{try{rmSync(input,{force:true});rmSync(output,{force:true});}catch{console.warn('音频临时文件清理失败，已保留原始分段。');}finally{storage.finish(row.id);finalizing.delete(row.id);queueTranscriptionIfNeeded(row.id);recovery.notify();}}
}
app.post('/api/recordings/:recordingId/finish',async(req,res)=>{const row=recording(req,res);if(!row)return;const expected=req.body?.chunks;if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<1||expected>12001))return res.status(400).json({error:'录音分段数量无效。'});if(req.body?.needsTranscription===true)markTranscriptionGap(row.id);const required=Math.max(expected||0,row.expected_chunks||0);if(row.status==='ready'){if(required>0&&get('SELECT COUNT(*) AS n FROM chunks WHERE recording_id=?',row.id).n!==required)return res.status(409).json({error:'还有录音分段没有上传，请恢复上传后再试。'});queueTranscriptionIfNeeded(row.id);return res.json({ok:true});}try{await finalize(row,expected);res.json({ok:true});}catch(error){res.status(409).json({error:error.message});}});
app.post('/api/recordings/:recordingId/interrupt',(req,res)=>{const row=recording(req,res);if(!row)return;const expected=req.body?.chunks;if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0||expected>12001))return res.status(400).json({error:'录音分段数量无效。'});if(expected!==undefined)run('UPDATE recordings SET expected_chunks=MAX(expected_chunks,?) WHERE id=?',expected,row.id);const asr=liveASR.get(row.id),incomplete=asr?!asr.finishing:(row.transcription_covered_ms===0&&row.duration_ms>0)||row.transcription_covered_ms+1000<row.duration_ms;if(req.body?.needsTranscription===true||(incomplete&&row.status!=='ready'))markTranscriptionGap(row.id);const a=active.get(row.id);if(a)clearTimeout(a.timer);active.delete(row.id);if(!asr?.finishing)asr?.close();run("UPDATE recordings SET status='interrupted' WHERE id=? AND status='recording'",row.id);storage.interrupt(row.id,req.user.id,row.duration_ms);recovery.notify();res.json({ok:true});});
app.post('/api/recordings/:recordingId/cancel',(req,res)=>{const row=recording(req,res);if(!row)return;if(get('SELECT COUNT(*) AS n FROM chunks WHERE recording_id=?',row.id).n)return res.status(409).json({error:'录音已有内容，请恢复保存。'});const a=active.get(row.id);if(a)clearTimeout(a.timer);active.delete(row.id);liveASR.get(row.id)?.close();storage.release(row.id);run('DELETE FROM recordings WHERE id=?',row.id);rmSync(path.join(dataDir,row.id),{recursive:true,force:true});res.json({ok:true});});
function runFFmpeg(args,message){return new Promise((resolve,reject)=>{const child=spawn(ffmpeg,args,{windowsHide:true,stdio:'ignore'});let timeout=false,settled=false;const timer=setTimeout(()=>{timeout=true;child.kill();},180000);const settle=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};child.once('error',()=>settle(new Error('音频处理程序无法启动。')));child.once('close',code=>settle(code===0&&!timeout?null:new Error(timeout?'音频处理超时，原始分段已保留。':message)));});}
const playbackFiles=new Map();
async function playbackFile(rid){
  const file=path.join(dataDir,rid,'audio.mp3');
  if(existsSync(file))return file;
  if(!playbackFiles.has(rid)){
    const job=conversionQueue(()=>{const row=get('SELECT recordings.duration_ms,lessons.user_id FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE recordings.id=?',rid);storage.preflight(rid,row.user_id,Math.ceil(row.duration_ms/1000)*14000+2*1024**2,{replace:true});const temp=path.join(dataDir,rid,'playback.tmp.mp3');return runFFmpeg(['-y','-i',path.join(dataDir,rid,'audio.m4a'),'-vn','-c:a','libmp3lame','-b:a','96k',temp],'兼容回放转换失败，请重试。').then(()=>{renameSync(temp,file);return file;}).finally(()=>{try{rmSync(temp,{force:true});}catch{}});}).finally(()=>{if(!active.has(rid)&&!finalizing.has(rid))storage.release(rid);playbackFiles.delete(rid);});
    playbackFiles.set(rid,job);
  }
  return playbackFiles.get(rid);
}
app.get('/api/recordings/:recordingId/audio',async(req,res)=>{const row=recording(req,res);if(!row)return;if(row.status!=='ready')return res.status(409).json({error:'录音还未完成保存。'});try{const file=req.query.format==='mp3'?await playbackFile(row.id):path.join(dataDir,row.id,'audio.m4a');audioReaders.set(row.id,(audioReaders.get(row.id)||0)+1);let closed=false;const done=()=>{if(closed)return;closed=true;const n=(audioReaders.get(row.id)||1)-1;if(n)audioReaders.set(row.id,n);else audioReaders.delete(row.id);};res.once('close',done);res.once('finish',done);if(req.query.download==='1')res.download(file,`jiwen-${row.id}.${req.query.format==='mp3'?'mp3':'m4a'}`);else res.sendFile(file);}catch(error){res.status(503).json({error:error.message});}});
app.get('/api/usage',(req,res)=>{
  const asr=reserveAudio.usage(req.user.id);
  // 额度明细包含本机及后台补写时长，不能由它推算云供应商费用。
  const rate=localMode?0:null;
  res.json({asrSeconds:asr.usedSeconds,estimatedAsrCost:rate===null?null:asr.usedSeconds*rate,asr,llm:reserveRequest.usage(req.user.id),storage:{...storage.usage(req.user.id),retentionDays:personal?null:storageLimits.retentionDays}});
});

const asrConcurrency=Number(process.env.MAX_ASR_CONCURRENCY||50);if(!Number.isSafeInteger(asrConcurrency)||asrConcurrency<1)throw new Error('转写并发上限必须是正整数。');
const wss=new WebSocketServer({noServer:true,maxPayload:128*1024});
const presenceWss=new WebSocketServer({noServer:true,maxPayload:1024});
server.on('upgrade',(req,socket,head)=>{
  if(personal&&!personalRequestAllowed(req)){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
  if(restarting){socket.destroy();return;}
  if(new URL(req.url,'http://localhost').pathname==='/api/presence'){
    const user=userFor(req),origin=req.headers.origin;
    if(!user||!origin||new URL(origin).host!==req.headers.host){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}
    presenceWss.handleUpgrade(req,socket,head,client=>presence.connect(client,user.id,()=>!!userFor(req)));
    return;
  }
  const url=new URL(req.url,'http://localhost');if(url.pathname!=='/api/asr'){if(!process.argv.includes('--production'))return;socket.destroy();return;}
  const user=userFor(req),origin=req.headers.origin;if(!user||!origin||new URL(origin).host!==req.headers.host){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}
  const rid=url.searchParams.get('recordingId'),row=get('SELECT recordings.* FROM recordings JOIN lessons ON lessons.id=recordings.lesson_id WHERE recordings.id=? AND lessons.user_id=?',rid,user.id);
  if(!row||!asrReady||liveASR.size>=asrConcurrency||liveASR.has(rid)||[...liveASRUsers.values()].includes(user.id)){socket.write('HTTP/1.1 409 Conflict\r\n\r\n');socket.destroy();return;}
  if(!active.has(rid)){
    let remaining=(storageLimits.maxRecordingSeconds*1000-row.duration_ms)/1000;
    if(row.status!=='interrupted'||[...active.values()].some(r=>r.userId===user.id)||remaining<=0){socket.write('HTTP/1.1 409 Conflict\r\n\r\n');socket.destroy();return;}
    try{remaining=Math.min(remaining,storage.begin(rid,user.id,remaining).maxSeconds);}catch{socket.write('HTTP/1.1 409 Conflict\r\n\r\n');socket.destroy();return;}
    const timer=setTimeout(()=>{liveASR.get(rid)?.close();active.delete(rid);run("UPDATE recordings SET status='interrupted' WHERE id=? AND status='recording'",rid);storage.interrupt(rid,user.id,row.duration_ms);},remaining*1000+60000);timer.unref();
    active.set(rid,{userId:user.id,timer,started:Date.now()});recovery.notify();run("UPDATE recordings SET status='recording' WHERE id=?",rid);
    console.info(JSON.stringify({event:'asr-resumed',at:now(),recordingId:rid}));
  }
  wss.handleUpgrade(req,socket,head,client=>{
    const usage=reserveAudio.usage(user.id);if(!personal&&(usage.remainingSeconds<=0||usage.globalRemainingSeconds<=0)){client.send(JSON.stringify({type:'error',code:'quota_exhausted',error:usage.remainingSeconds<=0?reserveAudio.personalExhausted:'全站今日转写额度已用完，录音仍会继续保存。'}));client.close();return;}
    let base=Number(url.searchParams.get('offsetMs')||0);if(!Number.isFinite(base)||base<0||base>10860000){client.close();return;}
    const timeline=new AudioTimeline(base);let packetOffset,lastDiagnostic=0,lastSegmentDiagnostic=0,pendingSentenceId=null,sentenceCount=0;
    const uid=id(),audioPricing={local:localMode,model:asrModel,baseUrl:asrUrl},audioPermit=reserveAudio.open(user.id,uid,(seconds,{day})=>{run('UPDATE recordings SET transcription_charged_ms=transcription_charged_ms+? WHERE id=?',seconds*1000,rid);costs.recordAudio(uid,{seconds,day,...audioPricing});});let bytes=0,drainTimer,quotaExhausted=false,providerFinished=false,finishing=false;
    const emit=value=>{if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(value));};
    const providerOptions={key:asrKey,url:localMode?localUrl:asrUrl,model:asrModel,onReady:()=>emit({type:'ready'}),onSentence:s=>{
      try{storage.preflightText(user.id,Buffer.byteLength(s.text)+512);}catch{emit({type:'error',code:'storage_limit',error:'转写文本保存空间不足，录音仍继续保存，请导出或删除旧课堂。'});client.close();return;}
      const start=row.offset_ms+timeline.at(s.begin_time),end=Math.max(start,row.offset_ms+timeline.at(s.end_time,true)),sid=pendingSentenceId||`${uid}-${sentenceCount++}`;
      pendingSentenceId=s.sentence_end?null:sid;
      if(Date.now()-lastSegmentDiagnostic>=30000){lastSegmentDiagnostic=Date.now();console.info(JSON.stringify({event:'asr-segment',at:now(),recordingId:rid,startMs:start,endMs:end,audioMs:timeline.duration,recordingMs:timeline.at(timeline.duration,true),final:!!s.sentence_end}));}
      run('INSERT INTO segments VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_ms=excluded.start_ms,end_ms=excluded.end_ms,text=excluded.text,final=excluded.final',sid,row.lesson_id,rid,start,end,s.text,s.sentence_end?1:0);
      importance.enqueue({id:sid,lesson_id:row.lesson_id,start_ms:start,end_ms:end,text:s.text,final:s.sentence_end?1:0});
      teacherQuestions.enqueue({id:sid,lesson_id:row.lesson_id,start_ms:start,end_ms:end,text:s.text,final:s.sentence_end?1:0});
      emit({type:'segment',segment:{id:sid,lesson_id:row.lesson_id,recording_id:rid,start_ms:start,end_ms:end,text:s.text,final:s.sentence_end?1:0}});
    },onUsage:value=>{audioPermit.onUsage(value);if(Number.isFinite(value)&&value>=0)run('UPDATE recordings SET transcription_covered_ms=MAX(transcription_covered_ms,?) WHERE id=?',timeline.at(value*1000,true),rid);},onError:(error,diagnostic)=>{markTranscriptionGap(rid);console.warn(JSON.stringify({event:'asr-error',at:now(),recordingId:rid,diagnostic}));if(!quotaExhausted)emit({type:'error',error});client.close();},onFinish:()=>{providerFinished=true;emit({type:'finished'});client.close();}};
    const provider=localMode?localASR(providerOptions):asrStarts.create(()=>paraformer(providerOptions),providerOptions.onError);
    const finishProvider=()=>{finishing=true;provider.finish();};
    liveASR.set(rid,{...provider,finish:finishProvider,get finishing(){return finishing;},close(){markTranscriptionGap(rid);provider.close();client.close();}});liveASRUsers.set(rid,user.id);recovery.notify();const life=setTimeout(()=>{emit({type:'error',error:'本段转写已达时长上限，请暂停后继续。'});finishProvider();},3*3600000);life.unref();
    client.on('message',(data,isBinary)=>{
      if(isBinary){
        if(quotaExhausted)return;
        const result=audioPermit.send(data,buffer=>provider.send(buffer));
        if(result.error){quotaExhausted=true;markTranscriptionGap(rid);emit({type:'error',code:'quota_exhausted',error:result.error});finishProvider();drainTimer=setTimeout(()=>client.close(),localMode?120000:15000);return;}
        if(result.accepted){const expectedOffset=timeline.duration?timeline.at(timeline.duration,true):0;if(Number.isFinite(packetOffset)&&packetOffset>expectedOffset+1000)markTranscriptionGap(rid);timeline.append(data.length,packetOffset);packetOffset=undefined;bytes+=data.length;if(Date.now()-lastDiagnostic>=30000){lastDiagnostic=Date.now();console.info(JSON.stringify({event:'asr-timeline',at:now(),recordingId:rid,audioMs:timeline.duration,recordingMs:timeline.at(timeline.duration,true),spans:timeline.spans.length}));}}
      }else{
        try{const message=JSON.parse(data.toString());if(message.type==='offset'&&bytes===0&&Number.isFinite(message.offsetMs)&&message.offsetMs>=0&&message.offsetMs<=10860000){base=message.offsetMs;timeline.base=base;}if(message.type==='packet'&&Number.isFinite(message.offsetMs)&&message.offsetMs>=0&&message.offsetMs<=10860000)packetOffset=message.offsetMs;if(message.type==='finish'&&!quotaExhausted){finishProvider();drainTimer=setTimeout(()=>client.close(),localMode?120000:15000);}}catch{client.close();}
      }
    });
    client.on('close',()=>{clearTimeout(life);clearTimeout(drainTimer);if(!providerFinished)markTranscriptionGap(rid);provider.close();liveASR.delete(rid);liveASRUsers.delete(rid);queueTranscriptionIfNeeded(rid);recovery.notify();});
  });
});

app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在。'}));
if(process.argv.includes('--production')){app.use(express.static(path.join(root,'dist')));app.get('/{*path}',(req,res)=>res.sendFile(path.join(root,'dist','index.html')));}
else{const {createServer:createVite}=await import('vite');const vite=await createVite({root,server:{middlewareMode:true,hmr:{server}},appType:'spa'});app.use(vite.middlewares);}
app.use((error,req,res,next)=>{console.error(error.name,error.code||'request failed');if(!res.headersSent)res.status(500).json({error:'服务暂时无法完成请求，请重试。'});});
const cleanupTimer=setInterval(()=>lifecycle.run().catch(error=>console.error('课堂清理失败:',error.name)),3600000);cleanupTimer.unref();
const transcriptionRetryTimer=setInterval(retryExpiredTranscriptionBudgets,60000);transcriptionRetryTimer.unref();
retryExpiredTranscriptionBudgets();
const presenceTimer=setInterval(()=>presence.sweep(),30000);presenceTimer.unref();
const consoleTimer=setInterval(()=>adminConsole.sample(),15000);consoleTimer.unref();
let localConsole;
const consolePort=personal?0:Number(process.env.CONSOLE_PORT??(process.env.JIWEN_SUPERVISED==='true'?4319:0));
if(!Number.isSafeInteger(consolePort)||consolePort<0||consolePort>65535)throw new Error('CONSOLE_PORT 必须为 0～65535 的整数。');
if(consolePort){
  localConsole=await createLocalConsole({root,port:consolePort,
    overview:()=>{const value=adminConsole.snapshot();if(recovery.busy())value.restart.blockers++;return value;},
    restart:restartFromConsole,isRestarting:()=>restarting,production:process.argv.includes('--production')});
  console.log(`本机控制台：http://127.0.0.1:${consolePort}`);
}
let closing=false;
function shutdown(){
  if(closing)return;closing=true;restarting=true;
  clearInterval(cleanupTimer);clearInterval(presenceTimer);clearInterval(consoleTimer);clearInterval(transcriptionRetryTimer);
  importance.close();teacherQuestions.close();presence.close();
  asrStarts.close();
  for(const client of wss.clients)client.terminate();
  for(const task of chatControllers.values())task.controller.abort();
  const timeout=setTimeout(()=>process.exit(0),5000);timeout.unref();
  const recovered=recovery.close();
  const consoleClosed=localConsole?.close();
  server.close(async()=>{try{await Promise.all([recovered,consoleClosed]);db.close();}finally{process.exit(0);}});
}
process.on('message',message=>{if(message?.type==='shutdown')shutdown();});
if(process.env.JIWEN_SUPERVISED==='true')process.on('disconnect',shutdown);
const port=Number(process.env.PORT||4317);server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`即问已启动：http://${process.env.HOST||'127.0.0.1'}:${port} · 转写${asrKey?'已配置':'未配置'} · 问答${answerRouter.ready?'已配置':'未配置'}`));
