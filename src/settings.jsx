import {t,translateMessage} from './i18n.js';
import {LanguageSelect} from './locale.jsx';
import React,{useState,useEffect,useLayoutEffect,useRef} from 'react';
import {Mic,MessageCircle,ScanLine,ChevronRight,KeyRound,LogOut,LoaderCircle,RotateCcw,Check,ArrowLeft} from 'lucide-react';
import {api} from './api';
import './settings.css';

const services=[{id:'asr',name:'实时转写',Icon:Mic},{id:'llm',name:'AI 问答',Icon:MessageCircle},{id:'jev',name:'重点与提问识别',Icon:ScanLine}];

function ServiceRow({id,name,Icon}){
  const [result,setResult]=useState(null),[testing,setTesting]=useState(false);
  async function test(){
    setTesting(true);setResult(null);
    try{setResult(await api('/services/test',{method:'POST',body:{service:id}}));}
    catch(e){setResult({ok:false,message:e.message});}
    finally{setTesting(false);}
  }
  return <div className="settings-service">
    <div className="settings-service-main"><span className="settings-row-label"><Icon size={18} strokeWidth={1.7}/><strong>{t(name)}</strong></span><button className="settings-action" disabled={testing} onClick={test}>{testing&&<LoaderCircle size={14} className="spin"/>}{testing?t('检测中…'):t('检测')}</button></div>
    {result&&<p role="status" className={`settings-test-result ${result.ok?'is-success':'is-error'}`}>{result.ok&&<Check size={14}/>}<span>{result.ok?t('连接正常'):t('检测失败：{reason}',{reason:translateMessage(/配置|API.?Key|密钥|\.env|功能已暂停/i.test(result.message||'')?t('功能暂时不可用，请稍后重试。'):result.message||t('请稍后重试'))})}{result.ok&&result.elapsedMs>0&&t(' · {count} 秒',{count:(result.elapsedMs/1000).toFixed(1)})}</span></p>}
  </div>;
}

function UsageSummary(){
  const [usage,setUsage]=useState(null),[error,setError]=useState(false);
  useEffect(()=>{let mounted=true;api('/usage').then(value=>{if(mounted)setUsage(value.llm);}).catch(()=>{if(mounted)setError(true);});return()=>{mounted=false;};},[]);
  return <div className="settings-usage"><span>{t("今日问答额度")}</span><strong>{usage?<>{t('剩余 {count}',{count:usage.remaining})}<small>{t(' / {count} 次',{count:usage.limit})}</small></>:error?t('暂时无法读取'):t('读取中…')}</strong>{usage&&<p>{t("每日北京时间 08:00 更新")}</p>}</div>;
}

function PasswordForm({onBack}){
  const [oldPw,setOldPw]=useState(''),[newPw,setNewPw]=useState(''),[confirm,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <form className="settings-password" onSubmit={async e=>{
    e.preventDefault();setError('');
    if(newPw!==confirm){setError('两次输入的新密码不一致。');return;}
    setBusy(true);
    try{await api('/auth/change-password',{method:'POST',body:{oldPassword:oldPw,newPassword:newPw}});onBack('密码已修改，下次登录请使用新密码。');}
    catch(e){setError(e.message);}
    finally{setBusy(false);}
  }}>
    <label>{t("当前密码")}<input className="form-input" type="password" autoComplete="current-password" maxLength={128} required value={oldPw} onChange={e=>setOldPw(e.target.value)} disabled={busy}/></label>
    <label>{t("新密码")}<input className="form-input" type="password" autoComplete="new-password" minLength={8} maxLength={128} required placeholder={t("至少 8 位")} value={newPw} onChange={e=>setNewPw(e.target.value)} disabled={busy}/></label>
    <label>{t("确认新密码")}<input className="form-input" type="password" autoComplete="new-password" maxLength={128} required value={confirm} onChange={e=>setConfirm(e.target.value)} disabled={busy}/></label>
    {error&&<p className="settings-inline-error" role="alert">{translateMessage(error)}</p>}
    <div className="settings-password-actions"><button type="button" className="settings-action" disabled={busy} onClick={()=>onBack()}>{t("取消")}</button><button className="primary" disabled={busy}>{busy&&<LoaderCircle className="spin" size={16}/>} {t('保存新密码')}</button></div>
  </form>;
}

export function SettingsDialog({Modal,jevEnabled=false,deviceId,setDeviceId,devices,setDevices,recording,saving,starting,inputDevice,onApiConfig,onClose}){
  const [reading,setReading]=useState(false),[deviceError,setDeviceError]=useState('');
  const readLock=useRef(false);
  const deviceLocked=recording||saving||starting;
  async function refreshDevices(){
    if(deviceLocked||readLock.current)return;
    readLock.current=true;setReading(true);setDeviceError('');let stream;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器无法访问麦克风，请使用支持录音的浏览器并通过安全连接打开。');
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const next=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
      setDevices(next);
      if(deviceId&&!next.some(d=>d.deviceId===deviceId)){setDeviceId('');setDeviceError('原设备已断开，已切换为系统默认麦克风。');}
    }catch(e){setDeviceError(e.name==='NotAllowedError'?'麦克风权限未开启，请在浏览器中允许访问后重试。':e.name==='NotFoundError'?'未找到麦克风，请连接设备后重试。':e.message);}
    finally{stream?.getTracks().forEach(t=>t.stop());readLock.current=false;setReading(false);}
  }
  return <Modal title={t("设置")} className="settings-modal" onClose={onClose}>
    <div className="settings-page">
        <section className="settings-section"><button className="settings-account-row" onClick={onApiConfig}><span className="settings-row-label"><KeyRound size={18}/>{t('API 配置')}</span><ChevronRight size={16}/></button></section>
        <section className="settings-section" aria-labelledby="settings-display"><div className="settings-section-heading"><h3 id="settings-display">{t('显示')}</h3></div><LanguageSelect/></section>
        <section className="settings-section" aria-labelledby="settings-audio">
          <div className="settings-section-heading"><h3 id="settings-audio">{t("录音设备")}</h3></div>
          <label className="settings-device-label" htmlFor="settings-microphone">{t("麦克风")}</label>
          <div className="settings-device-controls"><select id="settings-microphone" className="form-input settings-device-select" disabled={deviceLocked||reading} value={deviceId} onFocus={()=>{if(!devices.length)refreshDevices();}} onChange={e=>setDeviceId(e.target.value)}><option value="">{t("系统默认麦克风")}</option>{devices.filter(d=>d.deviceId!=='default').map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||t('麦克风 {count}',{count:i+1})}</option>)}</select><button className="settings-refresh" disabled={deviceLocked||reading} onClick={refreshDevices}>{reading?<LoaderCircle size={15} className="spin"/>:<RotateCcw size={15}/>}{reading?t('读取中'):t('刷新设备')}</button></div>
          {deviceLocked&&<p className="settings-help">{starting?t('正在启动录音，请稍候。'):saving?t('录音保存后可切换设备。'):t('录音结束后可切换设备。')}{recording&&inputDevice&&<>{t("当前音源：")}{inputDevice}</>}</p>}
          {deviceError&&<p className="settings-inline-error" role="alert">{translateMessage(deviceError)}</p>}
        </section>
        <section className="settings-section" aria-labelledby="settings-services"><div className="settings-section-heading"><h3 id="settings-services">{t("课堂功能")}</h3></div>{services.filter(service=>service.id!=='jev'||jevEnabled===true).map(service=><ServiceRow key={service.id} {...service}/>)}</section>
    </div>
  </Modal>;
}

