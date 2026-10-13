import React,{useEffect,useState} from 'react';
import {Check,LoaderCircle,Mic,MessageCircle} from 'lucide-react';
import {api} from './api';
import {t,translateMessage} from './i18n.js';
import './settings.css';

function ServiceForm({service,initial,onSaved,locked}){
  const asr=service==='asr',Icon=asr?Mic:MessageCircle;
  const names=asr?['ASR_PROVIDER','ASR_WS_URL','ASR_MODEL','LOCAL_ASR_URL','LOCAL_ASR_MODEL']:['LLM_BASE_URL','LLM_MODEL','LLM_USE_ASR_KEY','LLM_ROUTING'];
  const key=asr?'DASHSCOPE_API_KEY':'LLM_API_KEY';
  const [fields,setFields]=useState(()=>Object.fromEntries([...names.map(name=>[name,initial[name]]),[key,''],...(!asr?[['OPENROUTER_API_KEY','']]:[])]));
  const [saved,setSaved]=useState(initial),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(''),[result,setResult]=useState(null);
  useEffect(()=>setSaved(initial),[initial]);
  const disabled=locked||!!busy;
  function change(name,value){setFields(old=>({...old,[name]:value}));setDirty(true);setResult(null);}
  async function save(event){
    event.preventDefault();setBusy('save');setResult(null);
    try{
      const next=await api('/services/config',{method:'PUT',body:fields});
      setSaved(next.settings);setFields(old=>({...old,[key]:'',...(!asr?{OPENROUTER_API_KEY:''}:{})}));setDirty(false);
      setResult({ok:true,message:'配置已保存并立即生效，请测试连接。'});onSaved(next);
    }catch(error){setResult({ok:false,message:error.message});}
    finally{setBusy('');}
  }
  async function test(){
    setBusy('test');setResult(null);
    try{setResult(await api('/services/test',{method:'POST',body:{service}}));}
    catch(error){setResult({ok:false,message:error.message});}
    finally{setBusy('');}
  }
  async function clear(){
    if(!window.confirm(t('清除这个服务保存的密钥？不会删除课堂或录音。')))return;
    setBusy('clear');setResult(null);
    try{
      const next=await api(`/services/config/${service}`,{method:'DELETE'});setSaved(next.settings);
      setFields(Object.fromEntries([...names.map(name=>[name,next.settings[name]]),[key,''],...(!asr?[['OPENROUTER_API_KEY','']]:[])]));
      setDirty(false);setResult({ok:true,message:'密钥已清除。'});onSaved(next);
    }catch(error){setResult({ok:false,message:error.message});}
    finally{setBusy('');}
  }
  const local=asr&&fields.ASR_PROVIDER==='local';
  const configured=asr?saved.ASR_READY:saved.LLM_READY;
  function input(name,label,{secret=false,placeholder='',type='text'}={}){
    return <label className="api-field" htmlFor={`api-${name}`}>{t(label)}<input id={`api-${name}`} className="form-input" type={secret?'password':type} autoComplete={secret?'new-password':'off'} spellCheck={false} maxLength={secret?4096:500} required={!secret} value={fields[name]} placeholder={secret&&saved[`${name}_CONFIGURED`]?t('已保存，留空保留原密钥'):placeholder} onChange={event=>change(name,event.target.value)}/></label>;
  }
  return <section className="settings-section api-section">
    <div className="api-service-heading"><h3><Icon size={18}/>{asr?t('转写服务'):t('问答服务')}</h3><span className="api-config-status">{dirty?t('尚未保存'):configured?t('已配置，连接需测试'):t('未配置')}</span></div>
    <p className="settings-help">{asr?t('建议使用阿里云百炼；自填接口需兼容百炼实时转写 WebSocket 协议。'):t('建议使用 Qwen；也可自行填写支持 OpenAI Chat Completions 和 SSE 流式输出的接口。')}</p>
    <form onSubmit={save}>
      <fieldset disabled={disabled}>
        {asr&&<label className="api-field" htmlFor="api-ASR_PROVIDER">{t('转写方式')}<select id="api-ASR_PROVIDER" className="form-input" value={fields.ASR_PROVIDER} onChange={event=>change('ASR_PROVIDER',event.target.value)}><option value="remote">{t('云端实时转写')}</option><option value="local">{t('本机 faster-whisper')}</option></select></label>}
        {local?<>{input('LOCAL_ASR_URL','本地服务地址',{type:'url'})}{input('LOCAL_ASR_MODEL','本地模型名称')}<p className="settings-help">{t('请先单独启动本地转写服务；模型设置需与 Python 服务一致。')}</p></>:<>
          {input(key,'API Key',{secret:true,placeholder:t('填写你自己的 API Key')})}
          {input(asr?'ASR_WS_URL':'LLM_BASE_URL',asr?'WebSocket 地址':'接口基础地址',{type:'url'})}
          {input(asr?'ASR_MODEL':'LLM_MODEL','模型名称')}
        </>}
        {!asr&&<>
          <label className="api-checkbox"><input type="checkbox" checked={fields.LLM_USE_ASR_KEY==='true'} onChange={event=>change('LLM_USE_ASR_KEY',String(event.target.checked))}/><span>{t('未填写独立密钥时复用百炼转写密钥（仅百炼官方地址）')}</span></label>
          <details className="api-advanced"><summary>{t('OpenRouter 路由（可选）')}</summary>
            <label className="api-field" htmlFor="api-LLM_ROUTING">{t('问答路由')}<select id="api-LLM_ROUTING" className="form-input" value={fields.LLM_ROUTING} onChange={event=>change('LLM_ROUTING',event.target.value)}><option value="qwen-only">{t('直接使用上方接口')}</option><option value="openrouter-first">{t('优先 OpenRouter 免费模型')}</option></select></label>
            {input('OPENROUTER_API_KEY','OpenRouter API Key',{secret:true})}
            <p className="settings-help">{t('OpenRouter 达到限制时可切换到上方问答接口，备用服务可能收费。HELP 优先使用上方接口。')}</p>
          </details>
        </>}
        <div className="api-actions"><button className="primary" type="submit">{busy==='save'&&<LoaderCircle size={15} className="spin"/>}{t('保存配置')}</button><button className="settings-action" type="button" disabled={dirty||disabled} onClick={test}>{busy==='test'&&<LoaderCircle size={15} className="spin"/>}{t('测试连接')}</button><button className="text-button api-clear" type="button" onClick={clear}>{t('清除密钥')}</button></div>
        {dirty&&<p className="settings-help">{t('请先保存，再测试当前配置。')}</p>}
      </fieldset>
    </form>
    {result&&<p role={result.ok?'status':'alert'} className={`settings-test-result ${result.ok?'is-success':'is-error'}`}>{result.ok&&<Check size={15}/>}<span>{translateMessage(result.message)}</span></p>}
  </section>;
}

