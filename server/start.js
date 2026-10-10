import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 保持启动进程不变，管理员重启仅替换应用子进程，不触碰录音目录和公网隧道。
let worker,stopping=false,restarting=false;
function launch(){
  worker=fork(fileURLToPath(new URL('./index.js',import.meta.url)),process.argv.slice(2),{env:{...process.env,JIWEN_SUPERVISED:'true'},stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
  worker.on('message',message=>{if(message?.type==='restart')restarting=true;});
  worker.on('error',()=>{process.exitCode=1;});
  worker.on('exit',(code,signal)=>{
    if(!stopping&&restarting){restarting=false;launch();return;}
    process.exit(code??(signal?1:0));
  });
}
function stop(){if(stopping)return;stopping=true;worker?.send({type:'shutdown'});setTimeout(()=>{worker?.kill();process.exit(0);},5000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.on('message',message=>{if(message?.type==='shutdown')stop();});
process.on('disconnect',stop);
launch();
