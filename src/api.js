export async function api(url,options={}){
  let response;try{response=await fetch(`/api${url}`,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},body:options.body&&typeof options.body!=='string'?JSON.stringify(options.body):options.body});}catch{throw new Error('网络连接中断，请恢复网络后重试。');}
  const data=await response.json();if(!response.ok)throw new Error(data.error||'请求失败');return data;
}
export const time=ms=>{const s=Math.floor((ms||0)/1000);return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;};
export async function readEvents(response,callback){const reader=response.body.getReader(),decoder=new TextDecoder();let text='';while(true){const {done,value}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});const blocks=text.split('\n\n');text=blocks.pop();for(const block of blocks)for(const line of block.split('\n'))if(line.startsWith('data:'))callback(JSON.parse(line.slice(5)));}}
