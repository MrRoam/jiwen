const dayMs=86400000;
const clock=value=>typeof value==='function'?value():value;
const columns=(db,table)=>new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));

export function initLifecycle(db,now=Date.now,days=30){
  if(!Number.isSafeInteger(days)||days<=0)throw new Error('课堂保存天数必须是正整数。');
  if(!columns(db,'lessons').has('expires_at'))db.exec('ALTER TABLE lessons ADD COLUMN expires_at TEXT');
  const expiresAt=new Date(clock(now)+days*dayMs).toISOString();
  // 旧课从规则生效起获得完整窗口，不能因创建较早立即删除。
  db.prepare('UPDATE lessons SET expires_at=? WHERE expires_at IS NULL').run(expiresAt);
  return expiresAt;
}

export function createLifecycle(db,{days=30,now=Date.now,isBusy=()=>false,deleteLesson}={}){
  initLifecycle(db,now,days);
  const expiration=()=>new Date(clock(now)+days*dayMs).toISOString();
  function created(lessonId){db.prepare('UPDATE lessons SET expires_at=? WHERE id=?').run(expiration(),lessonId);}
  function touch(lessonId){db.prepare('UPDATE lessons SET expires_at=MAX(COALESCE(expires_at,?),?) WHERE id=?').run(expiration(),expiration(),lessonId);}
  let running=false;
  async function run(){
    if(running)return {skipped:true};running=true;
    try{
      const timestamp=clock(now),iso=new Date(timestamp).toISOString(),deleted=[],skipped=[];
      if(deleteLesson)for(const lesson of db.prepare('SELECT * FROM lessons WHERE expires_at<=?').all(iso)){
        if(isBusy(lesson.id)){skipped.push(lesson.id);continue;}
        await deleteLesson(lesson);deleted.push(lesson.id);
      }
      // 每小时执行时，已过期记录最迟在24小时内清理。
      if(columns(db,'sessions').has('expires'))db.prepare('DELETE FROM sessions WHERE expires<=?').run(timestamp);
      if(columns(db,'password_resets').has('expires_ms'))db.prepare('DELETE FROM password_resets WHERE expires_ms<=?').run(timestamp);
      const cutoff=new Date(timestamp-90*dayMs).toISOString();
      if(columns(db,'asr_usage').has('created_at'))db.prepare('DELETE FROM asr_usage WHERE created_at<?').run(cutoff);
      if(columns(db,'llm_requests').has('created_ms'))db.prepare('DELETE FROM llm_requests WHERE created_ms<?').run(timestamp-90*dayMs);
      if(columns(db,'llm_provider_requests').has('created_ms'))db.prepare('DELETE FROM llm_provider_requests WHERE created_ms<?').run(timestamp-90*dayMs);
      for(const table of ['importance_usage','teacher_question_usage','asr_global_usage','cost_usage'])if(columns(db,table).has('day'))db.prepare(`DELETE FROM ${table} WHERE day<?`).run(cutoff.slice(0,10));
      if(columns(db,'model_usage').has('created_at'))db.prepare('DELETE FROM model_usage WHERE created_at<?').run(cutoff);
      return {deleted,skipped};
    }finally{running=false;}
  }
  return {created,touch,run,days};
}
