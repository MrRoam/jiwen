import React,{useSyncExternalStore} from 'react';
import {Languages} from 'lucide-react';
import {getLocale,subscribeLocale,setLocale,t} from './i18n.js';
import './locale.css';

export function useLocale(){return useSyncExternalStore(subscribeLocale,getLocale,getLocale);}
export function LanguageSelect({id='interface-language',compact=false}){
  const locale=useLocale();
  return <label className={`language-select ${compact?'is-compact':''}`} htmlFor={id}>
    <Languages size={17} aria-hidden="true"/>
    {!compact&&<span>{t('语言')}</span>}
    <select id={id} aria-label={t('界面语言')} value={locale} onChange={event=>setLocale(event.target.value)}>
      <option value="zh-CN" lang="zh-CN">简体中文</option>
      <option value="en" lang="en">English</option>
    </select>
  </label>;
}
