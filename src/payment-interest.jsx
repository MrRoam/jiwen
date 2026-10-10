import React,{useEffect,useRef,useState} from 'react';
import {api} from './api';
import {getLocale,t} from './i18n.js';
import './payment-interest.css';

function LittleBell(){
  return <svg viewBox="0 0 120 112" fill="none" aria-hidden="true" className="payment-bell">
    <ellipse className="payment-bell-shadow" cx="60" cy="96" rx="38" ry="5" fill="#315e4b" opacity=".12"/>
    <g className="payment-bell-body">
      <g className="payment-bell-knob"><path d="M60 23V32" stroke="#42674d" strokeWidth="5" strokeLinecap="round"/><rect x="49" y="17" width="22" height="8" rx="4" fill="#f2d998" stroke="#42674d" strokeWidth="1.8"/></g>
      <path d="M26 77C26 50 38 32 60 32S94 50 94 77" fill="#d6e6b6" stroke="#42674d" strokeWidth="1.8"/>
      <path d="M35 61C37 47 45 41 53 40" stroke="#f5f9e9" strokeWidth="5" strokeLinecap="round"/>
      <path d="M80 45C88 56 90 66 90 77H80" fill="#bdcf9c" opacity=".65"/>
      <ellipse cx="46" cy="65" rx="5" ry="3" fill="#dca58f" opacity=".65"/><ellipse cx="74" cy="65" rx="5" ry="3" fill="#dca58f" opacity=".65"/>
      <g className="payment-bell-eyes"><path d="M48 56V60M72 56V60" stroke="#31533f" strokeWidth="3" strokeLinecap="round"/></g>
      <path className="payment-bell-smile" d="M55 64Q60 69 65 64" stroke="#31533f" strokeWidth="1.8" strokeLinecap="round"/>
      <rect x="21" y="76" width="78" height="9" rx="4.5" fill="#c1d69d" stroke="#42674d" strokeWidth="1.8"/>
    </g>
    <rect x="17" y="85" width="86" height="8" rx="4" fill="#42674d"/><path d="M24 87H96" stroke="#729070" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>;
}

// 连敲只重播反馈；期待人数由服务器按账号去重。
export function PaymentInterest(){
  const [interest,setInterest]=useState(null),[error,setError]=useState(''),[bursts,setBursts]=useState([]),[knock,setKnock]=useState(0);
  const mounted=useRef(false),pending=useRef(false),version=useRef(0),serial=useRef(0),timers=useRef(new Set());
  useEffect(()=>{
    mounted.current=true;const controller=new AbortController(),readVersion=version.current;
    api('/payment-interest',{signal:controller.signal}).then(value=>{if(mounted.current&&readVersion===version.current)setInterest(value);}).catch(()=>{});
    return()=>{mounted.current=false;controller.abort();for(const timer of timers.current)clearTimeout(timer);timers.current.clear();};
  },[]);
  function ring(){
    const id=++serial.current;
    setKnock(id);setBursts(current=>[...current.slice(-3),{id,text:id%3===0?'叮叮！':'叮！',tilt:id%2?'-9deg':'8deg'}]);
    const timer=setTimeout(()=>{timers.current.delete(timer);if(mounted.current)setBursts(current=>current.filter(burst=>burst.id!==id));},950);
    timers.current.add(timer);
    if(interest?.interested||pending.current)return;
    pending.current=true;version.current++;setError('');
    api('/payment-interest',{method:'POST'}).then(value=>{if(mounted.current)setInterest(value);}).catch(()=>{if(mounted.current)setError('没有记下，请再敲一次');}).finally(()=>{pending.current=false;});
  }
  return <section className="payment-interest" aria-labelledby="payment-interest-title">
    <div className="payment-interest-copy">
      <h3 id="payment-interest-title">{t('想要付费选项？')}</h3>
      <p>{t('敲敲小铃，让我知道。')}</p>
      <div className="payment-interest-count" role="status" aria-live="polite" aria-atomic="true">
        {error?<span className="payment-interest-error">{t(error)}</span>:interest?<span key={interest.count}>{t('{count} 人期待',{count:new Intl.NumberFormat(getLocale()).format(interest.count)})}{interest.interested&&<span className="payment-interest-you"> · {t('包括你')}</span>}</span>:<span>{t('尚未开放')}</span>}
      </div>
    </div>
    <button type="button" className="payment-interest-ring" onClick={ring} aria-label={interest?.interested?t('已记下你的期待，再敲一下小铃'):t('敲一下小铃，表达对付费选项的期待')}>
      <span className="payment-interest-stage">
        <span key={knock} className={`payment-interest-bell${knock?' is-ringing':''}`}><LittleBell/></span>
        <span className="payment-interest-bursts" aria-hidden="true">{bursts.map(burst=><span key={burst.id} className="payment-interest-burst" style={{'--burst-tilt':burst.tilt}}><b>{t(burst.text)}</b><i className="payment-spark payment-spark-one">✦</i><i className="payment-spark payment-spark-two">✧</i><i className="payment-spark payment-spark-three">✦</i></span>)}</span>
      </span>
      <span className="payment-interest-hint">{interest?.interested?t('再敲一下'):t('敲一下')}</span>
    </button>
  </section>;
}
