import { createHash, randomBytes, randomInt, scryptSync } from 'node:crypto';
import { normalizeEmail, validEmail } from './accounts.js';

export function initPasswordResets(db){
  db.exec(`CREATE TABLE IF NOT EXISTS password_resets(email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,expires_ms INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,hour_count INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)`);
}
const codeHash=(email,code)=>createHash('sha256').update(`${normalizeEmail(email)}:${code}`).digest('hex');
const MINUTE=60000,HOUR=3600000;
export function issueResetCode(db,email){
  email=normalizeEmail(email);
  const row=db.prepare('SELECT * FROM password_resets WHERE email=?').get(email);
  if(row&&Date.now()-new Date(row.created_at).getTime()<HOUR){
    if(Date.now()-new Date(row.created_at).getTime()<MINUTE)return {status:429,error:'验证码刚发送过，请 1 分钟后再试。'};
    if(row.hour_count>=5)return {status:429,error:'发送次数已达上限，请 1 小时后再试。'};
  }
  const code=String(randomInt(0,1000000)).padStart(6,'0');
  const hourCount=row&&Date.now()-new Date(row.created_at).getTime()<HOUR?row.hour_count+1:1;
  db.prepare(`INSERT INTO password_resets(email,code_hash,expires_ms,attempts,hour_count,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_ms=excluded.expires_ms,attempts=0,hour_count=excluded.hour_count,created_at=excluded.created_at`)
    .run(email,codeHash(email,code),Date.now()+10*MINUTE,0,hourCount,new Date().toISOString());
  return {email,code};
}
export function applyPasswordReset(db,{email,code,password}){
  email=normalizeEmail(email);
  if(!validEmail(email)||!/^\d{6}$/.test(String(code||'')))return {status:400,error:'请填写邮箱和 6 位验证码。'};
  if(typeof password!=='string'||password.length<8||password.length>128)return {status:400,error:'新密码需要 8～128 位。'};
  const row=db.prepare('SELECT * FROM password_resets WHERE email=?').get(email);
  const invalid={status:403,error:'验证码无效或已过期，请重新获取。'};
  if(!row||row.expires_ms<=Date.now()||row.attempts>=5){db.prepare('DELETE FROM password_resets WHERE email=?').run(email);return invalid;}
  if(codeHash(email,code)!==row.code_hash){db.prepare('UPDATE password_resets SET attempts=attempts+1 WHERE email=?').run(email);return {status:403,error:'验证码不正确。'};}
  const user=db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
  db.prepare('DELETE FROM password_resets WHERE email=?').run(email);
  if(!user)return invalid;
  const salt=randomBytes(16).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('UPDATE users SET password=? WHERE id=?').run(`${salt}:${scryptSync(password,salt,64).toString('hex')}`,user.id);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {ok:true};
}
