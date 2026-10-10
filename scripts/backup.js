import {createBackup} from '../server/backup.js';

const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];};
try{
  const dataDir=value('--data'),backupDir=value('--backups');
  if(!dataDir||!backupDir||!args.includes('--offline'))throw new Error('用法：node scripts/backup.js --data <已停服务的数据目录> --backups <独立备份目录> --offline。默认滚动保留7天；每日在无录音时运行。');
  console.log(JSON.stringify(createBackup({dataDir,backupDir,offline:true}),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
