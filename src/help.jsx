import {t,translateMessage,getLocale} from './i18n.js';
import React,{useEffect,useRef,useState} from 'react';
import {X,LoaderCircle,Zap} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {normalizeMath} from './markdown';
import {readEvents} from './api';
import './help.css';

export function HelpControl({lessonId,anchorMs,available,onCreated}){
  const [result,setResult]=useState(null);
  const request=useRef(null);
  const streaming=result?.status==='streaming';
  useEffect(()=>{
    setResult(null);
    return()=>{request.current?.controller.abort();request.current=null;};
  },[lessonId]);
  function close(){request.current?.controller.abort();request.current=null;setResult(null);}
  async function answer(){
    if(request.current)return;
    if(!lessonId||!available){setResult({status:'failed',text:'',error:!lessonId?'请先开始课堂录音，或打开已有课堂。':'问答服务暂时不可用，请稍后重试。'});return;}
    const job={controller:new AbortController()},live=()=>request.current===job;
    request.current=job;setResult({status:'streaming',text:''});
    let finished=false;
    try{
      const response=await fetch(`/api/lessons/${lessonId}/help`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({anchorMs,locale:getLocale()}),signal:job.controller.signal});
      if(!response.ok)throw new Error((await response.json()).error||'HELP 暂时无法回答。');
      await readEvents(response,event=>{
        if(!live())return;
        if(event.type==='started'){
          onCreated({id:event.conversationId,title:event.title,anchor_ms:event.anchor_ms,created_at:event.created_at},lessonId);
        }
        if(event.type==='delta')setResult(old=>({...old,text:old.text+event.text}));
        if(event.type==='done'){finished=true;setResult(old=>({...old,status:event.stopped?'stopped':'complete'}));}
        if(event.type==='error'){finished=true;setResult(old=>({...old,status:'failed',error:event.error}));}
      });
      if(live()&&!finished)throw new Error('回答连接中断，已保留收到的内容。');
    }catch(error){if(live())setResult(old=>({...old,status:'failed',error:error.name==='AbortError'?'回答已停止。':error instanceof TypeError?'网络连接中断，请恢复网络后重试。':error.message}));}
    finally{if(live())request.current=null;}
  }
  return <div className="help-control">
    {result&&<section id="help-result" className="help-result" aria-label={t("HELP 快速回答")} onKeyDown={e=>{if(e.key==='Escape'){close();e.currentTarget.parentElement.querySelector('.help-button')?.focus();}}}>
      <div className="help-result-heading"><strong>{t("快速回答")} <span className="ai-generated-label">· {t('AI 生成')}</span></strong><button className="icon" aria-label={result.status==='streaming'?t('关闭并停止 HELP 回答'):t('关闭 HELP 回答')} onClick={close}><X size={16}/></button></div>
      <div className="help-result-body" role="status" aria-live="polite" aria-atomic="false">
        {result.text&&<div className="help-answer"><ReactMarkdown remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[rehypeKatex]}>{normalizeMath(result.text)}</ReactMarkdown></div>}
        {result.status==='streaming'&&!result.text&&<p className="help-waiting">{t("正在回答…")}</p>}
        {result.error&&<p className="help-error">{translateMessage(result.error)}</p>}
      </div>
    </section>}
    <div className="help-toolbar"><button type="button" className="help-button" aria-label={streaming?t('正在回答老师的问题'):t('HELP：快速回答老师刚刚的问题')} title={t("快速回答老师刚刚的问题")} aria-busy={streaming} aria-disabled={streaming} aria-expanded={!!result} aria-controls={result?'help-result':undefined} onClick={answer}>{streaming?<LoaderCircle size={16} className="spin" aria-hidden="true"/>:<Zap size={16} aria-hidden="true"/>}<span className="help-cap">{streaming?t('稍候'):result?.status==='failed'?t('重试'):t('回答课堂提问')}</span></button></div>
  </div>;
}
