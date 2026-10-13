import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

let directory, Auth;
const legal = {
  version: '2026-10-07', operator: '姚佳旭', contact: 'joshyao0601@gmail.com', limits: {retentionDays: 30},
  privacy: {title: '隐私政策', sections: [{title: '保存和删除', paragraphs: ['完整课堂保存 30 天。']}]},
  terms: {title: '服务协议', sections: [{title: '许可', paragraphs: ['取得必要录音许可。']}]},
  providers: [{service: 'asr', name: '阿里云百炼转写', entity: '阿里云', region: '中国大陆北京', data: ['音频'], privacyUrl: 'https://example.com/privacy'}, {service: 'llm', name: '阿里云百炼问答', entity: '阿里云', region: '中国大陆北京', data: '问题与课堂文字'}],
};

before(async () => {
  // 编译到测试临时目录，避免 Vite 开发服务器的依赖扫描，不触碰课堂数据。
  globalThis.window = {location: {hash: '#register'}, addEventListener() {}, removeEventListener() {}};
  const scratch=path.resolve('output/test-tmp');mkdirSync(scratch,{recursive:true});
  directory=mkdtempSync(path.join(scratch,'auth-render-'));
  const outfile=path.join(directory,'auth.mjs');
  await build({entryPoints:['src/auth.jsx'],outfile,bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},logLevel:'silent'});
  ({Auth} = await import(pathToFileURL(outfile).href));
});
after(() => {
  if(directory){const target=path.resolve(directory);assert.ok(target.startsWith(path.resolve('output/test-tmp')+path.sep));rmSync(target,{recursive:true,force:true});}
  delete globalThis.window;
});

test('注册填写邮箱、验证码和密码，不显示年龄、协议确认和政策页脚', () => {
  window.location.hash = '#register';
  const html = renderToStaticMarkup(React.createElement(Auth, {config: {legal}, brand: '即问', setNotice() {}, onAuth() {}}));
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, /name="code"/);
  assert.match(html, /获取验证码/);
  assert.match(html, /minLength="8"/);
  assert.doesNotMatch(html, /type="checkbox"|隐私|服务协议|公测|成年人|public-legal-footer|you@example.com/);
});

test('直接政策链接无需登录，显示运营者及实际供应商地域与数据', () => {
  window.location.hash = '#privacy';
  const html = renderToStaticMarkup(React.createElement(Auth, {config: {legal}, brand: '即问', setNotice() {}, onAuth() {}}));
  assert.match(html, /姚佳旭/);
  assert.match(html, /joshyao0601@gmail.com/);
  assert.match(html, /中国大陆北京/);
  assert.match(html, /音频/);
  assert.match(html, /问题与课堂文字/);
  assert.doesNotMatch(html, /welcome-email/);
});

test('仅体验模式首页和注册页说明一次性1小时，自部署不显示体验承诺',()=>{
  for(const hash of ['', '#register']){
    window.location.hash=hash;
    const props={config:{legal,asrQuotaMode:'trial'},brand:'即问',setNotice(){},onAuth(){}};
    const html=renderToStaticMarkup(React.createElement(Auth,props));
    assert.match(html,/本站仅供体验/);assert.match(html,/一次性赠送 1 小时转写/);assert.match(html,/用完不自动恢复/);
    assert.match(html,/在自己的电脑使用/);assert.match(html,/github.com\/MrRoam\/jiwen/);
    const monthly=renderToStaticMarkup(React.createElement(Auth,{...props,config:{legal,asrQuotaMode:'monthly'}}));
    assert.doesNotMatch(monthly,/一次性赠送 1 小时/);
  }
});

