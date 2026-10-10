import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
async function inspect(port){
  try{const response=await fetch(`http://127.0.0.1:${port}/api/me`,{signal:AbortSignal.timeout(3000)});return {ok:response.ok,body:await response.json()};}catch{return null;}
}
async function main(){
  const port=Number(process.env.CONSOLE_PORT??4319);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('本机控制台未启用，请检查 .env 中的 CONSOLE_PORT（默认 4319，0 表示关闭）。');
  const url=`http://127.0.0.1:${port}`,health=await inspect(port);
  if(!health?.ok){
    const appPort=Number(process.env.PORT||4317),app=Number.isSafeInteger(appPort)&&appPort>0&&appPort<65536?await inspect(appPort):null;
    if(app?.ok&&app.body?.config)throw new Error('即问正在运行，但尚未启动本机控制台。请结束当前任务后重启即问，再打开控制台。');
    throw new Error('即问服务尚未启动。请先运行“启动内测.cmd”或“启动.cmd”，再打开控制台。');
  }
  if(health.body?.console!==true)throw new Error(`端口 ${port} 上运行的不是本机控制台，请检查 CONSOLE_PORT。`);
  console.log(`本机控制台：${url}`);
  if(process.argv.includes('--check'))return;
  // 等待系统确认启动；Windows 使用默认浏览器的新窗口显示控制台。
  await new Promise((resolve,reject)=>{
    const browser=process.platform==='win32'?spawn('powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./open-console-window.ps1',import.meta.url)),url],{windowsHide:true,stdio:['ignore','ignore','pipe']}):spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:['ignore','ignore','pipe']});
    let detail='';browser.stderr.setEncoding('utf8');browser.stderr.on('data',value=>{detail+=value;});
    const timer=setTimeout(()=>{browser.kill();reject(new Error(`浏览器未能及时打开，请手动访问 ${url}。`));},10000);
    browser.once('error',()=>{clearTimeout(timer);reject(new Error(`无法启动浏览器，请手动访问 ${url}。`));});
    browser.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(`无法打开浏览器${detail.trim()?`：${detail.trim()}`:'。'}请手动访问 ${url}。`));});
  });
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
