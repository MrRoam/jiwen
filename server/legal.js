import {createHash} from 'node:crypto';

const ALI_PRIVACY='https://help.aliyun.com/zh/model-studio/privacy-notice';
const TENCENT_PRIVACY='https://privacy.qq.com/policy/tencent-privacypolicy';
export const operator=process.env.PUBLIC_OPERATOR||'姚佳旭';
export const contact=process.env.PUBLIC_CONTACT||'joshyao0601@gmail.com';
export const storageLimits={userBytes:Number(process.env.USER_STORAGE_BYTES||500*1024**2),globalBytes:Number(process.env.GLOBAL_STORAGE_BYTES||100*1024**3),minFreeBytes:Number(process.env.MIN_FREE_DISK_BYTES||20*1024**3),retentionDays:Number(process.env.LESSON_RETENTION_DAYS||30),maxRecordingSeconds:Number(process.env.MAX_RECORDING_SECONDS||7200)};
if(!Object.values(storageLimits).every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('存储额度与保存期必须是正整数。');

function host(url){try{return new URL(url).hostname;}catch{return '';}}
function apiProvider(service,url,data){
  const hostname=host(url);
  if(['localhost','127.0.0.1','[::1]'].includes(hostname))return {service,name:'运营者本地服务',entity:operator,region:'运营者部署设备所在地区',data};
  if(['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com'].includes(hostname))return {service,name:'阿里云百炼',entity:'阿里云计算有限公司',region:hostname==='dashscope.aliyuncs.com'?'中国大陆（北京接入点）':hostname==='dashscope-us.aliyuncs.com'?'美国接入点':'新加坡接入点',data,privacyUrl:ALI_PRIVACY};
  // 自定义服务的主体、地区不能从域名猜测，运营者需补充披露。
  return {service,name:process.env[`${service.toUpperCase()}_PUBLIC_NAME`]||`自定义服务（${hostname}）`,entity:process.env[`${service.toUpperCase()}_PUBLIC_ENTITY`]||'待运营者补充',region:process.env[`${service.toUpperCase()}_PUBLIC_REGION`]||'待运营者核实',data};
}
export function legalDocument(env,mailReady=false,jevEnabled=false){
  const providers=[{service:'hosting',name:'即问应用与数据存储',entity:operator,region:process.env.PUBLIC_STORAGE_REGION||'中国大陆，运营者部署设备',data:'邮箱、课堂录音、转写、问题、回答和使用记录'}];
  if(env.PUBLIC_ACCESS_PROVIDER==='cloudflare')providers.push({service:'access',name:'Cloudflare Tunnel 访问转发',entity:'Cloudflare, Inc.',region:'全球边缘节点，具体处理地区依其服务',data:'访问请求及通过公网入口转发的账号、音频和课堂数据；应用持久数据仍保存在运营者设备',privacyUrl:'https://www.cloudflare.com/privacypolicy/'});
  providers.push(env.ASR_PROVIDER==='local'?{service:'asr',name:'运营者本地转写',entity:operator,region:process.env.PUBLIC_STORAGE_REGION||'中国大陆，运营者部署设备',data:'录音音频；“本地”指运营者设备，并非用户手机或电脑'}:apiProvider('asr',env.ASR_WS_URL,'用于实时转写的音频片段和请求元信息'));
  if(env.ASR_PROVIDER!=='local'&&env.LOCAL_ASR_RECOVERY==='true')providers.push({service:'asr',name:'运营者本地补转写',entity:operator,region:process.env.PUBLIC_STORAGE_REGION||'中国大陆，运营者部署设备',data:'已保存的录音音频，用于后台补齐缺失文字；“本地”指运营者设备，并非用户手机或电脑'});
  providers.push(apiProvider('llm',env.LLM_BASE_URL,'提问、对应课堂转写片段、冻结引用和对话历史；不发送完整录音文件'));
  if(env.LLM_ROUTING==='openrouter-first'&&env.OPENROUTER_API_KEY)providers.push({service:'llm',name:'OpenRouter 与其模型处理方',entity:'OpenRouter, Inc.；模型处理方依实际路由',region:'可能涉及境外处理，需运营者在启用前核实',data:'提问、课堂转写片段和对话历史',privacyUrl:'https://openrouter.ai/privacy'});
  if(mailReady)providers.push({service:'mail',name:host(`smtp://${process.env.SMTP_HOST||'smtp.qq.com'}`)==='smtp.qq.com'?'腾讯 QQ 邮箱':'运营者配置的邮件服务',entity:(process.env.SMTP_HOST||'smtp.qq.com')==='smtp.qq.com'?'腾讯（QQ 邮箱服务）':process.env.MAIL_PUBLIC_ENTITY||'待运营者补充',region:(process.env.SMTP_HOST||'smtp.qq.com')==='smtp.qq.com'?'中国大陆；收件方邮箱按其规则处理':process.env.MAIL_PUBLIC_REGION||'待运营者核实',data:'收件邮箱、注册和密码重置验证码与邮件内容；不发送课堂录音',privacyUrl:TENCENT_PRIVACY});
  if(jevEnabled)providers.push({service:'jev',name:'Jev 服务',entity:process.env.JEV_PUBLIC_ENTITY||'待运营者补充',region:process.env.JEV_PUBLIC_REGION||'待运营者核实',data:'用于重点和问题检测的转写片段'});
  const limits=storageLimits;
  const version=`2026-10-07-${createHash('sha256').update(JSON.stringify({operator,contact,providers,limits,textRevision:legalDocument.toString()})).digest('hex').slice(0,12)}`;
  const section=(title,...paragraphs)=>({title,paragraphs});
  return {version,operator,contact,providers,limits,
    privacy:{title:'即问数据说明',sections:[
      section('运营者与用途',`本服务由${operator}运营。隐私、反馈和数据请求请联系 ${contact}。`,`邮箱用于注册验证、登录和重置密码；密码以加盐散列保存。课堂录音、转写、问题、回答和冻结引用用于你主动使用的课堂记录与问答功能；使用记录用于额度控制。不将课堂内容主动用于广告或训练。`),
      section('录音和外部处理','开始课堂录音前，你需要确认已取得教师、相关参与者和机构要求的必要许可。麦克风授权不等于其他人的录音许可。请避免录入与课堂无关的个人信息和敏感信息。','音频上传到运营者的部署设备。实际转写、问答和邮件处理方列在本页供应商信息中。供应商依据自己的政策处理和保存请求，不能将本服务的删除操作解释为供应商立即删除全部副本。处理方或地区变更会更新本政策中的供应商信息。'),
      section('保存期与存储',`每个账号的服务器存储上限为${Math.round(limits.userBytes/1024**2)} MiB。整堂课堂在最后一次成功上传新的音频分段后保留${limits.retentionDays}天，到期删除录音、转写与相关对话；浏览和提问不延长保存期。旧课堂从本规则首次生效时获得完整保存期。到期前7天和1天在课堂页面提醒，请及时导出。`,`录音前按剩余容量限制本次时长，单段最多${Math.round(limits.maxRecordingSeconds/3600)}小时；空间不足时不能开始新录音。原始分段与兼容音频副本都计入容量。浏览器保留尚未上传的音频；退出登录不会自动清除，删除课堂或注销会请求清除对应缓存。浏览器存储失败时必须保持页面开启，尝试恢复或导出。`,'过期登录会话和失效验证码在失效后定期清理；用量明细保留90天。备份工具保留最近7天副本，需运营者停服务后执行；尚未承诺已启用每日自动备份。删除清单会在恢复备份时再次排除已删除数据。'),
      section('查阅、导出和删除',`账号面板可导出账号、课堂文字和问答数据；已保存的录音可单独下载。可删除课堂，或用密码确认注销账号。正在录音、保存、回放或回答时，请结束任务后删除。实例管理员需完成交接后再处理注销。`,`你可以联系 ${contact} 请求更正、副本、删除、撤回授权或投诉。我们以3个工作日内确认收到、15个工作日内完成或说明处理进度为受理目标。撤回不影响撤回前已完成的处理；停止上传并删除课堂可停止后续使用。`)
    ]},
    terms:{title:'即问使用说明',sections:[
      section('服务范围','服务可能中断或调整；请保留重要录音与资料的副本。容量、时长与保存期按页面显示的实际限制执行。'),
      section('录音与内容权利','请遵守课堂、教师及机构的录音要求，取得必要许可。请勿公开传播未经授权的课堂音频、他人个人信息和教材内容。你保留自己内容的相应权利，授权服务仅为录音保存、转写与问答处理必要内容。'),
      section('AI 输出','转写和回答由模型生成，可能漏字、误识别或给出错误解释。请核对原始录音、教师讲解及可靠资料；不要将输出直接作为重要决策的唯一依据。'),
      section('额度与数据处理',`请阅读隐私政策和实际供应商信息。课堂按最后成功上传音频后${limits.retentionDays}天保存；到期前请导出。录音保存与转写独立，转写不可用时仍可保存录音。`),
      section('联系与退出',`反馈与争议可联系运营者${operator}：${contact}。可停止使用、导出数据、删除课堂或申请注销。`)
    ]}
  };
}
export function initLegal(db){db.exec(`CREATE TABLE IF NOT EXISTS legal_consents(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,version TEXT NOT NULL,accepted_at TEXT NOT NULL,adult INTEGER NOT NULL,PRIMARY KEY(user_id,version)); CREATE TABLE IF NOT EXISTS recording_consents(lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,version TEXT NOT NULL,accepted_at TEXT NOT NULL,PRIMARY KEY(lesson_id,version));`);}
export function validConsent(value,version){return value?.version===version&&value.accepted===true;}
