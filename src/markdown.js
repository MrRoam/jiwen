// 在 Markdown 消耗反斜杠前统一公式分隔符，代码片段保持原样。
export function normalizeMath(source) {
  return source.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*`+)/g).map((part,index)=>index%2?part:part
    .replace(/\\\[([\s\S]*?)\\\]/g,(_,math)=>`\n\n$$\n${math.trim()}\n$$\n\n`)
    .replace(/\\\(([^\n]*?)\\\)/g,(_,math)=>`$${math}$`)).join('');
}
