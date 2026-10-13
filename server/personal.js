import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import path from 'node:path';

const loopbackHosts=new Set(['localhost','127.0.0.1','::1','[::1]']);
export function runtimeMode(env=process.env){
  const mode=env.JIWEN_MODE||'personal';
  if(!['personal','hosted'].includes(mode))throw new Error('JIWEN_MODE 必须为 personal 或 hosted。');
  if(mode==='personal'&&!loopbackHosts.has(env.HOST||'127.0.0.1'))throw new Error('个人使用只允许在本机启动。');
  return mode;
}

export function assertPersonalDirectory(directory){
  const file=path.join(directory,'classroom.sqlite');
  if(!existsSync(file))return;
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get())return;
    const setting=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get();
    const owner=setting&&db.prepare("SELECT value FROM app_settings WHERE key='personal_user_id'").get()?.value;
    if(db.prepare('SELECT COUNT(*) n FROM users').get().n&&(!owner||db.prepare('SELECT COUNT(*) n FROM users WHERE id<>?').get(owner).n))throw new Error('此目录包含旧账号资料。请使用独立的个人数据目录，原资料保持不变。');
  }finally{db.close();}
}

export function personalOwner(db){
  let owner=db.prepare("SELECT value FROM app_settings WHERE key='personal_user_id'").get()?.value;
  if(!owner){
    owner=randomUUID();db.exec('BEGIN IMMEDIATE');
    try{
      db.prepare('INSERT INTO users(id,username,password,created_at,email) VALUES(?,?,?,?,NULL)').run(owner,`personal:${owner}`,'',new Date().toISOString());
      db.prepare("INSERT INTO app_settings(key,value) VALUES('personal_user_id',?)").run(owner);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return db.prepare('SELECT * FROM users WHERE id=?').get(owner);
}

export function assertHostedDirectory(directory){
  const file=path.join(directory,'classroom.sqlite');
  if(!existsSync(file))return;
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()&&db.prepare("SELECT 1 FROM app_settings WHERE key='personal_user_id'").get())throw new Error('此目录包含个人资料，不能作为体验站数据目录。');
  }finally{db.close();}
}

export function personalRequestAllowed(req){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  if(Object.keys(req.headers).some(name=>name==='forwarded'||name.startsWith('x-forwarded-')||name==='cf-connecting-ip'))return false;
  try{
    const host=new URL(`http://${req.headers.host}`);
    if(!loopbackHosts.has(host.hostname)||host.username||host.password||host.pathname!=='/'||host.search||host.hash)return false;
    if(Number(host.port||80)!==req.socket.localPort)return false;
    if(req.headers.origin&&req.headers.origin!==host.origin)return false;
    return true;
  }catch{return false;}
}
