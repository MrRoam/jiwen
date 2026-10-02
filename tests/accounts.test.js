import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initAccounts,registerAccount,isAdmin} from '../server/accounts.js';

function database(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created_at TEXT NOT NULL)');initAccounts(db);return db;}
test('无需邀请码注册，邮箱规范化、密码校验、重复邮箱与账号名额',()=>{
  const db=database();try{
    assert.equal(registerAccount(db,{email:'invalid',password:'password123'}).status,400);
    assert.equal(registerAccount(db,{email:'a@example.test',password:'short'}).status,400);
    const first=registerAccount(db,{email:' A@EXAMPLE.TEST ',password:'password123'},2).user;
    assert.equal(first.email,'a@example.test');assert.equal(isAdmin(db,first),true);
    assert.equal(registerAccount(db,{email:first.email,password:'password123'},2).status,409);
    const second=registerAccount(db,{email:'b@example.test',password:'password123'},2).user;
    assert.equal(isAdmin(db,second),false);
    assert.equal(registerAccount(db,{email:'c@example.test',password:'password123'},2).status,403);
    assert.equal(isAdmin(db,second,'B@EXAMPLE.TEST'),true);assert.equal(isAdmin(db,first,'b@example.test'),false);
    const stored=db.prepare('SELECT password FROM users WHERE id=?').get(first.id).password;
    assert.notEqual(stored,'password123');assert.match(stored,/^[a-f0-9]+:[a-f0-9]+$/);
  }finally{db.close();}
});
test('迁移保留旧账号和课堂；管理员持久化，不因新注册被替换',()=>{
  const db=database();try{
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('legacy','原用户名','hash','2020-01-01',null);
    const old=registerAccount(db,{email:'old@example.test',password:'password123'},1).user;
    initAccounts(db);assert.equal(isAdmin(db,old),true);
    assert.equal(db.prepare('SELECT username FROM users WHERE id=?').get('legacy').username,'原用户名');
    assert.equal(registerAccount(db,{email:'next@example.test',password:'password123'},1).status,403);
  }finally{db.close();}
});
