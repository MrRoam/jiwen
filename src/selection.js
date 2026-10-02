// 将原生选区拆成带原始句子 ID 的精确引用，忽略时间戳等界面文字。
export function readQuotes(container, selection) {
  if(!container||!selection?.rangeCount||selection.isCollapsed)return [];
  const range=selection.getRangeAt(0);
  if(!container.contains(range.startContainer)||!container.contains(range.endContainer))return [];
  return [...container.querySelectorAll('[data-segment-id]')].flatMap(el=>{
    if(!range.intersectsNode(el))return [];
    const part=el.ownerDocument.createRange();part.selectNodeContents(el);
    if(el.contains(range.startContainer))part.setStart(range.startContainer,range.startOffset);
    if(el.contains(range.endContainer))part.setEnd(range.endContainer,range.endOffset);
    const text=part.toString();
    return text.trim()?[{id:el.dataset.segmentId,text,start_ms:Number(el.dataset.startMs)}]:[];
  });
}

// 将操作按钮放在选文旁边；窄屏或两侧空间不足时退到选文下方。
export function selectionActionPosition(rect, viewportWidth, viewportHeight) {
  const gap=8,edge=12,buttonWidth=148,buttonHeight=40;
  const centerY=Math.max(edge+buttonHeight/2,Math.min(viewportHeight-edge-buttonHeight/2,rect.top+rect.height/2));
  if(viewportWidth-rect.right>=buttonWidth+gap+edge)return {left:rect.right+gap,top:centerY,transform:'translateY(-50%)'};
  if(rect.left>=buttonWidth+gap+edge)return {left:rect.left-gap,top:centerY,transform:'translate(-100%, -50%)'};
  const below=rect.bottom+gap;
  return {
    left:Math.max(edge+buttonWidth/2,Math.min(viewportWidth-edge-buttonWidth/2,rect.left+rect.width/2)),
    top:below+buttonHeight<=viewportHeight-edge?below:Math.max(edge,rect.top-gap-buttonHeight),
    transform:'translateX(-50%)'
  };
}
