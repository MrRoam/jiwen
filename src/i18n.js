import english from './locales/en.js';

export const LOCALE_KEY='jiwen-locale';
export const DEFAULT_LOCALE='zh-CN';
export const supportedLocales=['zh-CN','en'];
export function readLocale(storage){
  try{const saved=storage?.getItem(LOCALE_KEY);return supportedLocales.includes(saved)?saved:DEFAULT_LOCALE;}
  catch{return DEFAULT_LOCALE;}
}
function browserStorage(){try{return globalThis.localStorage;}catch{return undefined;}}
let locale=readLocale(browserStorage());
const listeners=new Set();
export const getLocale=()=>locale;
export function subscribeLocale(listener){listeners.add(listener);return()=>listeners.delete(listener);}
function updateDocument(){
  if(typeof document==='undefined')return;
  document.documentElement.lang=locale;
  document.title=locale==='en'?'Jiwen':'即问';
}
export function setLocale(next,storage=browserStorage()){
  if(!supportedLocales.includes(next))return;
  try{storage?.setItem(LOCALE_KEY,next);}catch{}
  if(next===locale)return;
  locale=next;updateDocument();listeners.forEach(listener=>listener());
}
updateDocument();
if(typeof window!=='undefined')window.addEventListener('storage',event=>{
  if(event.key!==LOCALE_KEY&&event.key!==null)return;
  const next=readLocale(browserStorage());
  if(next!==locale){locale=next;updateDocument();listeners.forEach(listener=>listener());}
});

// 中文原文作为稳定的文案键；参数只插入文本，不处理课堂和对话内容。
export function t(source,params={},language=locale){
  let value=language==='en'&&Object.hasOwn(english,source)?english[source]:source;
  if(typeof value==='object')value=value[Number(params.count)===1?'one':'other'];
  return String(value??'').replace(/\{(\w+)\}/g,(match,key)=>params[key]===undefined?match:String(params[key]));
}
const escapePattern=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const messagePatterns=Object.keys(english).filter(key=>/\{\w+\}/.test(key)).map(key=>{
  const names=[...key.matchAll(/\{(\w+)\}/g)].map(match=>match[1]);
  return {key,names,pattern:new RegExp('^'+key.split(/\{\w+\}/).map(escapePattern).join('(.*?)')+'$')};
});
// 只用于系统状态与错误；未知中文服务错误在英文版中显示可操作的提示。
export function translateMessage(message,language=locale){
  const source=String(message??'');
  if(Object.hasOwn(english,source))return t(source,{},language);
  for(const {key,names,pattern} of messagePatterns){
    const match=source.match(pattern);
    if(match){const params=Object.fromEntries(names.map((name,i)=>[name,match[i+1]]));
      if(params.reason)params.reason=translateMessage(params.reason,language);
      return t(key,params,language);
    }
  }
  return language==='en'&&/\p{Script=Han}/u.test(source)?'The service is temporarily unavailable. Please try again.':source;
}
export function formatDate(value,options,language=locale){return new Intl.DateTimeFormat(language==='en'?'en-US':'zh-CN',options).format(new Date(value));}
export function defaultLessonTitle(date=new Date(),language=locale){return t('{date}的课堂',{date:formatDate(date,{month:'long',day:'numeric'},language)},language);}
