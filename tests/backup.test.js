import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/db.js';
import {appendDeletion,createBackup,restoreBackup} from '../server/backup.js';

function setup(t){
  const root=mkdtempSync(path.join(tmpdir(),'jiwen-backup-')),dataDir=path.join(root,'data'),backupDir=path.join(root,'backups'),journalPath=path.join(root,'deletions.jsonl');
  const db=openDatabase(dataDir);db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u','user','unused','2026-10-07');
  for(const id of ['keep','deleted']){db.prepare('INSERT INTO lessons(id,user_id,title,created_at) VALUES(?,?,?,?)').run(id,'u','课','2026-10-07');db.prepare('INSERT INTO recordings(id,lesson_id,offset_ms,mime,created_at) VALUES(?,?,?,?,?)').run(id,id,0,'audio/webm','2026-10-07');mkdirSync(path.join(dataDir,id));writeFileSync(path.join(dataDir,id,'audio.m4a'),'synthetic-audio');}
  db.close();writeFileSync(journalPath,'');t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,dataDir,backupDir,journalPath};
}
test('停服务快照可验证恢复，先重放删除清单避免旧课堂复活',t=>{
  const {root,dataDir,backupDir,journalPath}=setup(t),backup=createBackup({dataDir,backupDir,offline:true});
  appendDeletion(journalPath,{type:'lesson',id:'deleted',recordingIds:['deleted']});const targetDir=path.join(root,'restored');
  assert.equal(restoreBackup({snapshotDir:backup.directory,targetDir,journalPath}).dryRun,true);assert.equal(existsSync(targetDir),false);
  restoreBackup({snapshotDir:backup.directory,targetDir,journalPath,dryRun:false});
  const db=new DatabaseSync(path.join(targetDir,'classroom.sqlite'));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n,1);assert.equal(db.prepare('SELECT id FROM lessons').get().id,'keep');}finally{db.close();}
  assert.equal(existsSync(path.join(targetDir,'deleted')),false);assert.equal(existsSync(path.join(targetDir,'keep','audio.m4a')),true);
});
test('账号删除重放清除关联课堂、用量、会话和文件',t=>{
  const {root,dataDir,backupDir,journalPath}=setup(t),backup=createBackup({dataDir,backupDir,offline:true});appendDeletion(journalPath,{type:'account',id:'u'});
  const targetDir=path.join(root,'restored');restoreBackup({snapshotDir:backup.directory,targetDir,journalPath,dryRun:false});
  const db=new DatabaseSync(path.join(targetDir,'classroom.sqlite'));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n,0);}finally{db.close();}
  assert.equal(existsSync(path.join(targetDir,'keep')),false);
});
test('备份拒绝活动服务及主数据内备份，恢复默认不覆盖和不忽略清单',t=>{
  const {root,dataDir,backupDir,journalPath}=setup(t);
  assert.throws(()=>createBackup({dataDir,backupDir}),/停止服务/);assert.throws(()=>createBackup({dataDir,backupDir:path.join(dataDir,'backup'),offline:true}),/分离/);
  writeFileSync(path.join(dataDir,'runtime.json'),JSON.stringify({pid:process.pid}));assert.throws(()=>createBackup({dataDir,backupDir,offline:true}),/仍在运行/);rmSync(path.join(dataDir,'runtime.json'));
  const backup=createBackup({dataDir,backupDir,offline:true});assert.throws(()=>restoreBackup({snapshotDir:backup.directory,targetDir:dataDir,journalPath}),/已存在/);assert.throws(()=>restoreBackup({snapshotDir:backup.directory,targetDir:path.join(root,'new'),journalPath:path.join(root,'missing')}),/删除清单/);
});
test('七天滚动只删除过期快照，文件变动校验失败',t=>{
  const {root,dataDir,backupDir,journalPath}=setup(t),initial=Date.parse('2026-10-01T00:00:00Z');
  const old=createBackup({dataDir,backupDir,offline:true,now:initial});
  const current=createBackup({dataDir,backupDir,offline:true,now:initial+7*86400000});assert.equal(current.removed,1);assert.equal(existsSync(old.directory),false);
  writeFileSync(path.join(current.directory,'data','keep','audio.m4a'),'changed');assert.throws(()=>restoreBackup({snapshotDir:current.directory,targetDir:path.join(root,'new'),journalPath}),/校验失败/);
});
