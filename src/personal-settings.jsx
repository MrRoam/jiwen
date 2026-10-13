import React,{useState} from 'react';
import {ArrowLeft,ChevronRight,Download,FileText,KeyRound,Settings} from 'lucide-react';
import {api} from './api';
import {t,translateMessage} from './i18n.js';
import './settings.css';

export function PersonalSettings({Modal,onClose,onSettings,onApiConfig}){
  const [data,setData]=useState(false),[recordings,setRecordings]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
  async function download(kind){
    setBusy(kind);setError('');
    try{
      const value=await api('/account/export');
      if(kind==='audio'){setRecordings(value.recordings.filter(row=>row.audioUrl));return;}
      const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='jiwen-data.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){setError(error.message);}finally{setBusy('');}
  }
  return <Modal title={t(data?'我的资料':'设置')} onClose={onClose}><div className="settings-page">
    {data?<>
      <button className="settings-back" onClick={()=>setData(false)}><ArrowLeft size={16}/>{t('返回设置')}</button>
      <p className="settings-help">{t('资料保存在这台电脑上，不会按期限自动删除。可在课堂列表中删除不需要的课堂。')}</p>
      <div className="legal-actions"><button className="settings-action" disabled={!!busy} onClick={()=>download('data')}><Download size={15}/>{t('下载数据副本')}</button><button className="settings-action" disabled={!!busy} onClick={()=>download('audio')}><Download size={15}/>{t('下载录音')}</button></div>
      {recordings&&<div className="account-audio-downloads">{recordings.map(row=><a key={row.id} href={row.audioUrl} download>{row.lessonTitle}<Download size={14}/></a>)}{!recordings.length&&<p>{t('暂无已保存的录音。')}</p>}</div>}
      {error&&<p role="alert" className="settings-inline-error">{translateMessage(error)}</p>}
    </>:<div className="account-menu-actions">
      <button className="settings-account-row" onClick={onApiConfig}><span className="settings-row-label"><KeyRound size={18}/>{t('转写与问答')}</span><ChevronRight size={16}/></button>
      <button className="settings-account-row" onClick={onSettings}><span className="settings-row-label"><Settings size={18}/>{t('录音设备与语言')}</span><ChevronRight size={16}/></button>
      <button className="settings-account-row" onClick={()=>setData(true)}><span className="settings-row-label"><FileText size={18}/>{t('我的资料')}</span><ChevronRight size={16}/></button>
      <p className="settings-help">{t('使用云端转写或问答时，相应音频或文字会发送到你配置的服务。')}</p>
    </div>}
  </div></Modal>;
}
