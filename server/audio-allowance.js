export const trialAudioSeconds=3600;

export function audioQuotaMode(value='monthly'){
  if(!['monthly','trial'].includes(value))throw new Error('ASR_QUOTA_MODE 必须为 monthly 或 trial。');
  return value;
}

export function initAudioAllowance(db,mode='monthly'){
  audioQuotaMode(mode);
  db.exec(`CREATE TABLE IF NOT EXISTS account_audio_allowance (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    limit_seconds INTEGER NOT NULL CHECK(limit_seconds=3600),
    used_seconds REAL NOT NULL DEFAULT 0 CHECK(used_seconds>=0),
    granted_at TEXT NOT NULL
  )`);
  // 首次切换时赠送已有账号；重启及模式往返保留累计用量，不从会清理的明细重算。
  if(mode==='trial')db.prepare('INSERT OR IGNORE INTO account_audio_allowance(user_id,limit_seconds,granted_at) SELECT id,?,? FROM users').run(trialAudioSeconds,new Date().toISOString());
}

export function grantAudioAllowance(db,userId){
  db.prepare('INSERT INTO account_audio_allowance(user_id,limit_seconds,granted_at) VALUES(?,?,?)').run(userId,trialAudioSeconds,new Date().toISOString());
}
