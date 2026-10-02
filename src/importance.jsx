import {t,translateMessage} from './i18n.js';
import React,{useEffect,useRef,useState} from 'react';
import {api} from './api';
import './importance.css';

export function useImportance({lesson,available=true,ready,setLesson,setNotice}){
  const lid=available?lesson?.id:null;
  const [state,setState]=useState(null),[busy,setBusy]=useState(false),[networkError,setNetworkError]=useState('');
  const serial=useRef(0),action=useRef(false),currentId=useRef(lid);currentId.current=lid;
  useEffect(()=>{
    let live=true,timer;const controller=new AbortController();
    serial.current++;action.current=false;setBusy(false);setState(null);setNetworkError('');
    if(!lid)return()=>{live=false;};
    const poll=async()=>{
      const version=serial.current;
      try{if(!action.current){const data=await api(`/lessons/${lid}/importance`,{signal:controller.signal});if(live&&version===serial.current){setState({lid,...data});setNetworkError('');}}}
      catch{if(live&&version===serial.current)setNetworkError('重点标记更新中断，正在重连。');}
      finally{if(live)timer=setTimeout(poll,3000);}
    };
    poll();return()=>{live=false;clearTimeout(timer);controller.abort();};
  },[lid]);
  const data=state?.lid===lid?state:null;
  async function change(value){
    if(!available||action.current)return;
    if(!lid){if(value&&!ready)return setNotice('Jev 尚未配置，请查看服务设置。');setLesson(l=>({...l,importanceEnabled:value}));return;}
    action.current=true;setBusy(true);const version=++serial.current;
    try{const result=await api(`/lessons/${lid}/importance${value==='analyze'?'/analyze':''}`,{method:value==='analyze'?'POST':'PATCH',body:value==='analyze'?{}:{enabled:value}});
      if(currentId.current===lid&&version===serial.current){setState({lid,...result});setNetworkError('');}
    }catch(error){if(currentId.current===lid)setNotice(error.message);}
    finally{if(currentId.current===lid&&version===serial.current){action.current=false;setBusy(false);}}
  }
  const enabled=available&&(lid?!!data?.enabled:!!lesson?.importanceEnabled);
  const results=new Map((data?.results||[]).map(r=>[r.id,r]));
  const remaining=(lesson?.segments||[]).filter(s=>s.final&&s.text.trim()&&results.get(s.id)?.text!==s.text).length;
  return {enabled,busy,loading:!!lid&&!data,ready,change,data,remaining,error:networkError||data?.error||'',
    band(s){const r=results.get(s.id);return enabled&&s.final&&r?.text===s.text?`importance-${r.band}`:'';},
  };
}

export function ImportanceToggle({value,onSettings,disabled}){
  return <div className="importance-toggle-wrap">
    <label className="importance-toggle" title={t("根据课堂上下文标记重点，不判断内容正确性")}>
      <span>{t("重点标记")}</span><input type="checkbox" role="switch" aria-label={t("重点标记")} checked={value.enabled} disabled={disabled||value.busy||value.loading||(!value.ready&&!value.enabled)} onChange={e=>value.change(e.target.checked)}/><i aria-hidden="true"/>
    </label>
    {!value.ready&&<button className="importance-config" onClick={onSettings}>{t("未配置")}</button>}
  </div>;
}

export function ImportanceDetails({value,hasSegments}){
  const {data,enabled,error,busy}=value;
  const showStatus=enabled&&hasSegments&&(error||data?.pending>0||value.remaining>0);
  if(!showStatus)return null;
  return <div className="importance-details">
    <div className="importance-status">
      <span>{translateMessage(error)||(data?.pending?t('正在分析 {count} 句…',{count:data.pending}):'')}</span>
      {value.remaining>0&&<button disabled={busy||!!data?.pending} onClick={()=>value.change('analyze')}>{data?.failed?t('重试未完成内容'):t('分析已有内容')}</button>}
    </div>
  </div>;
}
