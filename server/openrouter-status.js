// 不输出密钥、key label、账号标识或原始服务响应；只查询，不产生模型调用。
export async function checkOpenRouter(key,{fetchImpl=fetch}={}){
  if(!key)return {keyConfigured:false,expandedQuotaVerified:false,message:'请先在 .env 填写 OPENROUTER_API_KEY，再运行本命令。'};
  const query=async path=>{
    try{const response=await fetchImpl(`https://openrouter.ai/api/v1/${path}`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(10000)});return {status:response.status,data:response.ok?(await response.json()).data:null};}
    catch{return {status:0,data:null};}
  };
  const [current,credits]=await Promise.all([query('key'),query('credits')]);
  if(current.status!==200)return {keyConfigured:true,keyValid:false,expandedQuotaVerified:false,message:current.status===401?'OpenRouter 密钥无效或已过期。':'无法验证 OpenRouter 密钥，请检查网络后重试。'};
  const purchased=credits.data?.total_credits,spent=credits.data?.total_usage;
  const known=typeof purchased==='number'&&Number.isFinite(purchased)&&purchased>=0;
  return {
    keyConfigured:true,keyValid:true,
    isFreeTier:current.data?.is_free_tier??null,
    purchasedCredits:known?purchased:null,
    balance:known&&typeof spent==='number'?purchased-spent:null,
    expandedQuotaVerified:known&&purchased>=10,
    dailyFreeRequestsByPurchase:known?(purchased>=10?1000:50):null,
    requestsPerMinute:20,
    message:known?(purchased>=10?'累计购入达到 10 credits，按官方规则对应每日 1000 次免费模型请求。':'累计购入尚未达到 10 credits，按官方规则对应每日 50 次。'):
      '密钥有效，但未取得累计购入额度；普通推理密钥可能无权访问 credits 接口。请在 OpenRouter Credits 页面核对累计购入至少 10 credits。is_free_tier 和美元 usage_daily 不能证明当天剩余免费调用次数。'
  };
}
