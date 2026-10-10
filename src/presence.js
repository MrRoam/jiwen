import {useEffect,useRef} from 'react';

export function usePresence(userId,recording){
  const socket=useRef(null),recordingRef=useRef(recording);
  recordingRef.current=recording;
  useEffect(()=>{
    if(!userId)return;
    let closed=false,timer,retries=0;
    const send=()=>{if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({recording:recordingRef.current}));};
    function connect(){
      const current=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/presence`);socket.current=current;
      current.onopen=()=>{retries=0;send();};
      current.onclose=()=>{if(!closed)timer=setTimeout(connect,Math.min(15000,1000*2**retries++));};
      current.onerror=()=>current.close();
    }
    connect();const heartbeat=setInterval(send,15000);
    return()=>{closed=true;clearTimeout(timer);clearInterval(heartbeat);socket.current?.close();socket.current=null;};
  },[userId]);
  useEffect(()=>{if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({recording}));},[recording]);
}
