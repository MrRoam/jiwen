export function exportAccount(db,user,legalVersion){
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const lessons=all('SELECT * FROM lessons WHERE user_id=? ORDER BY created_at',user.id).map(lesson=>({...lesson,
    recordings:all('SELECT * FROM recordings WHERE lesson_id=? ORDER BY offset_ms',lesson.id).map(r=>({...r,lessonTitle:lesson.title,audioUrl:r.status==='ready'?`/api/recordings/${r.id}/audio?download=1`:null})),
    segments:all('SELECT * FROM segments WHERE lesson_id=? ORDER BY start_ms',lesson.id),
    conversations:all('SELECT * FROM conversations WHERE lesson_id=? ORDER BY created_at',lesson.id).map(c=>({...c,snapshot:JSON.parse(c.snapshot),messages:all('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at',c.id)}))
  }));
  return {format:'jiwen-account-export-v1',exportedAt:new Date().toISOString(),legalVersion,account:{id:user.id,email:user.email,createdAt:user.created_at},paymentInterest:db.prepare('SELECT created_at FROM payment_interest WHERE user_id=?').get(user.id)||null,lessons,recordings:lessons.flatMap(l=>l.recordings),consents:all('SELECT version,accepted_at,adult FROM legal_consents WHERE user_id=?',user.id),audioNote:legalVersion==='personal-v1'?'录音链接需在本机应用运行时单独下载。JSON 不含音频二进制。':'录音链接需要在当前账号登录期间单独下载。JSON 不含音频二进制。'};
}
export function deleteAccountRows(db,user){
  // 用量表的外键与无外键明细都需要显式清理，不能只依赖 users 级联。
  const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const table of ['asr_usage','llm_requests','llm_provider_requests','importance_usage','teacher_question_usage'])if(names.has(table))db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
    if(names.has('password_resets'))db.prepare('DELETE FROM password_resets WHERE email=? COLLATE NOCASE').run(user.email);
    db.prepare('DELETE FROM lessons WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM users WHERE id=?').run(user.id);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
