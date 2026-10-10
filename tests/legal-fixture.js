import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {normalizeEmail,validEmail,registerAccount} from '../server/accounts.js';
import {issueRegistrationCode} from '../server/registration-codes.js';

export async function legalFetch(input,options={}){
  return globalThis.fetch(input,options);
}

// 非邮件功能测试在各自临时数据库准备验证码，不访问真实邮箱。
// 注册端到端测试使用原生 fetch 和模拟 SMTP，不经过此辅助函数。
export function registerTestAccount(db,body,options){
  const email=normalizeEmail(body.email);
  if(!validEmail(email)||typeof body.password!=='string'||body.password.length<8||body.password.length>128)return registerAccount(db,body,options);
  if(db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email))return registerAccount(db,body,options);
  const issued=issueRegistrationCode(db,email);
  if(issued.error)throw new Error(issued.error);
  return registerAccount(db,{...body,code:issued.code},options);
}

export function createAccountFetch(directory){
  return async(input,options={})=>{
    if(new URL(input).pathname==='/api/auth/register'&&options.body){
      const body=JSON.parse(options.body),email=normalizeEmail(body.email);
      if(!body.code&&validEmail(email)&&typeof body.password==='string'&&body.password.length>=8&&body.password.length<=128){
        const db=new DatabaseSync(path.join(directory,'classroom.sqlite'));
        try{
          if(!db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email)){
            const issued=issueRegistrationCode(db,email);
            if(issued.error)throw new Error(issued.error);
            options={...options,body:JSON.stringify({...body,code:issued.code})};
          }
        }finally{db.close();}
      }
    }
    return globalThis.fetch(input,options);
  };
}
