import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionActionPosition} from '../src/selection.js';

test('选区右侧空间足够时，操作按钮贴在选文右侧',()=>{
  assert.deepEqual(selectionActionPosition({left:100,right:260,top:80,bottom:100,width:160,height:20},900,600),{
    left:268,top:90,transform:'translateY(-50%)'
  });
});

test('右侧不足但左侧足够时，操作按钮贴在选文左侧',()=>{
  assert.deepEqual(selectionActionPosition({left:500,right:790,top:80,bottom:100,width:290,height:20},800,600),{
    left:492,top:90,transform:'translate(-100%, -50%)'
  });
});

test('窄屏两侧都不足且选文靠近底部时，操作按钮移到选文上方',()=>{
  assert.deepEqual(selectionActionPosition({left:8,right:352,top:540,bottom:568,width:344,height:28},360,600),{
    left:180,top:492,transform:'translateX(-50%)'
  });
});
