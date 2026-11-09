'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');

test('workbench send control is click-driven because the AIDE iframe sandbox has no allow-forms (issue #35)',()=>{
 for(const file of ['src/workbench.html','workbench.html']){
  const html=fs.readFileSync(path.join(root,file),'utf8');
  assert(html.includes('<button type="button" id="send-packet"'),file+' send control must not rely on native form submission');
  assert(!html.includes('<button type="submit" id="send-packet"'),file+' must not keep a submit send control');
  assert(html.includes('id="communication-send"'),file+' keeps the send form container for layout');
 }
 const js=fs.readFileSync(path.join(root,'src/workbench.js'),'utf8');
 assert(/\$\('send-packet'\)\.onclick\s*=\s*event\s*=>/.test(js),'send button has an explicit click handler');
 assert(/\$\('communication-send'\)\.onsubmit\s*=\s*event\s*=>/.test(js),'submit handler stays as a non-sandboxed fallback');
 assert(/let sendingPacket = false/.test(js),'duplicate submissions are guarded');
});
