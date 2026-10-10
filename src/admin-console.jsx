import React,{useEffect,useRef,useState} from 'react';
import {Users,Mic,AudioLines,MessageCircle,RotateCw,RefreshCw,Check,LoaderCircle,Power,Server,HardDrive,Clock,AlertTriangle} from 'lucide-react';
import {api} from './api';
import './admin-console.css';

const number=value=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(value);
const money=value=>value===null||value===undefined?'—':value>0&&value<0.01?'< ¥0.01':new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
const bytes=value=>value>=1024**3?`${number(value/1024**3)} GB`:`${number(value/1024**2)} MB`;
const duration=ms=>{const minutes=Math.floor(ms/60000);return minutes>=60?`${Math.floor(minutes/60)} 小时 ${minutes%60} 分`:`${minutes} 分钟`;};
const date=(value,options)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...options}).format(value);
const taskNames={recording:'录音中',recovery:'待恢复',answering:'回答中',saving:'保存中',transcribing:'转写中',converting:'转换中',playback:'回放中',testing:'检测中',background:'后台处理'};

function Status({children,warning=false}){return <span className={`console-status${warning?' is-warning':''}`}><i aria-hidden="true"/>{children}</span>;}
function Meter({value,max,label}){return <progress className="console-meter" aria-label={label} value={Math.min(value,max)} max={max}/>;}

function Cost({cost}){
  const total=cost?.totalCny,asr=cost?.asr,llm=cost?.llm;
  const visible=(value,unknown)=>unknown&&value===0?null:value;
  const asrShare=total>0?asr.cny/total*100:0;
  return <section className="console-cost" aria-label="今日 API 成本" aria-busy={!cost}>
    <div className="console-cost-summary"><div className="console-cost-label"><h2>今日 API 成本</h2><span className={cost&&!cost.complete?'is-warning':''}>{cost&&!cost.complete?'部分估算':'估算'}</span></div><strong>{money(cost?visible(total,!cost.complete):null)}</strong><div className="console-cost-share" role="img" aria-label={total>0?`已计价成本：转写 ${Math.round(asrShare)}%，问答 ${Math.round(100-asrShare)}%`:'暂无已计价成本'}><i style={{width:`${asrShare}%`}}/><i style={{width:`${total>0?100-asrShare:0}%`}}/></div></div>
    <div className="console-cost-part"><h3><i/>云端转写</h3><strong>{money(asr?visible(asr.cny,asr.unpricedSeconds>0):null)}</strong><small className={asr?.unpricedSeconds?'is-warning':''}>{asr?.unpricedSeconds?`${number(asr.unpricedSeconds/60)} 分钟未计价`:cost?.pricing.asrPerHour===null?'当前模型未设单价':cost?`标准价 ${money(cost.pricing.asrPerHour)} / 小时`:'读取中'}</small></div>
    <div className="console-cost-part"><h3><i className="is-llm"/>AI 问答</h3><strong>{money(llm?visible(llm.cny,llm.unpricedCalls>0):null)}</strong><small className={llm?.unpricedCalls?'is-warning':''}>{llm?.unpricedCalls?`${llm.unpricedCalls} 次调用未计价`:cost?`${number(llm.calls)} 次模型调用`:'读取中'}</small></div>
    {cost&&<details className="console-cost-details"><summary>计价说明</summary><div><p>仅统计 API 标准价，未扣赠送额度或优惠；本机算力与存储未计入。旧音频无法区分云端与本机来源，缺少用量或单价的调用不计入金额。</p><dl><dt>当前转写</dt><dd>{cost.pricing.asrModel} · {cost.pricing.asrPerHour===null?'未设单价':`${money(cost.pricing.asrPerHour)} / 小时`}</dd><dt>当前问答</dt><dd>{cost.pricing.llmModel} · 免费路由计 ¥0.00</dd></dl>{cost.pricing.llmRates&&<table><caption>问答单价：元 / 百万 Token，缓存命中另按折扣计价</caption><thead><tr><th>单次输入</th><th>输入</th><th>输出</th></tr></thead><tbody>{cost.pricing.llmRates.map((rate,index)=><tr key={rate.maxInput}><td>{index?`${cost.pricing.llmRates[index-1].maxInput/1000}K～`: '≤'}{rate.maxInput/1000}K</td><td>{rate.input}</td><td>{rate.output}</td></tr>)}</tbody></table>}<div className="console-cost-sources"><span>{cost.pricing.verifiedAt} 核对</span>{cost.pricing.sources.map(source=><a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.label} 价格</a>)}</div></div></details>}
  </section>;
}