export function ApiConfigDialog({Modal,me,locked,onSaved,onClose}){
  const [settings,setSettings]=useState(null),[error,setError]=useState('');
  useEffect(()=>{if(!me.isAdmin)return;let active=true;api('/services/config').then(value=>{if(active)setSettings(value);}).catch(error=>{if(active)setError(error.message);});return()=>{active=false;};},[me.isAdmin]);
  return <Modal title={t(me.personal?'转写与问答':'API 配置')} className="settings-modal api-modal" onClose={onClose}>
    <div className="settings-page">
      {!me.isAdmin?<p className="settings-help">{t('转写和问答由实例管理员配置，请联系管理员。')}</p>:<>
        <p className="settings-help">{t(me.personal?'密钥保存在这台电脑上。保存后分别测试转写和问答。':'密钥仅保存在本实例服务器，不会回显或提交到仓库。保存立即生效，测试成功才表示接口可用。')}</p>
        {locked&&<p className="settings-inline-error" role="status">{t('请结束录音、保存和回答后再修改配置。')}</p>}
        {error&&<p className="settings-inline-error" role="alert">{translateMessage(error)}</p>}
        {!settings&&!error&&<p role="status" className="settings-help">{t('读取中…')}</p>}
        {settings&&['asr','llm'].map(service=><ServiceForm key={service} service={service} initial={settings} locked={locked} onSaved={next=>{setSettings(next.settings);onSaved(next.config);}}/>)}
      </>}
    </div>
  </Modal>;
}
