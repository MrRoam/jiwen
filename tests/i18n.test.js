import test from 'node:test';
import assert from 'node:assert/strict';
import {readLocale,setLocale,getLocale,subscribeLocale,t,translateMessage,defaultLessonTitle,formatDate,LOCALE_KEY} from '../src/i18n.js';

function storage(value=null){const data=new Map(value===null?[]:[[LOCALE_KEY,value]]);return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};}

test('默认保留中文，读取已保存的英文选择，非法或不可用存储回退中文',()=>{
  assert.equal(readLocale(storage()),'zh-CN');
  assert.equal(readLocale(storage('en')),'en');
  assert.equal(readLocale(storage('fr')),'zh-CN');
  assert.equal(readLocale({getItem(){throw new Error('blocked');}}),'zh-CN');
});

test('切换即时通知并保存，非法语言不生效，存储失败不阻断切换',()=>{
  const local=storage(),blocked={setItem(){throw new Error('blocked');}};
  setLocale('zh-CN',local);
  const updates=[],unsubscribe=subscribeLocale(()=>updates.push(getLocale()));
  try{
    setLocale('en',local);assert.equal(readLocale(local),'en');
    setLocale('en',local);setLocale('fr',local);
    assert.deepEqual(updates,['en']);
    assert.doesNotThrow(()=>setLocale('zh-CN',blocked));
    assert.deepEqual(updates,['en','zh-CN']);
    unsubscribe();setLocale('en',local);assert.equal(updates.length,2);
  }finally{unsubscribe();setLocale('zh-CN',local);}
});

test('界面参数和单复数正确，参数中的中文课堂名称保持原文',()=>{
  assert.equal(t('新问题',{},'en'),'New question');
  assert.equal(t('{count} 个问题',{count:1},'en'),'1 question');
  assert.equal(t('{count} 个问题',{count:2},'en'),'2 questions');
  assert.equal(t('{count} 个问题',{count:2},'zh-CN'),'2 个问题');
  assert.equal(t('管理课堂：{title}',{title:'高等数学'},'en'),'Manage class: 高等数学');
  assert.equal(t('这是一段课堂原文',{},'en'),'这是一段课堂原文');
});

test('已有系统状态按当前语言翻译，嵌套断网状态保留恢复时间和操作',()=>{
  assert.equal(translateMessage('邮箱或密码不正确。','en'),'Incorrect email or password.');
  assert.equal(translateMessage('2 段录音待上传','en'),'2 recording chunks waiting to upload');
  assert.equal(translateMessage('转写已断开；3 秒后自动重连，录音继续保存','en'),'Transcription disconnected; reconnecting in 3s. Recording continues to save.');
  assert.equal(translateMessage('录音上传失败；请使用“恢复保存”重试','en'),'Recording upload failed; select “Resume upload” to retry.');
  assert.equal(translateMessage('邮箱或密码不正确。','zh-CN'),'邮箱或密码不正确。');
  assert.equal(translateMessage('未收录的服务错误','en'),'The service is temporarily unavailable. Please try again.');
  assert.equal(translateMessage('Network timeout','en'),'Network timeout');
});

test('新课堂默认名称和日期跟随语言，英文名称不影响已有课堂内容',()=>{
  const date=new Date(2026,9,1,12);
  assert.equal(defaultLessonTitle(date,'zh-CN'),'10月1日的课堂');
  assert.equal(defaultLessonTitle(date,'en'),'Class on October 1');
  assert.equal(formatDate(date,{month:'long',day:'numeric'},'en'),'October 1');
});
