'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');

test('workbench send control is click-driven because the AIDE iframe sandbox has no allow-forms (issue #35)',()=>{
 for(const file of ['src/workbench.html','workbench.html']){
  const target=path.join(root,file);
  // 提取出来的运行包只有构建产物，没有 src/；源码树则两份都校验。
  if(!fs.existsSync(target))continue;
  const html=fs.readFileSync(target,'utf8');
  assert(html.includes('<button type="button" id="send-packet"'),file+' send control must not rely on native form submission');
  assert(!html.includes('<button type="submit" id="send-packet"'),file+' must not keep a submit send control');
  assert(html.includes('id="communication-send"'),file+' keeps the send form container for layout');
 }
 const source=path.join(root,'src/workbench.js');
 // 运行包内只内联 workbench.html，没有 src/；两种布局都要能校验。
 const js=fs.existsSync(source)?fs.readFileSync(source,'utf8'):fs.readFileSync(path.join(root,'workbench.html'),'utf8');
 assert(/\$\('send-packet'\)\.onclick\s*=\s*event\s*=>/.test(js),'send button has an explicit click handler');
 assert(/\$\('communication-send'\)\.onsubmit\s*=\s*event\s*=>/.test(js),'submit handler stays as a non-sandboxed fallback');
 assert(/let sendingPacket = false/.test(js),'duplicate submissions are guarded');
});
