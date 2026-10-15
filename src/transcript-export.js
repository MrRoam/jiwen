import {getLocale,t} from './i18n.js';

export function transcriptExport(lesson,language=getLocale()){
  const segments=(lesson.segments||[]).filter(row=>row.text?.trim()).slice().sort((a,b)=>a.start_ms-b.start_ms);
  if(!segments.length)return null;
  const title=lesson.title?.trim()||t('课堂转写',{},language);
  const filename=(title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/,'').slice(0,100)||'jiwen')+'.txt';
  const lines=segments.map(row=>{
    const seconds=Math.floor(Math.max(0,Number(row.start_ms)||0)/1000);
    const timestamp=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
    return `[${timestamp}] ${row.text.trim()}${row.final?'':` (${t('识别中',{},language)})`}`;
  });
  // BOM 让 Windows 文本编辑器也能正确识别中文；原文不做翻译。
  return {filename,text:'\uFEFF'+[title,'',...lines,''].join('\r\n')};
}

export function downloadTranscript(lesson){
  const result=transcriptExport(lesson);
  if(!result)return;
  const url=URL.createObjectURL(new Blob([result.text],{type:'text/plain;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=result.filename;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
