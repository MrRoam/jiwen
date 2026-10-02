import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import {normalizeMath} from '../src/markdown.js';

test('截图中的 LaTeX 分隔符实际渲染为公式，表格正常输出',()=>{
  const content=String.raw`我按 \(U_{AB}=\varphi_A-\varphi_B\) 理解。

\[U_{AB}<0\]

| A | B |
| --- | --- |
| 1 | 2 |`;
  const html=renderToStaticMarkup(React.createElement(ReactMarkdown,{remarkPlugins:[remarkGfm,remarkMath],rehypePlugins:[rehypeKatex]},normalizeMath(content)));
  assert.match(html,/class="katex"/);assert.match(html,/katex-display/);assert.match(html,/<table>/);assert.doesNotMatch(html,/katex-error/);
});
test('公式规范化不改写行内和围栏代码，兼容美元分隔符',()=>{
  for(const content of ['`\\(x\\)`','```latex\n\\[x\\]\n```','~~~latex\n\\(x\\)\n~~~','$x$\n\n$$y$$'])assert.equal(normalizeMath(content),content);
});
