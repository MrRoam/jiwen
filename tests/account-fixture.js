import {openDatabase} from '../server/db.js';
export async function seedLegacyUser(directory){
 const {scryptSync}=await import('node:crypto');const db=openDatabase(directory);
 try{db.prepare('INSERT INTO users(id,username,password,created_at) VALUES(?,?,?,?)').run('legacy-test','原用户名',`test-salt:${scryptSync('legacy-password','test-salt',64).toString('hex')}`,new Date().toISOString());}finally{db.close();}
}
