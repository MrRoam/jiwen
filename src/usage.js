import {formatDate,getLocale,t} from './i18n.js';

export function usagePercentage(remaining,limit){
  if(!Number.isFinite(remaining)||!Number.isFinite(limit)||limit<0)return null;
  if(limit===0)return 0;
  return Math.max(0,Math.min(100,remaining/limit*100));
}

export function usageRemainingText(percent,language=getLocale()){
  if(percent===null||!Number.isFinite(percent))return t('暂时无法读取',{},language);
  if(percent<=0)return t('已用完 · 0%',{},language);
  if(percent<1)return t('剩余不足 1%',{},language);
  // 只有完全未使用时才显示 100%；还有余额时不会因取整显示 0%。
  return t('剩余 {percent}%',{percent:percent>=100?100:Math.min(99,Math.floor(percent))},language);
}

export function usageResetText(value,language=getLocale()){
  if(value===null||value===undefined||value==='')return null;
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return null;
  const time=formatDate(date,{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'},language);
  return t('北京时间 {time} 重置',{time},language);
}

export function audioRemainingText(asr,language=getLocale()){
  const remaining=asr?.remainingSeconds,limit=asr?.limitSeconds;
  if(!Number.isFinite(remaining)||!Number.isFinite(limit)||remaining<0||limit<=0)return t('暂时无法读取',{},language);
  if(remaining===0)return t('转写体验已用完',{},language);
  if(remaining<60)return t('剩余不足 1 分钟',{},language);
  return t('剩余 {remaining} 分钟 / 共 {total} 分钟',{remaining:Math.floor(remaining/60),total:Math.floor(limit/60)},language);
}
