import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServiceConfig} from '../server/service-config.js';
import {routingConfig} from '../server/answer-router.js';

test('私有配置覆盖环境值，空密钥保留，重启持久化，显式清除不回退到原密钥',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'jiwen-config-'));
  try{
    const base={DASHSCOPE_API_KEY:'original-fixture-key',LLM_API_KEY:'original-llm-fixture'},config=createServiceConfig(dir,base);
    const summary=config.update({DASHSCOPE_API_KEY:'new-fixture-key',LLM_MODEL:'custom-model'});
    assert.equal(summary.DASHSCOPE_API_KEY_CONFIGURED,true);assert.ok(!JSON.stringify(summary).includes('fixture-key'));
    config.update({DASHSCOPE_API_KEY:'',LLM_BASE_URL:'https://example.test/v1'});
    assert.equal(config.env().DASHSCOPE_API_KEY,'new-fixture-key');
    const restarted=createServiceConfig(dir,base);assert.equal(restarted.env().LLM_MODEL,'custom-model');
    restarted.clear('asr');assert.equal(restarted.env().DASHSCOPE_API_KEY,'');
    restarted.clear('llm');assert.equal(routingConfig(restarted.env()).fallback.key,'');
    assert.equal(createServiceConfig(dir,base).env().LLM_API_KEY,'');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('无效值和带密钥 URL 不落盘，非本机明文接口被拒绝',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'jiwen-config-'));const config=createServiceConfig(dir,{});
  try{
    config.update({LLM_MODEL:'stable'});const original=readFileSync(path.join(dir,'service-config.json'),'utf8');
    for(const body of [{PORT:'1234'},{LLM_BASE_URL:'not-url'},{LLM_BASE_URL:'https://user:secret@example.test/v1'},{LLM_BASE_URL:'https://example.test/v1?key=secret'},{ASR_WS_URL:'ws://example.test/asr'},{LOCAL_ASR_URL:'http://example.test'},{LLM_MODEL:'bad\nvalue'},{LLM_ROUTING:'other'},{DASHSCOPE_API_KEY:123}]){
      assert.throws(()=>config.update(body));assert.equal(readFileSync(path.join(dir,'service-config.json'),'utf8'),original);
    }
    assert.doesNotThrow(()=>config.update({LLM_BASE_URL:'http://127.0.0.1:12345/v1',ASR_WS_URL:'ws://localhost:12345/asr'}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('百炼密钥不会因自填问答地址被发送给其他供应商',()=>{
  const config=routingConfig({DASHSCOPE_API_KEY:'asr-fixture',LLM_BASE_URL:'https://example.test/v1'});
  assert.equal(config.fallback.key,'');
  assert.equal(routingConfig({DASHSCOPE_API_KEY:'asr-fixture'}).fallback.key,'asr-fixture');
  assert.equal(routingConfig({DASHSCOPE_API_KEY:'asr-fixture',LLM_USE_ASR_KEY:'false'}).fallback.key,'');
});
