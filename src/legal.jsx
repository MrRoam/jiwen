import React, {useEffect, useState} from 'react';
import {LoaderCircle, ArrowLeft} from 'lucide-react';
import {api} from './api';
import {t, translateMessage} from './i18n.js';
import './legal.css';

export function useLegal(initial) {
  const [result, setResult] = useState({legal: initial || null, loading: !initial?.privacy, error: ''});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setResult({legal: initial || null, loading: true, error: ''});
    api('/legal', {signal: controller.signal}).then(legal => {
      if (active) setResult({legal, loading: false, error: ''});
    }).catch(error => {
      if (active) setResult({legal: initial || null, loading: false, error: error.message});
    });
    return () => { active = false; controller.abort(); };
  }, [initial, attempt]);
  return {...result, retry: () => setAttempt(value => value + 1)};
}

export function LegalLinks({contact, onNavigate, className = ''}) {
  return <nav className={`legal-links ${className}`} aria-label={t('政策与反馈')}>
    <a href="#privacy" onClick={onNavigate ? event => {event.preventDefault(); onNavigate('privacy');} : undefined}>{t('数据说明')}</a>
    <a href="#terms" onClick={onNavigate ? event => {event.preventDefault(); onNavigate('terms');} : undefined}>{t('使用说明')}</a>
    <a href={`mailto:${contact || 'joshyao0601@gmail.com'}`}>{t('问题反馈')}</a>
  </nav>;
}

export function ProviderList({providers = []}) {
  return <div className="legal-providers" lang="zh-CN">{providers.map((provider, index) => <section key={`${provider.service}-${index}`}>
    <h4>{provider.name}</h4>
    <p>{provider.entity}{provider.region ? ` · ${provider.region}` : ''}</p>
    <p>{Array.isArray(provider.data) ? provider.data.join('、') : provider.data}</p>
    {provider.privacyUrl && <a href={provider.privacyUrl} target="_blank" rel="noreferrer">{t('供应商隐私说明')}</a>}
  </section>)}</div>;
}

export function LegalDocument({kind = 'privacy', legal, showTitle = true}) {
  const document = legal?.[kind];
  if (!document) return null;
  return <article className="legal-document" lang="zh-CN">
    {showTitle && <h1>{document.title}</h1>}
    <p className="legal-meta">{t('版本：{version}', {version: legal.version})} · {t('运营者：{operator}', {operator: legal.operator})}<br/><a href={`mailto:${legal.contact}`}>{legal.contact}</a></p>
    {document.sections.map((section, index) => <section key={index}><h2>{section.title}</h2>{section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</section>)}
    {kind === 'privacy' && legal.providers?.length > 0 && <section><h2>{t('当前服务供应商')}</h2><ProviderList providers={legal.providers}/></section>}
  </article>;
}

export function LegalStatus({loading, error, retry}) {
  return <>{loading && <p className="legal-status" role="status"><LoaderCircle size={16} className="spin"/>{t('读取政策中…')}</p>}
    {error && <div className="legal-status" role="alert"><span>{translateMessage(error)}</span><button type="button" className="settings-action" onClick={retry}>{t('重试')}</button></div>}</>;
}

export function LegalPage({kind, onBack, initial}) {
  const result = useLegal(initial);
  return <main className="legal-public-main">
    <button type="button" className="account-back" onClick={onBack}><ArrowLeft size={16}/>{t('返回')}</button>
    <LegalStatus {...result}/>
    <LegalDocument kind={kind} legal={result.legal}/>
    <LegalLinks contact={result.legal?.contact}/>
  </main>;
}

