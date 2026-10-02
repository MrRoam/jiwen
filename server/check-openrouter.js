import {checkOpenRouter} from './openrouter-status.js';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import path from 'node:path';
const result=await checkOpenRouter(process.env.OPENROUTER_API_KEY);
const file=path.resolve(process.env.DATA_DIR||'data','classroom.sqlite');
if(existsSync(file)){
  const db=new DatabaseSync(file,{readOnly:true});
  try{if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_provider_requests'").get())result.localToday=db.prepare('SELECT provider,model,COUNT(*) requests FROM llm_provider_requests WHERE created_ms>=? GROUP BY provider,model').all(new Date().setUTCHours(0,0,0,0));}
  finally{db.close();}
}
console.log(JSON.stringify(result,null,2));
if(!result.keyConfigured||result.keyValid===false)process.exitCode=2;
