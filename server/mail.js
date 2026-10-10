import nodemailer from 'nodemailer';

let transporter=null;
export function mailConfigured(){return !!(process.env.SMTP_USER&&process.env.SMTP_PASS);}
export function mailFrom(){return process.env.MAIL_FROM||process.env.SMTP_USER;}
export async function sendMail({to,subject,text}){
  const port=Number(process.env.SMTP_PORT||465);
  transporter??=nodemailer.createTransport({host:process.env.SMTP_HOST||'smtp.qq.com',port,secure:port===465,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  await transporter.sendMail({from:mailFrom(),to,subject,text});
}
