import {DatabaseSync} from 'node:sqlite';
import {appendFileSync,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

const dayMs=86400000;
const inside=(parent,child)=>{const relative=path.relative(path.resolve(parent),path.resolve(child));return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function assertOffline(dataDir,offline){
  if(!offline)throw new Error('备份前必须停止服务，并显式指定 offline。');
  const marker=path.join(dataDir,'runtime.json');
  if(existsSync(marker)){
    const state=JSON.parse(readFileSync(marker,'utf8'));
    if(!Number.isSafeInteger(state.pid)||state.pid<=0)throw new Error('运行标记无效，请核实服务已经停止。');
    try{process.kill(state.pid,0);}catch(error){if(error.code==='ESRCH')return;throw new Error('无法确认服务是否停止。');}
    throw new Error('服务仍在运行，请先停止录音和服务再备份。');
  }
}
function copyTree(source,target,{exclude=new Set()}={}){
  mkdirSync(target,{recursive:true});
  for(const entry of readdirSync(source,{withFileTypes:true})){
    if(exclude.has(entry.name))continue;
    if(entry.isSymbolicLink())throw new Error('备份目录含符号链接，请改用普通文件。');
    const input=path.join(source,entry.name),output=path.join(target,entry.name);
    if(entry.isDirectory())copyTree(input,output);else copyFileSync(input,output);
  }
}
function filesIn(directory,prefix=''){
  const files=[];for(const entry of readdirSync(path.join(directory,prefix),{withFileTypes:true})){
    const relative=path.join(prefix,entry.name);
    if(entry.isSymbolicLink())throw new Error('快照含符号链接。');
    if(entry.isDirectory())files.push(...filesIn(directory,relative));else files.push(relative);
  }return files;
}

export function appendDeletion(journalPath,entry){
  if(!['lesson','account'].includes(entry.type)||typeof entry.id!=='string'||!entry.id)throw new Error('删除记录无效。');
  mkdirSync(path.dirname(path.resolve(journalPath)),{recursive:true});
  // 先 durable 写删除标记，再允许业务删除；恢复必须提供这份独立清单。
  appendFileSync(journalPath,JSON.stringify({...entry,at:entry.at||new Date().toISOString()})+'\n',{encoding:'utf8',flush:true});
}

export function readDeletions(journalPath){
  if(!journalPath||!existsSync(journalPath))throw new Error('必须提供现存的独立删除清单；没有删除记录时也应提供空文件。');
  return readFileSync(journalPath,'utf8').split(/\r?\n/).filter(Boolean).map(line=>{
    const entry=JSON.parse(line);if(!['lesson','account'].includes(entry.type)||typeof entry.id!=='string'||!entry.id)throw new Error('删除清单含无效记录。');return entry;
  });
}

export function createBackup({dataDir,backupDir,offline=false,now=Date.now(),retentionDays=7}={}){
  dataDir=path.resolve(dataDir);backupDir=path.resolve(backupDir);
  if(inside(dataDir,backupDir)||inside(backupDir,dataDir))throw new Error('备份必须使用与主数据分离的目录。');
  if(!Number.isSafeInteger(retentionDays)||retentionDays<=0)throw new Error('备份保存天数必须是正整数。');
  assertOffline(dataDir,offline);
  const database=path.join(dataDir,'classroom.sqlite');if(!existsSync(database))throw new Error('找不到课堂数据库。');
  mkdirSync(backupDir,{recursive:true});
  const name=`snapshot-${new Date(now).toISOString().replaceAll(':','-')}-${randomUUID()}`,staging=path.join(backupDir,`.${name}.tmp`),destination=path.join(backupDir,name);
  try{
    mkdirSync(staging);const content=path.join(staging,'data');mkdirSync(content);
    const db=new DatabaseSync(database,{readOnly:true});
    try{db.exec(`VACUUM INTO ${quote(path.join(content,'classroom.sqlite'))}`);}finally{db.close();}
    copyTree(dataDir,content,{exclude:new Set(['classroom.sqlite','classroom.sqlite-wal','classroom.sqlite-shm','runtime.json'])});
    const files=filesIn(content).map(file=>({path:file.replaceAll(path.sep,'/'),bytes:statSync(path.join(content,file)).size,sha256:digest(path.join(content,file))}));
    const manifest={version:1,createdAt:new Date(now).toISOString(),mode:'offline',files};
    writeFileSync(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2));renameSync(staging,destination);
    let removed=0;
    for(const entry of readdirSync(backupDir,{withFileTypes:true})){
      if(!entry.isDirectory()||!entry.name.startsWith('snapshot-')||entry.name===name)continue;
      const folder=path.resolve(backupDir,entry.name),manifestPath=path.join(folder,'manifest.json');
      if(!inside(backupDir,folder)||!existsSync(manifestPath))continue;
      let prior;try{prior=JSON.parse(readFileSync(manifestPath,'utf8'));}catch{continue;}
      if(prior.version===1&&Date.parse(prior.createdAt)<=now-retentionDays*dayMs){rmSync(folder,{recursive:true});removed++;}
    }
    return {directory:destination,files:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes,0),removed};
  }catch(error){if(existsSync(staging)&&inside(backupDir,staging))rmSync(staging,{recursive:true,force:true});throw error;}
}

