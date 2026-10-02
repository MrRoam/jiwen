import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('连续采集 30 秒后仍持续输出音频，flush 才停止采样',()=>{
  let Processor;const packets=[];
  class Worklet {constructor(){this.port={postMessage:data=>packets.push(new Int16Array(data.buffer))};}}
  vm.runInNewContext(readFileSync(new URL('../src/pcm-worklet.js',import.meta.url),'utf8'),{AudioWorkletProcessor:Worklet,currentTime:0,sampleRate:48000,registerProcessor:(_name,type)=>Processor=type});
  const processor=new Processor(),input=new Float32Array(128).fill(.25);
  for(let i=0;i<48000*30/128;i++)processor.process([[input]]);
  assert.equal(packets.length,150);
  assert.ok(packets.at(-1).every(sample=>sample>8000));
  processor.port.onmessage({data:'flush'});
  for(let i=0;i<100;i++)processor.process([[input]]);
  assert.equal(packets.length,150);
});
