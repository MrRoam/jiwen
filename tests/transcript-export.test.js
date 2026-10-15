import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptExport} from '../src/transcript-export.js';

test('导出按课堂时间排序，保留原文、长课时间和识别中状态，不修改课堂',()=>{
  const lesson={title:'高数 / 第一课',segments:[
    {id:'b',start_ms:3723000,text:' English & 中文\n第二行 ',final:0},
    {id:'a',start_ms:1000,text:'第一句。',final:1},
    {id:'empty',start_ms:0,text:'   ',final:1},
  ]};
  const before=structuredClone(lesson),result=transcriptExport(lesson,'zh-CN');
  assert.equal(result.filename,'高数 _ 第一课.txt');
  assert.equal(result.text,'\uFEFF高数 / 第一课\r\n\r\n[00:00:01] 第一句。\r\n[01:02:03] English & 中文\n第二行 (识别中)\r\n');
  assert.deepEqual(lesson,before);
  assert.match(transcriptExport(lesson,'en').text,/中文\n第二行 \(Transcribing\)/);
});

test('空课堂不生成文件，文件名不能带路径或控制字符',()=>{
  assert.equal(transcriptExport({segments:[]}),null);
  assert.equal(transcriptExport({segments:[{text:'\n '}]}),null);
  const result=transcriptExport({title:'../CON:<课堂>\\name?*\u0000.',segments:[{text:'内容',start_ms:0,final:1}]});
  assert.doesNotMatch(result.filename,/[<>:"/\\|?*\u0000-\u001f]/);
  assert.ok(result.filename.endsWith('.txt'));
});