function replayDeletions(database,dataDir,entries){
  const db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const recordingIds=new Set();
  try{
    for(const entry of entries){
      for(const id of entry.recordingIds||[])recordingIds.add(id);
      const lessonIds=entry.type==='lesson'?[entry.id]:db.prepare('SELECT id FROM lessons WHERE user_id=?').all(entry.id).map(row=>row.id);
      for(const id of lessonIds){for(const row of db.prepare('SELECT id FROM recordings WHERE lesson_id=?').all(id))recordingIds.add(row.id);db.prepare('DELETE FROM lessons WHERE id=?').run(id);}
      if(entry.type==='account'){
        const user=db.prepare('SELECT * FROM users WHERE id=?').get(entry.id);
        const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        for(const {name} of tables){
          if(!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name))throw new Error('数据库表名无法安全重放删除。');
          const columns=db.prepare(`PRAGMA table_info(${name})`).all();
          if(columns.some(column=>column.name==='user_id'))db.prepare(`DELETE FROM ${name} WHERE user_id=?`).run(entry.id);
          if(name==='password_resets'&&user?.email)db.prepare('DELETE FROM password_resets WHERE email=? COLLATE NOCASE').run(user.email);
        }
        db.prepare('DELETE FROM users WHERE id=?').run(entry.id);
      }
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.close();}
  for(const id of recordingIds){if(typeof id!=='string'||!id||path.basename(id)!==id)throw new Error('删除清单中的录音标识无效。');const folder=path.resolve(dataDir,id);if(!inside(dataDir,folder)||folder===path.resolve(dataDir))throw new Error('录音删除路径无效。');rmSync(folder,{recursive:true,force:true});}
}

export function restoreBackup({snapshotDir,targetDir,journalPath,dryRun=true}={}){
  snapshotDir=path.resolve(snapshotDir);targetDir=path.resolve(targetDir);
  if(inside(snapshotDir,targetDir)||inside(targetDir,snapshotDir))throw new Error('恢复目标必须与快照分离。');
  if(inside(targetDir,journalPath))throw new Error('删除清单必须保留在恢复目标之外。');
  if(existsSync(targetDir))throw new Error('恢复目标已存在；请使用新的空目标路径，工具不会覆盖主数据。');
  const entries=readDeletions(journalPath),manifest=JSON.parse(readFileSync(path.join(snapshotDir,'manifest.json'),'utf8')),source=path.join(snapshotDir,'data');
  if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('快照格式不支持。');
  const expected=new Set();
  for(const file of manifest.files){
    const input=path.resolve(source,file.path);
    if(!inside(source,input)||input===source||typeof file.path!=='string'||expected.has(file.path))throw new Error('快照文件路径无效。');
    expected.add(file.path);
    if(!existsSync(input)||statSync(input).size!==file.bytes||digest(input)!==file.sha256)throw new Error(`快照文件校验失败：${file.path}`);
  }
  if(!expected.has('classroom.sqlite'))throw new Error('快照缺少数据库。');
  for(const file of filesIn(source))if(!expected.has(file.replaceAll(path.sep,'/')))throw new Error('快照包含清单之外的文件。');
  const summary={dryRun,targetDir,files:manifest.files.length,deletions:entries.length,createdAt:manifest.createdAt};
  if(dryRun)return summary;
  const staging=path.join(path.dirname(targetDir),`.restore-${randomUUID()}.tmp`);
  try{
    copyTree(source,staging);replayDeletions(path.join(staging,'classroom.sqlite'),staging,entries);
    rmSync(path.join(staging,'runtime.json'),{force:true});renameSync(staging,targetDir);return summary;
  }catch(error){if(existsSync(staging)&&inside(path.dirname(targetDir),staging))rmSync(staging,{recursive:true,force:true});throw error;}
}
