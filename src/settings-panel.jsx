import React,{useLayoutEffect,useState} from 'react';

// 所有设置入口使用同一定位规则，避免个人版与体验站各自退回居中弹窗。
export function SettingsPanel({Modal,anchor,title,onClose,children,className=''}){
  const [position,setPosition]=useState(null);
  useLayoutEffect(()=>{
    function place(){
      const viewport=window.visualViewport;
      const leftEdge=viewport?.offsetLeft||0,topEdge=viewport?.offsetTop||0;
      const vw=viewport?.width||window.innerWidth,vh=viewport?.height||window.innerHeight;
      const trigger=anchor||[...document.querySelectorAll('.profile-entry,.sidebar-rail-bottom button')].find(el=>el.getClientRects().length);
      const r=trigger?.getBoundingClientRect();
      const width=Math.min(360,vw-24),rightEdge=leftEdge+vw-12,bottomEdge=topEdge+vh-12;
      const beside=r&&r.width>0&&r.right+12+width<=rightEdge;
      const left=beside?r.right+12:Math.max(leftEdge+12,Math.min(r?.left||leftEdge+12,rightEdge-width));
      const bottom=beside?Math.min(Math.max(r.bottom,topEdge+80),bottomEdge):bottomEdge;
      setPosition({left,bottom:window.innerHeight-bottom,width,maxHeight:Math.max(0,bottom-topEdge-12)});
    }
    place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    window.visualViewport?.addEventListener('resize',place);window.visualViewport?.addEventListener('scroll',place);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);window.visualViewport?.removeEventListener('resize',place);window.visualViewport?.removeEventListener('scroll',place);};
  },[anchor]);
  if(!position)return null;
  return <Modal title={title} className={`account-panel ${className}`} overlayClassName="account-overlay" position={position} onClose={onClose}>{children}</Modal>;
}
