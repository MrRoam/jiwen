// 仅负责提取待判候选原文；是否属于要学生回答的提问由 Jev 结合后文判断。
export function questionCandidates(text) {
  const value=String(text||'').trim();
  if(value.length<5||value.length>1000)return [];
  const sentences=value.split(/(?<=[。！？!?])/u).map(s=>s.trim()).filter(Boolean);
  return sentences.filter(sentence=>sentence.length>=5&&sentence.length<=180&&(
    /[？?]$/.test(sentence)||
    /(?:请(?:大家|同学们?)?|大家|同学们?|你们?|谁来)(?:先|来|试着|想一想|思考一下|回答|说说|解释|分析|计算|证明|比较|求出)/.test(sentence)||
    /(?:为什么|怎么|怎样|如何|是什么|什么是|哪(?:个|些|种|里)|谁|多少|几(?:个|种|次|点)|是否|能否|对不对|是不是|能不能|会不会)[^。！!]{0,35}$/.test(sentence)
  )).slice(0,4);
}
