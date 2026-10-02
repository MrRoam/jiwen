import {t} from './i18n.js';
import React,{useLayoutEffect,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowRight,ChevronLeft,X} from 'lucide-react';
import {guidePosition} from './onboarding.js';
import './onboarding.css';

const steps=[
  {target:'record',title:'从这里录下课堂',description:'即问帮你录下讲解、转成文字，再结合课堂内容回答问题。点击“开始录音”并允许麦克风，就能开始。'},
  {target:'transcript',title:'老师的讲解会出现在这里',description:'选中没听懂的一段，点击“就此提问”。暂停录音并保存后，点击转写旁的时间，还能回放对应讲解。'},
  {target:'question',title:'在这里问没听懂的地方',description:'直接输入问题，AI 会结合附近的课堂转写回答。比如：“这个结论为什么成立？”同一个对话里可以继续追问。'},
  {target:'new-question',title:'换个话题，点“新问题”',description:'要问新讲的内容，就从这里开始独立对话。追问会沿用原来的课堂片段。录音、转写和对话都能在“我的课堂”里找回来。'}
];

export function Onboarding({onClose}){
  const [step,setStep]=useState(0),[layout,setLayout]=useState(null);
  const bubble=useRef(null),onCloseRef=useRef(onClose),previousFocus=useRef(document.activeElement);
  onCloseRef.current=onClose;
  const current=steps[step];
  useLayoutEffect(()=>{
    const target=document.querySelector(`[data-guide="${current.target}"]`);
    if(!target)return;
    let frame;
    const measure=()=>{
      const viewport=window.visualViewport;
      const bounds={width:viewport?.width??window.innerWidth,height:viewport?.height??window.innerHeight,left:viewport?.offsetLeft??0,top:viewport?.offsetTop??0};
      const rect=target.getBoundingClientRect(),height=bubble.current?.getBoundingClientRect().height??236;
      setLayout({target:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},...guidePosition(rect,bounds,{width:332,height})});
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    target.scrollIntoView({block:'nearest',inline:'nearest'});measure();
    const observer=new ResizeObserver(schedule);observer.observe(target);if(bubble.current)observer.observe(bubble.current);
    window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);
    window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
    return()=>{cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);};
  },[step,!!layout]);
  useEffect(()=>{
    const escape=e=>{if(e.key==='Escape'){e.preventDefault();onCloseRef.current();}};
    document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('keydown',escape);if(previousFocus.current?.isConnected)previousFocus.current.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{bubble.current?.focus({preventScroll:true});},[step,!!layout]);
  if(!layout)return null;
  return createPortal(<>
    <div className="guide-target" style={layout.target} aria-hidden="true"/>
    <section className={`guide-bubble guide-${layout.placement}`} style={{left:layout.left,top:layout.top,width:layout.width,maxHeight:layout.maxHeight,'--guide-arrow':`${layout.arrowOffset}px`}} ref={bubble} tabIndex={-1} role="dialog" aria-modal="false" aria-labelledby="guide-title" aria-describedby="guide-description">
      <span className="guide-arrow" aria-hidden="true"/>
      <div className="guide-bubble-content">
        <div className="guide-heading"><h3 id="guide-title">{t(current.title)}</h3><button className="guide-close" aria-label={t("关闭导引")} onClick={onClose}><X size={17}/></button></div>
        <p id="guide-description" aria-live="polite" aria-atomic="true">{t(current.description)}</p>
        <div className="guide-footer"><div className="guide-navigation"><span className="guide-progress" aria-label={t('第 {step} 步，共 {total} 步',{step:step+1,total:steps.length})}>{step+1}<span>/</span>{steps.length}</span><button className="guide-secondary" onClick={step===0?onClose:()=>setStep(s=>s-1)}>{step===0?t('跳过'):<><ChevronLeft size={14}/>{t("上一步")}</>}</button></div><button className="guide-next" onClick={step===steps.length-1?onClose:()=>setStep(s=>s+1)}>{step===steps.length-1?t('知道了'):t('下一步')}<ArrowRight size={15}/></button></div>
      </div>
    </section>
  </>,document.body);
}
