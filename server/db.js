import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function openDatabase(directory) {
  mkdirSync(directory,{recursive:true});
  const db = new DatabaseSync(path.join(directory,'classroom.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,created_at TEXT NOT NULL,demo INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,offset_ms INTEGER NOT NULL,duration_ms INTEGER NOT NULL DEFAULT 0,mime TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'recording',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks(recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,seq INTEGER NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(recording_id,seq));
    CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY,lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,recording_id TEXT REFERENCES recordings(id) ON DELETE CASCADE,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,text TEXT NOT NULL,final INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,title TEXT NOT NULL,anchor_ms INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asr_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),seconds REAL NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS segments_lesson ON segments(lesson_id,start_ms);
    CREATE INDEX IF NOT EXISTS lessons_user ON lessons(user_id);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);
  `);
  // 重启不能让“生成中”或“录音中”永远挂起；音频块仍可恢复。
  db.exec("UPDATE messages SET status='failed' WHERE status='streaming'; UPDATE recordings SET status='interrupted' WHERE status IN ('recording','processing')");
  return db;
}
