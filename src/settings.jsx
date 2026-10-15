import {t,translateMessage} from './i18n.js';
import {LanguageSelect} from './locale.jsx';
import React,{useState,useEffect,useLayoutEffect,useRef,useId} from 'react';
import {createPortal} from 'react-dom';
import {Mic,MessageCircle,ScanLine,ChevronRight,KeyRound,LogOut,LoaderCircle,RotateCcw,Check,ArrowLeft,Settings,Download,CircleHelp} from 'lucide-react';
import {api} from './api';
import {usagePercentage,usageRemainingText,usageResetText,audioRemainingText} from './usage.js';
import {DeploymentGuide} from './deployment.jsx';
import {PaymentInterest} from './payment-interest.jsx';
import './settings.css';
import {LegalDocument,LegalLinks,LegalStatus,useLegal} from './legal.jsx';
import {SettingsPanel} from './settings-panel.jsx';

const services=[{id:'asr',name:'实时转写',Icon:Mic},{id:'llm',name:'AI 问答',Icon:MessageCircle},{id:'jev',name:'重点与提问识别',Icon:ScanLine}];

function UsageHelp({label,children}){
  const id=useId(),trigger=useRef(null),timer=useRef(null);
  const [open,setOpen]=useState(false),[position,setPosition]=useState(null);
  function show(){clearTimeout(timer.current);setOpen(true);}
  function hide(){clearTimeout(timer.current);timer.current=setTimeout(()=>setOpen(false),120);}
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useEffect(()=>{
    if(!open)return;
    function dismiss(event){if(event.key==='Escape'){event.stopPropagation();clearTimeout(timer.current);setOpen(false);}}
    document.addEventListener('keydown',dismiss,true);
    return()=>document.removeEventListener('keydown',dismiss,true);
  },[open]);
  useLayoutEffect(()=>{
    if(!open)return;
    function place(){const r=trigger.current.getBoundingClientRect();const width=Math.min(260,window.innerWidth-24);setPosition({left:Math.max(12,Math.min(r.left,window.innerWidth-width-12)),width,...(r.bottom+100<window.innerHeight?{top:r.bottom+6}:{bottom:window.innerHeight-r.top+6})});}
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  return <span className="usage-help">
    <button ref={trigger} type="button" className="usage-help-trigger" aria-label={t('{name}额度说明',{name:t(label)})} aria-describedby={open?id:undefined} aria-expanded={open} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onClick={()=>{clearTimeout(timer.current);setOpen(true);}} onKeyDown={event=>{if(event.key==='Escape'&&open){event.stopPropagation();clearTimeout(timer.current);setOpen(false);}}}><CircleHelp size={14} aria-hidden="true"/></button>
    {open&&position&&createPortal(<span id={id} role="tooltip" className="usage-help-tooltip" style={position} onMouseEnter={show} onMouseLeave={hide}>{children}</span>,document.body)}
  </span>;
}

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

export function UsageSummary(){
  const [result,setResult]=useState({status:'loading',usage:null}),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let mounted=true;const controller=new AbortController();
    setResult({status:'loading',usage:null});
    api('/usage',{signal:controller.signal}).then(usage=>{if(mounted)setResult({status:'ready',usage});}).catch(()=>{if(mounted)setResult({status:'error',usage:null});});
    return()=>{mounted=false;controller.abort();};
  },[attempt]);
  const rows=[
    {id:'llm',name:'AI 问答',period:'每日额度',percent:usagePercentage(result.usage?.llm?.remaining,result.usage?.llm?.limit),reset:usageResetText(result.usage?.llm?.resetsAt)},
    {id:'asr',name:'实时转写',period:result.usage?.asr?.period==='lifetime'?'转写体验额度':'每月额度',percent:usagePercentage(result.usage?.asr?.remainingSeconds,result.usage?.asr?.limitSeconds),reset:result.usage?.asr?.trialCapacityReached?t('请自行部署即问。'):result.usage?.asr?.period==='lifetime'?t('一次性额度，不会重置'):usageResetText(result.usage?.asr?.resetsAt)},
  ];
  const loading=result.status==='loading',unavailable=!loading&&rows.some(row=>row.percent===null||!row.reset);
  return <section className="settings-usage" aria-label={t('使用额度')} aria-busy={loading}>
    <div aria-live="polite">{rows.map(({id,name,period,percent,reset})=>{
      const asr=result.usage?.asr;
      const text=loading?t('读取中…'):id==='asr'&&asr?.period==='lifetime'&&asr.remainingSeconds>=60&&!asr.trialCapacityReached?t('剩余 {count} 分钟',{count:Math.floor(asr.remainingSeconds/60)}):id==='asr'&&asr?.period==='lifetime'?audioRemainingText(asr):usageRemainingText(percent);
      return <div key={id} className={`settings-usage-row${percent===0?' is-exhausted':''}`}>
        <div className="settings-usage-heading"><span className="settings-usage-label"><span id={`account-usage-${id}`}>{t(name)}</span>{!loading&&percent!==null&&<UsageHelp label={name}>{t(period)}{id==='asr'&&Number.isFinite(asr?.limitSeconds)&&<> · {t('共 {count} 分钟',{count:Math.floor(asr.limitSeconds/60)})}</>}<br/>{reset||t('重置时间暂不可用')}</UsageHelp>}</span><strong>{text}</strong></div>
        {!loading&&percent!==null&&!(id==='asr'&&asr?.trialCapacityReached)&&<progress className="settings-usage-progress" max={100} value={percent} aria-labelledby={`account-usage-${id}`} aria-valuetext={text}/>}
      </div>;
    })}</div>
    {unavailable&&<button type="button" className="settings-usage-retry" onClick={()=>setAttempt(value=>value+1)}><RotateCcw size={14} aria-hidden="true"/>{t('重试')}</button>}
    {result.usage?.asr?.period==='lifetime'&&<DeploymentGuide/>}
  </section>;
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

function storageSize(bytes){
  if(!Number.isFinite(bytes)||bytes<0)return t('暂不可用');
  if(bytes>=1024**3)return `${(bytes/1024**3).toFixed(1)} GiB`;
  return `${(bytes/1024**2).toFixed(1)} MiB`;
}

function AccountData({me,legal:initial,locked,onAccountDeleted}){
  const result=useLegal(initial);
  const [storage,setStorage]=useState(null),[storageError,setStorageError]=useState(''),[attempt,setAttempt]=useState(0);
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[exporting,setExporting]=useState(false),[readingAudio,setReadingAudio]=useState(false),[recordings,setRecordings]=useState(null),[deleting,setDeleting]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[kind,setKind]=useState(null);
  const usedBytes=storage?.usedBytes??storage?.bytes;
  useEffect(()=>{
    let active=true;const controller=new AbortController();setStorageError('');
    api('/usage',{signal:controller.signal}).then(usage=>{if(active)setStorage(usage.storage);}).catch(error=>{if(active)setStorageError(error.message);});
    return()=>{active=false;controller.abort();};
  },[attempt]);
  async function exportData(){
    if(exporting)return;setExporting(true);setError('');setMessage('');
    try{
      const data=await api('/account/export');
      setRecordings(data.recordings||[]);
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download=`jiwen-account-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      setMessage('数据副本已生成。录音文件请通过副本中的下载地址或课堂下载入口另行保存。');
    }catch(error){setError(error.message);}finally{setExporting(false);}
  }
  async function listRecordings(){
    if(readingAudio)return;setReadingAudio(true);setError('');
    try{const data=await api('/account/export');setRecordings(data.recordings||[]);}
    catch(error){setError(error.message);}finally{setReadingAudio(false);}
  }
  async function deleteAccount(event){
    event.preventDefault();if(locked||deleting)return;setDeleting(true);setError('');setMessage('');
    try{await api('/account',{method:'DELETE',body:{password,confirmation}});await onAccountDeleted();}
    catch(error){setError(error.message);}finally{setDeleting(false);}
  }
  if(kind)return <><button className="settings-back" type="button" onClick={()=>setKind(null)}><ArrowLeft size={16}/>{t('返回账号管理')}</button><LegalStatus {...result}/><LegalDocument legal={result.legal} kind={kind} showTitle/></>;
  return <div className="account-data">
    <div className="account-data-storage">
      <div className="settings-usage-heading"><span>{t('存储空间')}</span><strong>{storage?`${storageSize(usedBytes)} / ${storageSize(storage.limitBytes)}`:storageError?t('暂不可用'):t('读取中…')}</strong></div>
      {storage&&Number.isFinite(usedBytes)&&storage.limitBytes>0&&<progress className="settings-usage-progress" value={Math.min(usedBytes,storage.limitBytes)} max={storage.limitBytes} aria-label={t('存储空间')}/>}
      <p className="settings-help">{t('课堂保存 {days} 天，请在到期前导出。删除课堂可以释放空间。',{days:storage?.retentionDays??result.legal?.limits?.retentionDays??30})}</p>
      {storageError&&<><p className="settings-inline-error" role="alert">{translateMessage(storageError)}</p><button className="settings-action" type="button" onClick={()=>setAttempt(value=>value+1)}>{t('重试')}</button></>}
    </div>
    <LegalLinks contact={result.legal?.contact} onNavigate={setKind}/>
    <p>{t('如需修改个人信息、处理录音许可或反馈问题，请联系运营者。邮件请说明账号邮箱和课堂名称，不要附密码或无关个人信息。')}</p>
    <div className="legal-actions"><button className="settings-action" type="button" disabled={exporting||deleting} onClick={exportData}>{exporting?<LoaderCircle size={15} className="spin"/>:<Download size={15}/>} {t('下载数据副本')}</button><button className="settings-action" type="button" disabled={readingAudio||deleting} onClick={listRecordings}>{readingAudio?<LoaderCircle size={15} className="spin"/>:<Download size={15}/>} {t('下载录音')}</button></div>
    {recordings&&<div className="account-audio-downloads">{recordings.filter(recording=>recording.audioUrl).map((recording,index)=><a key={recording.id||index} href={recording.audioUrl} download>{recording.lessonTitle||recording.title||t('录音 {count}',{count:index+1})}<Download size={14} aria-hidden="true"/></a>)}{!recordings.some(recording=>recording.audioUrl)&&<p className="settings-help">{t('暂无已保存的录音。')}</p>}</div>}
    {message&&<p className="settings-test-result is-success" role="status">{translateMessage(message)}</p>}
    {error&&<p className="settings-inline-error" role="alert">{translateMessage(error)}</p>}
    <details className="account-delete"><summary>{t('注销账号')}</summary>
      <p className="settings-help">{t('注销将删除账号、课堂、录音、转写、对话与个人用量记录。此操作无法撤销，请先保存所需资料。')}</p>
      {me.isAdmin?<p className="settings-help">{t('实例管理员账号不能在此注销，请联系运营者处理。')}</p>:<form onSubmit={deleteAccount}>
        <label>{t('当前密码')}<input className="form-input" type="password" autoComplete="current-password" maxLength={128} required value={password} disabled={locked||deleting} onChange={event=>setPassword(event.target.value)}/></label>
        <label>{t('输入“删除账号”确认')}<input className="form-input" required value={confirmation} disabled={locked||deleting} autoComplete="off" onChange={event=>setConfirmation(event.target.value)}/></label>
        <button type="submit" disabled={locked||deleting||!password||confirmation!=='删除账号'||!onAccountDeleted}>{deleting&&<LoaderCircle size={15} className="spin"/>}{deleting?t('正在注销…'):t('删除账号及全部数据')}</button>
        {locked&&<p className="settings-help">{t('请等待录音保存和当前回答完成后再注销。')}</p>}
      </form>}
    </details>
  </div>;
}

export function SettingsContent({jevEnabled=false,deviceId,setDeviceId,devices,setDevices,recording,saving,starting,inputDevice,onApiConfig}){
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
  return <div className="settings-page">
        {onApiConfig&&<section className="settings-section"><button className="settings-account-row" onClick={onApiConfig}><span className="settings-row-label"><KeyRound size={18}/>{t('API 配置')}</span><ChevronRight size={16}/></button></section>}
        <section className="settings-section" aria-labelledby="settings-display"><div className="settings-section-heading"><h3 id="settings-display">{t('显示')}</h3></div><LanguageSelect/></section>
        <section className="settings-section" aria-labelledby="settings-audio">
          <div className="settings-section-heading"><h3 id="settings-audio">{t("录音设备")}</h3></div>
          <label className="settings-device-label" htmlFor="settings-microphone">{t("麦克风")}</label>
          <div className="settings-device-controls"><select id="settings-microphone" className="form-input settings-device-select" disabled={deviceLocked||reading} value={deviceId} onFocus={()=>{if(!devices.length)refreshDevices();}} onChange={e=>setDeviceId(e.target.value)}><option value="">{t("系统默认麦克风")}</option>{devices.filter(d=>d.deviceId!=='default').map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||t('麦克风 {count}',{count:i+1})}</option>)}</select><button className="settings-refresh" disabled={deviceLocked||reading} onClick={refreshDevices}>{reading?<LoaderCircle size={15} className="spin"/>:<RotateCcw size={15}/>}{reading?t('读取中'):t('刷新设备')}</button></div>
          {deviceLocked&&<p className="settings-help">{starting?t('正在启动录音，请稍候。'):saving?t('录音保存后可切换设备。'):t('录音结束后可切换设备。')}{recording&&inputDevice&&<>{t("当前音源：")}{inputDevice}</>}</p>}
          {deviceError&&<p className="settings-inline-error" role="alert">{translateMessage(deviceError)}</p>}
        </section>
        <section className="settings-section" aria-labelledby="settings-services"><div className="settings-section-heading"><h3 id="settings-services">{t("课堂功能")}</h3></div>{services.filter(service=>service.id!=='jev'||jevEnabled===true).map(service=><ServiceRow key={service.id} {...service}/>)}</section>
    </div>;
}

export function SettingsDialog({Modal,onClose,...props}){
  return <SettingsPanel Modal={Modal} title={t('设置')} onClose={onClose}><SettingsContent {...props}/></SettingsPanel>;
}

export function AccountDialog({Modal,me,legal,anchor,recording,saving,starting,busy,onClose,settingsProps,onApiConfig,onLogout,onAccountDeleted}){
  const [page,setPage]=useState('account'),[logoutError,setLogoutError]=useState(''),[loggingOut,setLoggingOut]=useState(false),[success,setSuccess]=useState('');
  const content=useRef(null);
  const deviceLocked=recording||saving||starting,logoutLocked=deviceLocked||busy||loggingOut;
  const identity=me.email;
  useEffect(()=>{content.current?.focus();},[page]);
  function account(message=''){setSuccess(message);setPage('account');}
  return <SettingsPanel Modal={Modal} title={t('账号')} anchor={anchor} onClose={onClose}>
    <div ref={content} tabIndex={-1} className="settings-page">
      <div className="settings-account-page">
        <div className="settings-account-identity"><span className="avatar">{identity[0]}</span><div><strong>{identity}</strong></div><button type="button" className="account-password-icon" aria-label={t('修改密码')} title={t('修改密码')} aria-expanded={page==='password'} aria-controls="account-password-form" onClick={()=>{setSuccess('');setPage(page==='password'?'account':'password');}}><KeyRound size={17}/></button></div>
        {success&&<p className="settings-test-result is-success" role="status"><Check size={15}/><span>{translateMessage(success)}</span></p>}
        {page==='password'&&<section id="account-password-form" aria-label={t('修改密码')}><PasswordForm onBack={account}/></section>}
        <UsageSummary/>
        <PaymentInterest contact={legal?.contact}/>
        <div className="account-menu-actions">
          <details className="account-settings-disclosure"><summary><span className="settings-row-label"><Settings size={18} strokeWidth={1.7}/>{t('设置')}</span><ChevronRight size={16}/></summary><SettingsContent {...settingsProps}/><details className="account-management"><summary>{t('账号管理')}</summary><AccountData me={me} legal={legal} locked={logoutLocked} onAccountDeleted={onAccountDeleted}/></details></details>
          {onApiConfig&&<button className="settings-account-row" onClick={onApiConfig}><span className="settings-row-label"><KeyRound size={18} strokeWidth={1.7}/>{t("API 配置")}</span><ChevronRight size={16}/></button>}
        </div>
        <div className="settings-logout"><button disabled={logoutLocked} onClick={async()=>{setLoggingOut(true);setLogoutError('');try{await onLogout();}catch(e){setLogoutError(e.message);}finally{setLoggingOut(false);}}}>{loggingOut?<LoaderCircle size={17} className="spin"/>:<LogOut size={17}/>}{t('退出登录')}</button>{logoutLocked&&!loggingOut&&<p className="settings-help">{deviceLocked?t('请等待录音结束并保存后再退出。'):t('请等待当前回答完成后再退出。')}</p>}{logoutError&&<p className="settings-inline-error" role="alert">{translateMessage(logoutError)}</p>}</div>
      </div>
    </div>
  </SettingsPanel>;
}
