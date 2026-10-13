import React from 'react';
import {t} from './i18n.js';
import {sourceUrl} from './deployment.js';
import './deployment.css';

export function DeploymentGuide({trial=true}){
  return <p className="deployment-guide">
    {trial&&<span>{t('本站仅供体验。')}</span>}
    <a href={sourceUrl} target="_blank" rel="noreferrer">{t('在自己的电脑使用')}</a>
  </p>;
}
