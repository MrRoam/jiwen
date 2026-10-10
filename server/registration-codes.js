import {createHash, randomBytes, randomInt, timingSafeEqual} from 'node:crypto';

const MINUTE=60000,HOUR=60*MINUTE;
const digest=(email,code,salt)=>createHash('sha256').update(`${salt}:${email}:${code}`).digest();

export function initRegistrationCodes(db){
  db.exec(`CREATE TABLE IF NOT EXISTS registration_codes(
    email TEXT PRIMARY KEY,code_hash TEXT NOT NULL,salt TEXT NOT NULL,
    expires_ms INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_ms INTEGER NOT NULL,hour_start_ms INTEGER NOT NULL,hour_count INTEGER NOT NULL)`);
}

export function issueRegistrationCode(db,email){
  email=email.trim().toLowerCase();
  const now=Date.now();
  db.prepare('DELETE FROM registration_codes WHERE hour_start_ms<? AND expires_ms<?').run(now-24*HOUR,now);
  const row=db.prepare('SELECT * FROM registration_codes WHERE email=?').get(email);
  if(row&&now-row.last_sent_ms<MINUTE)return {status:429,error:'验证码刚发送过，请 1 分钟后再试。'};
  const sameHour=row&&now-row.hour_start_ms<HOUR;
  if(sameHour&&row.hour_count>=5)return {status:429,error:'发送次数已达上限，请 1 小时后再试。'};
  const code=String(randomInt(0,1000000)).padStart(6,'0'),salt=randomBytes(16).toString('hex');
  const hash=digest(email,code,salt).toString('hex');
  db.prepare(`INSERT INTO registration_codes VALUES(?,?,?,?,0,?,?,?)
    ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,
    expires_ms=excluded.expires_ms,attempts=0,last_sent_ms=excluded.last_sent_ms,
    hour_start_ms=excluded.hour_start_ms,hour_count=excluded.hour_count`)
    .run(email,hash,salt,now+10*MINUTE,now,sameHour?row.hour_start_ms:now,sameHour?row.hour_count+1:1);
  return {email,code,hash};
}

export function cancelRegistrationCode(db,{email,hash}){
  // 邮件未发送成功时允许立即重试；保留小时计数，防止反复失败绕过限频。
  db.prepare("UPDATE registration_codes SET code_hash='',expires_ms=0,last_sent_ms=0 WHERE email=? AND code_hash=?").run(email,hash);
}

export function checkRegistrationCode(db,email,code){
  if(typeof code!=='string'||!/^\d{6}$/.test(code))return {status:400,error:'请填写邮箱验证码（6 位数字）。'};
  const row=db.prepare('SELECT * FROM registration_codes WHERE email=?').get(email);
  if(!row||!row.code_hash||row.expires_ms<=Date.now()||row.attempts>=5)return {status:403,error:'验证码无效或已过期，请重新获取。'};
  if(!timingSafeEqual(digest(email,code,row.salt),Buffer.from(row.code_hash,'hex'))){
    db.prepare('UPDATE registration_codes SET attempts=attempts+1 WHERE email=?').run(email);
    return {status:403,error:'验证码不正确。'};
  }
  return null;
}

export function consumeRegistrationCode(db,email){
  // 保留发送计数；账号删除或验证码使用后也不能立即重新领取验证码。
  db.prepare("UPDATE registration_codes SET code_hash='',expires_ms=0 WHERE email=?").run(email);
}
