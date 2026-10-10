import React, {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Eye, EyeOff, LoaderCircle} from 'lucide-react';
import {api} from './api';
import {t, translateMessage} from './i18n.js';
import {LanguageSelect, useLocale} from './locale.jsx';
import './auth.css';
import {LandingDemo} from './landing-demo.jsx';
import {LandingWordmark} from './landing-wordmark.jsx';
import {LegalPage} from './legal.jsx';
import {DeploymentGuide} from './deployment.jsx';

function readAuthPage() {
  const page = window.location.hash.slice(1);
  return ['login', 'register', 'reset', 'privacy', 'terms'].includes(page) ? page : 'home';
}

export function Auth({config, onAuth, notice, setNotice, brand}) {
  const locale = useLocale();
  const [mode, setMode] = useState(readAuthPage);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [noticeKind, setNoticeKind] = useState('error');
  const heading = useRef(null);
  const previousMode = useRef(mode);
  const legalReturn = useRef('home');
  const forgot = mode === 'reset';
  const registering = mode === 'register';
  const needsCode = forgot || registering;
  const legalPage = ['privacy', 'terms'].includes(mode);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  useEffect(() => {
    if (previousMode.current !== mode) heading.current?.focus();
    previousMode.current = mode;
  }, [mode]);

  function switchMode(next) {
    if (next === mode) return;
    if (['privacy', 'terms'].includes(next) && !legalPage) legalReturn.current = mode;
    window.history.pushState(null, '', next === 'home' ? window.location.pathname + window.location.search : '#' + next);
    setMode(next);
    setNotice('');
    setNoticeKind('error');
    setPassword('');
    setConfirm('');
    setCode('');
    setCooldown(0);
    setShowPassword(false);
  }
  useEffect(() => {
    const sync = () => {
      const next = readAuthPage();
      if (['privacy', 'terms'].includes(next) && !['privacy', 'terms'].includes(previousMode.current)) legalReturn.current = previousMode.current;
      setMode(next);
      setNotice('');
      setPassword('');
      setConfirm('');
      setCode('');
      setCooldown(0);
      setShowPassword(false);
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [setNotice]);

  async function sendCode() {
    if (sending || cooldown > 0 || !email.trim()) return;
    const emailInput = document.getElementById('welcome-email');
    if (!emailInput.reportValidity()) return;
    setSending(true);
    try {
      const result = await api(registering ? '/auth/request-registration' : '/auth/request-reset', {method: 'POST', body: {email, locale}});
      setNoticeKind('success');
      setNotice(result.message);
      setCooldown(60);
    } catch (error) {
      setNoticeKind('error');
      setNotice(error.message);
    } finally { setSending(false); }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice('');
    setNoticeKind('error');
    try {
      if (forgot) {
        if (password !== confirm) return setNotice('两次输入的新密码不一致。');
        await api('/auth/reset-password', {method: 'POST', body: {email, code, password}});
        switchMode('login');
        setNoticeKind('success');
        setNotice('密码已重置，请使用新密码登录。');
      } else {
        const user = await api(`/auth/${mode}`, {method: 'POST', body: {email, password, ...(registering ? {code} : {})}});
        await onAuth(user);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch (error) { setNoticeKind('error'); setNotice(error.message); }
    finally { setBusy(false); }
  }

  const home = mode === 'home';
  return <div className={home ? 'landing-page' : 'account-page'}>
    <header className="public-header">
      <button className="public-brand" type="button" aria-label={t('返回首页')} disabled={busy || sending} onClick={() => switchMode('home')}>{brand}</button>
      <div className="public-nav">
        <LanguageSelect id="login-language" compact/>
      </div>
    </header>
    {home ? <main className="landing-main">
      <section className="landing-hero">
        {locale === 'zh-CN' ? <h1 ref={heading} tabIndex={-1} className="landing-wordmark">
          <span className="landing-wordmark-text">{t('课堂内容，即时问')}</span>
          <LandingWordmark/>
        </h1> : <h1 ref={heading} tabIndex={-1}>{t('课堂内容，即时问')}</h1>}
        <p className="landing-tagline" lang="en">Listen · Ask · Understand</p>
        <button type="button" className="landing-cta" onClick={() => switchMode('register')}>{t('开始使用')}<ArrowRight size={19} aria-hidden="true"/></button>
        {config.asrQuotaMode==='trial'&&<p className="landing-trial-note">{t('本站仅供体验。每个新账号一次性赠送 1 小时转写，用完不自动恢复。继续使用可自行部署，也可以让 AI 帮忙。')}</p>}
      </section>
      <LandingDemo/>
      <section className="landing-deployment" aria-label={t('自行部署')}><DeploymentGuide/></section>
    </main> : legalPage ? <LegalPage kind={mode} initial={config.legal} onBack={() => switchMode(legalReturn.current)}/> : <main className="account-main">
      <button type="button" className="account-back" disabled={busy || sending} onClick={() => switchMode('home')}><ArrowLeft size={16} aria-hidden="true"/>{t('返回首页')}</button>
      <section className="account-content" aria-labelledby="welcome-title">
        <div className="welcome-form" id="welcome-form" tabIndex={-1}>
          <h2 ref={heading} id="welcome-title" tabIndex={-1}>{forgot ? t('找回密码') : registering ? t('创建账号') : t('登录即问')}</h2>
          {registering&&config.asrQuotaMode==='trial'&&<p className="welcome-trial-note">{t('本站仅供体验。每个新账号一次性赠送 1 小时转写，用完不自动恢复。继续使用可自行部署，也可以让 AI 帮忙。')}</p>}
          {forgot && <p className="welcome-form-description">{t('输入注册邮箱并填入验证码，设置新密码。')}</p>}
          <form onSubmit={submit} aria-busy={busy}>
            <fieldset disabled={busy}>
              <div className="welcome-field">
                <label htmlFor="welcome-email">{forgot ? t('注册邮箱') : t('邮箱')}</label>
                <div className={needsCode ? 'welcome-code-row' : undefined}>
                  <input id="welcome-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} required value={email} disabled={sending} onChange={event => {setEmail(event.target.value);setCode('');}}/>
                  {needsCode && <button type="button" className="welcome-code-send" disabled={sending || cooldown > 0 || !email.trim()} onClick={sendCode}>{cooldown > 0 ? t('{count} 秒后再试', {count: cooldown}) : sending ? t('发送中…') : t('获取验证码')}</button>}
                </div>
              </div>
              {needsCode && <div className="welcome-field">
                <label htmlFor="welcome-code">{t('邮箱验证码')}</label>
                <input id="welcome-code" name="code" autoComplete="one-time-code" inputMode="numeric" pattern="\d{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} placeholder={t('6 位数字')}/>
              </div>}
              <div className="welcome-field">
                <div className="welcome-label-row">
                  <label htmlFor="welcome-password">{forgot ? t('新密码') : t('密码')}</label>
                  {!forgot && !registering && config.mailReady && <button type="button" className="welcome-link" onClick={() => switchMode('reset')}>{t('忘记密码？')}</button>}
                </div>
                <div className="welcome-password">
                  <input id="welcome-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={forgot || registering ? 'new-password' : 'current-password'} minLength={8} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} placeholder={forgot || registering ? t('至少 8 位') : undefined}/>
                  <button type="button" className="welcome-password-toggle" aria-label={showPassword ? t('隐藏密码') : t('显示密码')} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18} aria-hidden="true"/> : <Eye size={18} aria-hidden="true"/>}</button>
                </div>
              </div>
              {forgot && <div className="welcome-field">
                <label htmlFor="welcome-confirm">{t('确认新密码')}</label>
                <input id="welcome-confirm" name="confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={128} required value={confirm} onChange={event => setConfirm(event.target.value)}/>
              </div>}
              {notice && <p className={`welcome-notice is-${noticeKind}`} role={noticeKind === 'error' ? 'alert' : 'status'}>{translateMessage(notice)}</p>}
              <button className="welcome-submit" type="submit" disabled={busy || sending}>
                <span>{busy ? t('请稍候…') : forgot ? t('重置密码') : registering ? t('创建账号') : t('登录')}</span>
                {busy ? <LoaderCircle className="spin" size={18} aria-hidden="true"/> : <ArrowRight size={18} aria-hidden="true"/>}
              </button>
            </fieldset>
          </form>
          <div className="welcome-switch">
            {forgot ? <button className="welcome-link" disabled={busy || sending} onClick={() => switchMode('login')}>{t('返回登录')}</button> : <><span>{registering ? t('已经有账号？') : t('还没有账号？')}</span><button className="welcome-link" disabled={busy || sending} onClick={() => switchMode(registering ? 'login' : 'register')}>{registering ? t('登录') : t('创建账号')}<ArrowRight size={14} aria-hidden="true"/></button></>}
          </div>
          {registering&&config.asrQuotaMode==='trial'&&<DeploymentGuide/>}
        </div>
      </section>

    </main>}
  </div>;
}