function Trend({history,at}){
  const [selected,setSelected]=useState(null),[width,setWidth]=useState(720);
  const container=useRef(null);
  useEffect(()=>{const resize=()=>setWidth(Math.max(260,container.current?.clientWidth||720));resize();const observer=new ResizeObserver(resize);observer.observe(container.current);return()=>observer.disconnect();},[]);
  const height=width<480?185:218,left=30,right=12,top=15,bottom=28,start=Math.floor(at/60000)*60000-59*60000;
  const maximum=Math.max(4,...history.map(point=>point.online),...history.map(point=>point.recording));
  const ceil=Math.ceil(maximum/4)*4;
  const x=timestamp=>left+(timestamp-start)/(59*60000)*(width-left-right);
  const y=value=>height-bottom-value/ceil*(height-top-bottom);
  const path=key=>history.map((point,index)=>`${index?'L':'M'}${x(point.at)},${y(point[key])}`).join(' ');
  const point=history.find(item=>item.at===selected);
  return <div className="console-trend" ref={container}>
    <div className="console-section-head"><h2>在线趋势</h2><span className="console-subtle">近 1 小时</span></div>
    <div className="console-chart-legend"><span><i/>在线</span><span><i className="recording"/>录音</span>{point&&<span className="console-chart-value">{date(point.at,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})} · {point.online} 人在线 · {point.recording} 人录音</span>}</div>
    <svg className="console-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`近一小时在线和录音趋势，当前 ${history.at(-1)?.online||0} 人在线，${history.at(-1)?.recording||0} 人录音`} onMouseLeave={()=>setSelected(null)}>
      {[0,1,2,3,4].map(index=><g key={index}><line x1={left} x2={width-right} y1={y(index*ceil/4)} y2={y(index*ceil/4)} className="console-grid-line"/><text x={left-9} y={y(index*ceil/4)+4} textAnchor="end">{index*ceil/4}</text></g>)}
      {[0,15,30,45,59].map(minute=><text key={minute} x={x(start+minute*60000)} y={height-4} textAnchor={minute===0?'start':minute===59?'end':'middle'}>{date(start+minute*60000,{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}</text>)}
      {history.length>1&&<><path d={`${path('online')} L${x(history.at(-1).at)},${y(0)} L${x(history[0].at)},${y(0)} Z`} fill="#315e4b" fillOpacity=".065"/><path d={path('online')} className="console-online-line"/><path d={path('recording')} className="console-recording-line"/></>}
      {history.map(item=><g key={item.at}><circle cx={x(item.at)} cy={y(item.online)} r={history.length===1?4:0} fill="#315e4b"/><rect x={x(item.at)-6} y={top} width={12} height={height-top-bottom} fill="transparent" onMouseMove={()=>setSelected(item.at)}><title>{date(item.at,{hour:'2-digit',minute:'2-digit'})}：{item.online} 人在线，{item.recording} 人录音</title></rect></g>)}
      {point&&<><line x1={x(point.at)} x2={x(point.at)} y1={top} y2={y(0)} className="console-selection-line"/><circle cx={x(point.at)} cy={y(point.online)} r={4} fill="#315e4b"/><circle cx={x(point.at)} cy={y(point.recording)} r={4} fill="#a56d23"/></>}
    </svg>
    {history.length<2&&<span className="console-chart-empty">正在积累趋势</span>}
  </div>;
}

function Quota({label,used,limit,unit}){
  const percent=Math.min(100,used/limit*100),exhausted=percent>=100;
  return <div className={`console-quota${percent>=80?' is-warning':''}`}>
    <div className="console-donut"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42" className="console-donut-track"/><circle cx="50" cy="50" r="42" className="console-donut-value" strokeDasharray={`${percent*2.639} 263.9`} transform="rotate(-90 50 50)"/></svg><strong>{percent>0&&percent<1?'<1':Math.floor(percent)}<small>%</small></strong></div>
    <div className="console-quota-info"><h3>{label}</h3><p><strong>{number(used)}</strong><span> / {number(limit)} {unit}</span></p><small>{exhausted?'额度已用完':`剩余 ${number(Math.max(0,limit-used))} ${unit}`}</small></div>
  </div>;
}

export function AdminConsole({Modal}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(false),[confirm,setConfirm]=useState(false),[restart,setRestart]=useState(null),[restartError,setRestartError]=useState(''),[sending,setSending]=useState(false);
  const page=useRef(null),restartRef=useRef(null),refresh=useRef(null);
  useEffect(()=>{const previous=document.activeElement;page.current?.focus();return()=>previous?.focus();},[]);
  useEffect(()=>{
    let mounted=true,timer,controller;let pending=false;
    async function load(){
      if(pending)return;pending=true;controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
      if(mounted)setRefreshing(true);
      try{
        const result=await api('/admin/overview',{signal:controller.signal});if(!mounted)return;
        setData(result);setError('');
        if(restartRef.current&&result.instanceId!==restartRef.current.instanceId){restartRef.current=null;setRestart(null);setConfirm(false);setRestartError('');}
      }catch(e){if(mounted)setError(restartRef.current?'服务重启中…':e.message);}
      finally{clearTimeout(timeout);pending=false;if(mounted){setRefreshing(false);timer=setTimeout(load,5000);}}
    }
    refresh.current=()=>{clearTimeout(timer);load();};load();
    return()=>{mounted=false;clearTimeout(timer);controller?.abort();};
  },[]);
  const stale=!!error,restarting=!!restart,blocked=!data||data.restart.blockers>0;
  async function restartService(){
    if(sending)return;setSending(true);setRestartError('');
    try{
      const accepted=await api('/admin/restart',{method:'POST',body:{confirmation:'restart'}});
      const value={instanceId:accepted.instanceId,at:Date.now()};restartRef.current=value;setRestart(value);refresh.current?.();
    }catch(e){setRestartError(e.message);refresh.current?.();}
    finally{setSending(false);}
  }
  const live=data?.live;
  const metrics=[{name:'在线人数',value:live?.online,Icon:Users,detail:data?`累计 ${number(data.accounts.total)} 个账号`:''},{name:'正在录音',value:live?.recording,Icon:Mic,detail:live?.pendingRecordings?`${live.pendingRecordings} 个待恢复`:''},{name:'实时转写',value:live?.transcribing,Icon:AudioLines,detail:data?`并发上限 ${data.system.asrConcurrency}`:''},{name:'正在回答',value:live?.answering,Icon:MessageCircle,detail:live?.saving?`${live.saving} 个录音保存中`:''}];
  const system=data?.system,store=system?.storage,calls=data?.usage.calls;
  const completed=(calls?.completed||0)+(calls?.failed||0),success=completed?Math.round(calls.completed/completed*100):null;
  return <div className="admin-console" ref={page} tabIndex={-1}>
    <header className="console-topbar"><div className="console-identity"><span className="console-brand"><Server size={22}/>本机控制台</span></div></header>
    <main className="console-content">
      <div className="console-heading"><div><div className="console-title-line"><h1>运行概览</h1><Status warning={stale||restarting}>{restarting?'重启中':stale?'连接中断':data?'运行中':'连接中'}</Status></div><p>{date(data?.at||Date.now(),{month:'long',day:'numeric',weekday:'long'})}<span>北京时间</span></p></div><div className="console-actions"><button className="console-refresh" aria-label="刷新数据" onClick={()=>refresh.current?.()} disabled={refreshing||restarting}><RefreshCw size={17} className={refreshing?'spin':''}/></button><button className="console-restart" onClick={()=>{setRestartError('');setConfirm(true);}} disabled={!data||stale||restarting||!data.restart.supported}><RotateCw size={16}/>重启服务</button></div></div>
      {error&&!restarting&&<div className="console-error" role="alert"><AlertTriangle size={16}/>{error}<button onClick={()=>refresh.current?.()}>重试</button></div>}
      {restarting&&<div className="console-error" role="status"><LoaderCircle size={16} className="spin"/>{Date.now()-restart.at>45000?'尚未恢复连接，请检查服务。':'正在重启，恢复后自动更新。'}</div>}
      <Cost cost={data?.costs}/>
      <section className="console-metrics" aria-label="实时使用情况" aria-busy={!data}>{metrics.map(({name,value,Icon,detail})=><div className="console-metric" key={name}><div className="console-metric-label"><Icon size={17}/>{name}</div><strong>{value??'—'}<small>{name==='实时转写'?'路':name==='正在回答'?'个':'人'}</small></strong><span>{detail||'\u00a0'}</span></div>)}</section>
      <div className="console-primary">
        <section className="console-surface console-trend-surface">{data?<Trend history={data.history} at={data.at}/>:<div className="console-loading"><LoaderCircle size={23} className="spin"/>读取趋势</div>}</section>
        <section className="console-surface console-daily"><div className="console-section-head"><h2>今日全站额度</h2><span className="console-subtle">08:00 重置</span></div>{data?<><Quota label="AI 问答" used={data.usage.llm.used} limit={data.usage.llm.limit} unit="次"/><Quota label="实时转写" used={data.usage.asr.used/60} limit={data.usage.asr.limit/60} unit="分钟"/><div className="console-daily-footer"><span>新增账号</span><strong>+{data.accounts.newToday}</strong></div></>:<div className="console-loading">读取额度</div>}</section>
      </div>
      <div className="console-secondary">
        <section className="console-surface console-tasks"><div className="console-section-head"><h2>当前任务</h2><span className="console-count">{data?.taskCount??'—'}</span></div><div className="console-task-table"><div className="console-task-head"><span>账号</span><span>状态</span><span>已运行</span></div>{data?.tasks.length?data.tasks.map(task=><div className="console-task-row" key={`${task.type}-${task.id}`}><span className="console-task-account"><span className="console-avatar">{task.email?.[0]?.toUpperCase()||'?'}</span><span title={task.email}>{task.email}</span></span><Status warning={task.type==='recovery'}>{taskNames[task.type]}</Status><span>{task.startedAt?duration(data.at-task.startedAt):'—'}</span></div>):<div className="console-tasks-empty">{data?<><span><Check size={24} strokeWidth={1.5}/></span><strong>当前没有进行中的任务</strong></>:<LoaderCircle className="spin" size={20}/>}</div>}</div>{data?.taskCount>100&&<div className="console-subtle">显示前 100 个任务</div>}</section>
        <section className="console-surface console-system"><div className="console-section-head"><h2>服务与资源</h2></div><div className="console-service-list">{system&&Object.entries(system.services).map(([key,service])=><div className="console-service" key={key}><span><Server size={16}/>{key==='asr'?'转写':'问答'}</span><Status warning={!service.configured}>{service.configured?'已配置':'未配置'}</Status></div>)}</div>{store&&<div className="console-resource"><div><span><HardDrive size={16}/>全站存储</span><strong>{bytes(store.usedBytes)}<small> / {bytes(store.limitBytes)}</small></strong></div><Meter value={store.usedBytes+store.reservedBytes} max={store.limitBytes} label="全站已用和预留存储"/><p>预留 {bytes(store.reservedBytes)}<span className={store.freeBytes<store.minFreeBytes?'is-warning':''}>磁盘可用 {bytes(store.freeBytes)}</span></p></div>}
          <div className="console-system-facts"><div><span>进程内存</span><strong>{system?bytes(system.memoryBytes):'—'}</strong></div><div><span><Clock size={14}/>连续运行</span><strong>{data?duration(data.at-data.startedAt):'—'}</strong></div></div>
        </section>
      </div>
      <section className="console-bottom" aria-label="今日问答调用"><div><span>今日模型调用</span><strong>{calls?.total??'—'}<small>次</small></strong></div><div><span>调用成功率</span><strong>{success===null?'—':`${success}%`}</strong></div><div><span>失败调用</span><strong className={calls?.failed?'is-warning':''}>{calls?.failed??'—'}<small>次</small></strong></div><div><span title="仅统计供应商已回报的 Token；失败及未回报调用不计入。">已回报 Token</span><strong>{data?number(data.usage.llm.promptTokens+data.usage.llm.completionTokens):'—'}</strong></div></section>
      <footer className="console-footer"><span>{data?`${date(data.at,{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})} 更新`:'连接中'}<i/>每 5 秒刷新</span></footer>
    </main>
    {confirm&&<Modal title="重启服务？" className="console-restart-dialog" onClose={()=>{if(!restarting&&!sending)setConfirm(false);}}><div className="console-restart-symbol"><Power size={25}/></div><p className="console-confirm-copy">{blocked?'请先结束当前录音与处理任务。':'页面会短暂断开，恢复后自动连接。'}<span>已保存的课堂和录音会保留。</span></p>{data&&<div className="console-confirm-stats"><span>在线<strong>{data.live.online}</strong></span><span>录音<strong>{data.live.recording}</strong></span><span>阻塞任务<strong>{data.restart.blockers}</strong></span></div>}{restartError&&<p className="console-confirm-error" role="alert">{restartError}</p>}<div className="console-confirm-actions"><button className="console-back" disabled={restarting||sending} onClick={()=>setConfirm(false)}>取消</button><button className="console-restart" disabled={blocked||stale||restarting||sending} onClick={restartService}>{restarting||sending?<LoaderCircle size={16} className="spin"/>:<RotateCw size={16}/>} {restarting||sending?'正在重启':'确认重启'}</button></div></Modal>}
  </div>;
}
