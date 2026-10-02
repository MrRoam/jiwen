import {randomBytes,randomUUID,scryptSync} from 'node:crypto';

export const normalizeEmail=value=>typeof value==='string'?value.trim().toLowerCase():'';
export const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export function initAccounts(db){
  if(!db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='email'))db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  // 兼容已有邮箱账号；旧邀请表及用户数据保留，但不再参与注册。
  const first=db.prepare('SELECT id FROM users WHERE email IS NOT NULL ORDER BY created_at,id LIMIT 1').get();
  if(first)db.prepare("INSERT OR IGNORE INTO app_settings VALUES('admin_user_id',?)").run(first.id);
}

export function isAdmin(db,user,adminEmail=''){
  if(!user)return false;
  if(adminEmail)return normalizeEmail(user.email)===normalizeEmail(adminEmail);
  return db.prepare("SELECT value FROM app_settings WHERE key='admin_user_id'").get()?.value===user.id;
}

export function registerAccount(db,{email,password},maxUsers=100){
  email=normalizeEmail(email);
  if(!validEmail(email)||typeof password!=='string'||password.length<8||password.length>128)return {status:400,error:'请填写有效邮箱和 8～128 位密码。'};
  const salt=randomBytes(16).toString('hex'),hash=`${salt}:${scryptSync(password,salt,64).toString('hex')}`;
  db.exec('BEGIN IMMEDIATE');
  try{
    if(db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE OR username=? COLLATE NOCASE').get(email,email)){
      db.exec('ROLLBACK');return {status:409,error:'该邮箱已注册，请直接登录。'};
    }
    if(db.prepare('SELECT COUNT(*) n FROM users WHERE email IS NOT NULL').get().n>=maxUsers){
      db.exec('ROLLBACK');return {status:403,error:'注册名额已满，已有账号仍可登录。'};
    }
    const id=randomUUID();
    db.prepare('INSERT INTO users(id,username,password,created_at,email) VALUES(?,?,?,?,?)').run(id,email,hash,new Date().toISOString(),email);
    db.prepare("INSERT OR IGNORE INTO app_settings VALUES('admin_user_id',?)").run(id);
    db.exec('COMMIT');return {user:{id,email}};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
