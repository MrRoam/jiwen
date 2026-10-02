import {t} from './i18n.js';
import React,{useEffect,useState} from 'react';
import {api} from './api';

export function useTeacherQuestions(lessonId,recording){
  const [state,setState]=useState({lessonId:null,questions:[]});
  useEffect(()=>{
    let live=true,timer;const controller=new AbortController();
    setState({lessonId,questions:[]});
    if(!lessonId)return()=>{live=false;};
    const poll=async()=>{
      try{const data=await api(`/lessons/${lessonId}/teacher-questions`,{signal:controller.signal});if(live)setState({lessonId,questions:data.questions||[]});}
      catch{}finally{if(live)timer=setTimeout(poll,recording?1000:3000);}
    };
    poll();return()=>{live=false;clearTimeout(timer);controller.abort();};
  },[lessonId,recording]);
  return state.lessonId===lessonId?state.questions:[];
}

export function MarkedQuestions({text,questions}){
  if(!questions?.length)return text;
  const ranges=questions.map(q=>({start:text.indexOf(q.question),length:q.question.length,id:q.id})).filter(r=>r.start>=0).sort((a,b)=>a.start-b.start);
  const parts=[];let cursor=0;
  for(const r of ranges){if(r.start<cursor)continue;parts.push(text.slice(cursor,r.start));parts.push(<span className="detected-question" title="识别为课堂提问" key={r.id}>{text.slice(r.start,r.start+r.length)}</span>);cursor=r.start+r.length;}
  parts.push(text.slice(cursor));return parts;
}
