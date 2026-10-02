const guideKey=userId=>`jiwen:guide:v1:${userId}`;

export function shouldShowGuide(userId,lessonCount,storage){
  if(!userId||lessonCount>0)return false;
  try{return (storage??window.localStorage).getItem(guideKey(userId))!=='seen';}catch{return true;}
}

export function rememberGuide(userId,storage){
  if(!userId)return;
  try{(storage??window.localStorage).setItem(guideKey(userId),'seen');}catch{/* 网站存储不可用时，仍允许关闭导引。 */}
}

// 浮层优先放在目标旁，空间不足时上下放置，保持在可见视口内。
export function guidePosition(target,viewport,bubble){
  const margin=12,gap=16;
  const minLeft=(viewport.left??0)+margin,minTop=(viewport.top??0)+margin;
  const right=(viewport.left??0)+viewport.width-margin,bottom=(viewport.top??0)+viewport.height-margin;
  const width=Math.min(bubble.width,right-minLeft),height=Math.min(bubble.height,bottom-minTop);
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const centerX=target.left+target.width/2,centerY=target.top+target.height/2;
  let placement,left,top;
  if(right-target.right>=width+gap){placement='right';left=target.right+gap;top=centerY-height/2;}
  else if(target.left-minLeft>=width+gap){placement='left';left=target.left-width-gap;top=centerY-height/2;}
  else{
    const above=target.top-minTop-gap,below=bottom-target.bottom-gap;
    placement=below>=height||below>above?'below':'above';
    left=centerX-width/2;top=placement==='below'?target.bottom+gap:target.top-height-gap;
  }
  left=clamp(left,minLeft,right-width);top=clamp(top,minTop,bottom-height);
  const arrowOffset=placement==='above'||placement==='below'?clamp(centerX-left,20,width-20):clamp(centerY-top,20,height-20);
  return {placement,left,top,width,maxHeight:bottom-minTop,arrowOffset};
}
