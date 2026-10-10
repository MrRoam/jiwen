import React,{useState} from 'react';
import {t,getLocale} from './i18n.js';
import {deploymentPrompt,sourceUrl} from './deployment.js';
import './deployment.css';

export function DeploymentGuide(){
  const [copyState,setCopyState]=useState('');
  const prompt=deploymentPrompt(getLocale());
  async function copy(){
    try{await navigator.clipboard.writeText(prompt);setCopyState('copied');}
    catch{setCopyState('manual');}
  }
  return <details className="deployment-guide">
    <summary>{t('自行部署，也可以让 AI 帮忙')}</summary>
    <div className="deployment-guide-content">
      <p>{t('自行部署，就是在自己的电脑或服务器上运行即问。源码免费；云端转写、问答和服务器费用由你承担。')}</p>
      <ol>
        <li>{t('先在自己的电脑运行，无需购买服务器。按教程安装 Git、Node.js 24 或更新版本及 npm，再启动即问。')}</li>
        <li>{t('在本机 .env 配置注册邮件服务（SMTP），用收到的验证码注册。SMTP 和转写、问答 API 分开配置，教程会说明每项怎么填。')}</li>
        <li>{t('注册自己的管理员账号，在“侧栏底部账号 → API 配置”填写自己的密钥。分别测试转写和问答，再录音 30 秒，检查保存、提问和回放。')}</li>
        <li>{t('需要手机或远程访问时，再配置 HTTPS 或服务器。体验站账号与课堂不会自动迁移，新实例需要单独注册。')}</li>
      </ol>
      <p>{t('不会操作时，复制下面的提示给能协助操作电脑的 AI，按步骤完成。密钥只填在自己的实例中。')}</p>
      <div className="deployment-guide-actions">
        <a href={`${sourceUrl}/blob/main/docs/自行部署与AI协助.md`} target="_blank" rel="noreferrer">{t('查看部署教程')}</a>
        <a href={sourceUrl} target="_blank" rel="noreferrer">{t('GitHub 源码')}</a>
        <button type="button" onClick={copy}>{t('复制给 AI 的部署提示')}</button>
      </div>
      {copyState==='copied'&&<p role="status">{t('已复制，可粘贴给 AI。')}</p>}
      {copyState==='manual'&&<label>{t('复制失败，请手动选中并复制下面的提示。')}<textarea readOnly rows={9} value={prompt} onFocus={event=>event.target.select()}/></label>}
    </div>
  </details>;
}
