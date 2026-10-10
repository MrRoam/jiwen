import {createServer as createTcpServer} from 'node:net';

// 最小 SMTP 服务端：够 nodemailer 完成 EHLO/AUTH LOGIN/DATA 一轮握手，捕获邮件正文。
export function fakeSmtp(captured,{rejectData=()=>false}={}){
  const s=createTcpServer(socket=>{
    let buf='',dataMode=false,authStep=0;
    const send=x=>socket.write(x+'\r\n');
    send('220 test.local ESMTP');
    socket.on('data',chunk=>{buf+=chunk.toString();
      for(;;){
        if(dataMode){const end=buf.indexOf('\r\n.\r\n');if(end<0)return;captured.push(buf.slice(0,end));buf=buf.slice(end+5);dataMode=false;send('250 ok');continue;}
        const i=buf.indexOf('\r\n');if(i<0)return;const line=buf.slice(0,i);buf=buf.slice(i+2);const cmd=line.trim().toUpperCase();
        if(cmd.startsWith('EHLO')||cmd.startsWith('HELO'))send('250-test.local\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8');
        else if(cmd.startsWith('AUTH LOGIN')){authStep=1;send('334 VXNlcm5hbWU6');}
        else if(authStep===1){authStep=2;send('334 UGFzc3dvcmQ6');}
        else if(authStep===2){authStep=0;send('235 ok');}
        else if(cmd.startsWith('MAIL FROM')||cmd.startsWith('RCPT TO'))send('250 ok');
        else if(cmd.startsWith('DATA')){if(rejectData())send('550 delivery rejected');else{dataMode=true;send('354 go');}}
        else if(cmd.startsWith('QUIT')){send('221 bye');socket.end();}
        else send('250 ok');
      }});
    socket.on('error',()=>{});
  });
  return s;
}
export function decodeBody(raw){
  const enc=raw.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase();
  const body=raw.split(/\r?\n\r?\n/).slice(1).join('\r\n');
  if(enc==='base64')return Buffer.from(body.replace(/\s+/g,''),'base64').toString('utf8');
  if(enc==='quoted-printable')return Buffer.from(body.replace(/=\r?\n/g,'').replace(/=([0-9A-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))),'binary').toString('utf8');
  return body;
}
