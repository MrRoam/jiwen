import React, {useEffect, useRef, useState} from 'react';
import {ArrowUp, AudioLines, BookOpen, Link2, Mic, MousePointer2, Pause, Play, RotateCcw} from 'lucide-react';
import {t} from './i18n.js';

const DURATION = 16000;
const context = '20人选了物理，其中5人也选了化学。';
const transcript = '在选物理的同学中，选化学的比例是 5 ÷ 20 = 25%。';
const question = '为什么不是除以100？';
const answer = '因为刚才问的是“选物理的同学中”。范围已经缩到这20人，其中5人也选了化学，所以是5÷20。除以100，算的就是占全班的比例了。';

// 合成课堂演示不调用麦克风或问答接口。时间轴仅驱动展示。
export function LandingDemo() {
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  const frame = useRef(null);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {setReduced(preference.matches); if (preference.matches) setElapsed(14000);};
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), {threshold: .1});
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (paused || reduced || !visible) return;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const delta = now - previous;
      previous = now;
      if (!document.hidden) setElapsed(value => (value + Math.min(delta, 250)) % DURATION);
    }, 80);
    return () => clearInterval(timer);
  }, [paused, reduced, visible]);

  const progress = elapsed;
  const step = progress < 5000 ? 0 : progress < 8500 ? 1 : 2;
  const recording = progress >= 800;
  const showAnswer = progress >= 8700;
  const contextLinked = progress >= 5200;
  const type = (text, start, duration) => text.slice(0, Math.max(0, Math.min(text.length, Math.ceil((progress - start) / duration * text.length))));
  const typedTranscript = type(t(transcript), 1300, 2500);
  const typedQuestion = type(t(question), 5200, 2000);
  const typedAnswer = type(t(answer), 8700, 3200);
  const captions = [t('录下课堂'), t('自动带入上下文'), t('结合课堂回答')];

  function jump(index) {
    setElapsed((reduced ? [4900, 8400, 14000] : [900, 5300, 8800])[index]);
    setPaused(false);
  }

  return <section className={`landing-demo ${paused || reduced ? 'is-paused' : ''}`} ref={frame} aria-label={t('即问操作演示')}>
    <div className="demo-window" aria-hidden="true">
      <header className="demo-topbar">
        <span className="demo-course"><BookOpen size={17}/>{t('概率统计')}</span>
        <span className="demo-badge">{t('演示')}</span>
        <span className={`demo-record ${recording ? 'is-recording' : ''}`}><Mic size={14}/>{recording ? t('正在录音') : t('开始录音')}<span className="demo-record-time">{recording ? `12:${String(8 + Math.floor(progress / 1000)).padStart(2, '0')}` : '12:08'}</span></span>
      </header>
      <div className="demo-workspace">
        <div className="demo-transcript-panel">
          <div className="demo-panel-heading"><AudioLines size={15}/>{t('实时转写')}<span className="demo-wave">{Array.from({length: 9}, (_, i) => <i key={i} style={{'--bar': i}}/>)}</span></div>
          <div className="demo-transcript-line"><time>11:42</time><p>{t('全班一共100人。')}</p></div>
          <div className={`demo-transcript-line ${contextLinked ? 'is-context-linked' : ''}`}><time>11:56</time><p>{t(context)}</p></div>
          <div className={`demo-transcript-line demo-current-line ${contextLinked ? 'is-context-linked' : ''}`}><time>12:08</time><p>{typedTranscript}<span className={`demo-type-caret ${progress > 3900 ? 'is-done' : ''}`}/></p></div>
          <div className="demo-audio-track"><AudioLines size={15}/><span className="demo-track-line"/><span>12:08</span></div>
        </div>
        <div className="demo-chat-panel">
          <div className="demo-panel-heading"><span className="demo-ai-mark">{t('问')}</span>{t('AI 问答')}</div>
          {contextLinked && <div className="demo-auto-context"><span><Link2 size={12}/>{t('自动带入课堂')}<time>11:56 — 12:08</time></span><p>{t(context)}</p></div>}
          <div className="demo-chat-body">
            {progress < 8400 && <div className="demo-empty"><span className="demo-empty-symbol"><AudioLines size={26}/></span><span>{t('没听懂的地方，随时问。')}</span></div>}
            {progress >= 8400 && <p className="demo-user-message">{t(question)}</p>}
            {showAnswer && <div className="demo-answer"><span className="demo-answer-name">{t('即问')}</span><p>{typedAnswer}<span className={`demo-type-caret ${progress > 12000 ? 'is-done' : ''}`}/></p></div>}
          </div>
          <div className={`demo-composer ${step === 1 ? 'is-active' : ''}`}><span>{progress >= 8400 ? t('继续追问…') : typedQuestion || t('输入你的问题…')}</span><span className={`demo-send ${progress >= 7800 && progress < 8400 ? 'is-pressed' : ''}`}><ArrowUp size={17}/></span></div>
        </div>
      </div>
      {!reduced && <MousePointer2 className={`demo-pointer pointer-step-${step} ${progress > 13000 ? 'is-hidden' : ''}`} size={23} fill="#203d30" stroke="#fff" strokeWidth={1.6}/>}
    </div>
    <div className="demo-controls">
      <div className="demo-steps" aria-label={t('演示步骤')}>
        {captions.map((label, index) => <button type="button" key={index} aria-pressed={step === index} onClick={() => jump(index)}><span className="demo-step-index">{index + 1}</span>{label}<span className="demo-step-progress" style={{transform: `scaleX(${step === index ? ((progress - [0, 5000, 8500][index]) / [5000, 3500, 7500][index]) : step > index ? 1 : 0})`}}/></button>)}
      </div>
      <div className="demo-playback">
        {!reduced && <button type="button" aria-label={paused ? t('播放演示') : t('暂停演示')} onClick={() => setPaused(value => !value)}>{paused ? <Play size={15}/> : <Pause size={15}/>}</button>}
        {!reduced && <button type="button" aria-label={t('重新播放演示')} onClick={() => {setElapsed(0); setPaused(false);}}><RotateCcw size={15}/></button>}
      </div>
    </div>
    <p className="demo-accessible-summary">{t('演示：老师讲解100人中20人选物理，其中5人也选化学，计算5÷20。学生只问“为什么不是除以100？”，即问自动带入当前课堂片段，解释条件已经限定为那20人。')}</p>
  </section>;
}
