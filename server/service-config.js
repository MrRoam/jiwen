import {existsSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import path from 'node:path';
import {routingConfig} from './answer-router.js';

export const SERVICE_DEFAULTS={
  ASR_PROVIDER:'remote',ASR_WS_URL:'wss://dashscope.aliyuncs.com/api-ws/v1/inference',ASR_MODEL:'fun-asr-realtime',
  LOCAL_ASR_URL:'http://127.0.0.1:4318',LOCAL_ASR_MODEL:'small',
  LLM_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',LLM_MODEL:'qwen3.7-flash',
  LLM_USE_ASR_KEY:'true',LLM_ROUTING:'qwen-only'
};
const secretFields=['DASHSCOPE_API_KEY','LLM_API_KEY','OPENROUTER_API_KEY'];
const allowedFields=new Set([...Object.keys(SERVICE_DEFAULTS),...secretFields]);
const loopback=host=>['localhost','127.0.0.1','[::1]'].includes(host);

function validateUrl(value,protocols,label){
  let url;try{url=new URL(value);}catch{throw new Error(`${label}格式不正确。`);}
  if(!protocols.includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error(`${label}需使用正确协议，且不能包含账号、密钥、查询参数或片段。`);
  if(['http:','ws:'].includes(url.protocol)&&!loopback(url.hostname))throw new Error(`${label}需使用 HTTPS 或 WSS；仅本机接口允许明文连接。`);
  return url;
}

export function validateServiceEnv(env){
  if(!['remote','local'].includes(env.ASR_PROVIDER))throw new Error('请选择远程或本地转写。');
  if(!['qwen-only','openrouter-first'].includes(env.LLM_ROUTING))throw new Error('问答路由配置不正确。');
  if(!['true','false'].includes(env.LLM_USE_ASR_KEY))throw new Error('复用转写密钥配置不正确。');
  validateUrl(env.ASR_WS_URL,['wss:','ws:'],'转写地址');
  validateUrl(env.LLM_BASE_URL,['https:','http:'],'问答地址');
  const local=validateUrl(env.LOCAL_ASR_URL,['http:','https:'],'本地转写地址');
  if(!loopback(local.hostname))throw new Error('本地转写地址必须指向本机。');
  for(const field of ['ASR_MODEL','LLM_MODEL','LOCAL_ASR_MODEL'])if(!env[field]?.trim()||env[field].length>500)throw new Error('请填写有效模型名称。');
  // 同时检查既有 OpenRouter 配额设置；无效配置不会写入磁盘。
  routingConfig(env);
}

export function createServiceConfig(directory,baseEnv=process.env){
  const file=path.join(directory,'service-config.json');
  let overrides={};
  if(existsSync(file)){
    try{
      const stored=JSON.parse(readFileSync(file,'utf8'));
      if(!stored||typeof stored!=='object'||Array.isArray(stored))throw new Error();
      for(const [key,value]of Object.entries(stored)){
        if(!allowedFields.has(key)||typeof value!=='string')throw new Error();
        overrides[key]=value;
      }
    }catch{throw new Error('私有 API 配置文件无法读取，请检查 data/service-config.json。');}
  }
  const env=()=>({...baseEnv,...Object.fromEntries(Object.entries(SERVICE_DEFAULTS).map(([key,value])=>[key,baseEnv[key]||value])),...overrides});
  function summary(){
    const current=env(),result={};
    for(const key of Object.keys(SERVICE_DEFAULTS))result[key]=current[key];
    for(const key of secretFields)result[`${key}_CONFIGURED`]=!!current[key];
    const route=routingConfig(current);
    result.ASR_READY=current.ASR_PROVIDER==='local'||!!current.DASHSCOPE_API_KEY;
    result.LLM_READY=!!(route.fallback.key||(route.enabled&&route.primary.key));
    return result;
  }
  return {
    env,summary,
    update(body){
      if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('API 配置格式不正确。');
      const next={...overrides};
      for(const [key,value]of Object.entries(body)){
        if(!allowedFields.has(key))throw new Error('包含不支持的 API 配置项。');
        if(typeof value!=='string'||value.length>4096||/[\r\n\0]/.test(value))throw new Error('API 配置值格式不正确。');
        // 空密钥表示保留；显式清除通过独立的管理员操作处理。
        if(secretFields.includes(key)&&!value.trim())continue;
        next[key]=value.trim();
      }
      const candidate={...env(),...next};validateServiceEnv(candidate);
      const temporary=file+'.tmp';
      try{writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,file);}
      catch(error){rmSync(temporary,{force:true});throw Object.assign(new Error('API 配置保存失败，请检查数据目录写入权限。'),{cause:error});}
      overrides=next;return summary();
    },
    clear(service){
      const fields=service==='asr'?['DASHSCOPE_API_KEY']:service==='llm'?['LLM_API_KEY','OPENROUTER_API_KEY']:null;
      if(!fields)throw new Error('请选择转写或问答服务。');
      const next={...overrides};for(const key of fields)next[key]='';
      if(service==='llm')next.LLM_USE_ASR_KEY='false';
      const temporary=file+'.tmp';
      try{writeFileSync(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,file);}
      catch(error){rmSync(temporary,{force:true});throw Object.assign(new Error('API 配置保存失败，请检查数据目录写入权限。'),{cause:error});}
      overrides=next;return summary();
    }
  };
}
