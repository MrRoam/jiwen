import React,{useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {X} from 'lucide-react';
import {AdminConsole} from './admin-console.jsx';
import './design.css';
import './admin-console.css';

function Modal({title,onClose,children,className=''}){
  const box=useRef(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const dialog=box.current;dialog.showModal();return()=>dialog.close();},[]);
  return <dialog ref={box} className={`console-dialog ${className}`} onCancel={event=>{event.preventDefault();close.current();}} onClick={event=>{if(event.target===box.current)close.current();}}><div className="console-dialog-heading"><h2>{title}</h2><button aria-label="关闭窗口" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}

createRoot(document.getElementById('root')).render(<AdminConsole Modal={Modal}/>);
