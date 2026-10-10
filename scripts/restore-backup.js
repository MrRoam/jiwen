import {restoreBackup} from '../server/backup.js';

const args=process.argv.slice(2),value=flag=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];};
try{
  const snapshotDir=value('--snapshot'),targetDir=value('--target'),journalPath=value('--deletions');
  if(!snapshotDir||!targetDir||!journalPath)throw new Error('用法：node scripts/restore-backup.js --snapshot <快照目录> --target <新的目标目录> --deletions <当前独立删除清单> [--apply]。默认只校验；--apply 才恢复。');
  console.log(JSON.stringify(restoreBackup({snapshotDir,targetDir,journalPath,dryRun:!args.includes('--apply')}),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
