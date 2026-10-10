import {registerTestAccount as registerAccount} from './legal-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initAccounts,isAdmin} from '../server/accounts.js';

function database(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created_at TEXT NOT NULL)');initAccounts(db);return db;}
test('无需邀请码注册，邮箱规范化、密码校验与重复邮箱',()=>{
  const db=database();try{
    assert.equal(registerAccount(db,{email:'invalid',password:'password123'}).status,400);
    assert.equal(registerAccount(db,{email:'a@example.test',password:'short'}).status,400);
    const first=registerAccount(db,{email:' A@EXAMPLE.TEST ',password:'password123'}).user;
    assert.equal(first.email,'a@example.test');assert.equal(isAdmin(db,first),true);
    assert.equal(registerAccount(db,{email:first.email,password:'password123'}).status,409);
    const second=registerAccount(db,{email:'b@example.test',password:'password123'}).user;
    assert.equal(isAdmin(db,second),false);
    assert.equal(isAdmin(db,second,'B@EXAMPLE.TEST'),true);assert.equal(isAdmin(db,first,'b@example.test'),false);
    const stored=db.prepare('SELECT password FROM users WHERE id=?').get(first.id).password;
    assert.notEqual(stored,'password123');assert.match(stored,/^[a-f0-9]+:[a-f0-9]+$/);
  }finally{db.close();}
});
test('已有 100 个邮箱账号时仍能注册，管理员保持不变',()=>{
  const db=database();try{
    const insert=db.prepare('INSERT INTO users(id,username,password,created_at,email) VALUES(?,?,?,?,?)');
    for(let i=0;i<100;i++)insert.run(`existing-${i}`,`existing-${i}@example.test`,'unused-hash','2020-01-01',`existing-${i}@example.test`);
    initAccounts(db);
    const result=registerAccount(db,{email:'new@example.test',password:'password123'});
    assert.ok(result.user);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE email IS NOT NULL').get().n,101);
    assert.equal(isAdmin(db,result.user),false);
    assert.equal(isAdmin(db,{id:'existing-0',email:'existing-0@example.test'}),true);
  }finally{db.close();}
});
test('迁移保留旧账号和课堂；管理员持久化，不因新注册被替换',()=>{
  const db=database();try{
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('legacy','原用户名','hash','2020-01-01',null);
    const old=registerAccount(db,{email:'old@example.test',password:'password123'}).user;
    initAccounts(db);assert.equal(isAdmin(db,old),true);
    assert.equal(db.prepare('SELECT username FROM users WHERE id=?').get('legacy').username,'原用户名');
    const next=registerAccount(db,{email:'next@example.test',password:'password123'}).user;
    assert.ok(next);assert.equal(isAdmin(db,next),false);assert.equal(isAdmin(db,old),true);
  }finally{db.close();}
});