export function AccountDialog({Modal,me,anchor,recording,saving,starting,busy,onClose,onLogout}){
  const [page,setPage]=useState('account'),[logoutError,setLogoutError]=useState(''),[loggingOut,setLoggingOut]=useState(false),[success,setSuccess]=useState(''),[position,setPosition]=useState(null);
  const content=useRef(null);
  const deviceLocked=recording||saving||starting,logoutLocked=deviceLocked||busy||loggingOut;
  const identity=me.email;
  useLayoutEffect(()=>{
    function place(){
      const r=anchor.getBoundingClientRect(),viewport=window.visualViewport;
      const vw=viewport?.width||window.innerWidth,vh=viewport?.height||window.innerHeight,top=viewport?.offsetTop||0;
      const width=Math.min(360,vw-24),beside=r.right+12+width<=vw-12;
      const left=beside?r.right+12:Math.max(12,Math.min(r.left,vw-width-12));
      const bottomEdge=Math.max(top+80,Math.min(beside?r.bottom:r.top-12,top+vh-12));
      setPosition({left,bottom:window.innerHeight-bottomEdge,width,maxHeight:bottomEdge-top-12});
    }
    place();window.addEventListener('resize',place);window.visualViewport?.addEventListener('resize',place);window.visualViewport?.addEventListener('scroll',place);
    return()=>{window.removeEventListener('resize',place);window.visualViewport?.removeEventListener('resize',place);window.visualViewport?.removeEventListener('scroll',place);};
  },[anchor]);
  useEffect(()=>{content.current?.focus();},[page]);
  function account(message=''){setSuccess(message);setPage('account');}
  if(!position)return null;
  return <Modal title={page==='account'?t('账号'):t('修改密码')} className="account-panel" overlayClassName="account-overlay" position={position} onClose={onClose}>
    <div ref={content} tabIndex={-1} className="settings-page">
      {page==='password'&&<button className="settings-back" onClick={()=>account()}><ArrowLeft size={16}/>{t("返回账号")}</button>}
      {page==='account'&&<div className="settings-account-page">
        <div className="settings-account-identity"><span className="avatar">{identity[0]}</span><div><small>{t("当前账号")}</small><strong>{identity}</strong></div></div>
        {success&&<p className="settings-test-result is-success" role="status"><Check size={15}/><span>{translateMessage(success)}</span></p>}
        <button className="settings-account-row" onClick={()=>{setSuccess('');setPage('password');}}><span className="settings-row-label"><KeyRound size={18} strokeWidth={1.7}/>{t("登录密码")}</span><span>{t("修改密码")}<ChevronRight size={16}/></span></button>
        <UsageSummary/>
        <div className="settings-logout"><button disabled={logoutLocked} onClick={async()=>{setLoggingOut(true);setLogoutError('');try{await onLogout();}catch(e){setLogoutError(e.message);}finally{setLoggingOut(false);}}}>{loggingOut?<LoaderCircle size={17} className="spin"/>:<LogOut size={17}/>}{t('退出登录')}</button>{logoutLocked&&!loggingOut&&<p className="settings-help">{deviceLocked?t('请等待录音结束并保存后再退出。'):t('请等待当前回答完成后再退出。')}</p>}{logoutError&&<p className="settings-inline-error" role="alert">{translateMessage(logoutError)}</p>}</div>
      </div>}
      {page==='password'&&<PasswordForm onBack={account}/>}
    </div>
  </Modal>;
}
