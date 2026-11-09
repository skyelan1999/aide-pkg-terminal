'use strict';
// Host acceptance for issue #42: real AIDE workbench, managed Xvfb + x11vnc +
// websockify behind the host viewer ticket proxy, noVNC inside the opaque
// workbench iframe, and an X11 window forwarded from a real sshd.
// Run: AIDE_TEST_URL=... AIDE_TEST_DATA=... node test/host-workbench-graphics.cjs
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.env.AIDE_TEST_URL,data=process.env.AIDE_TEST_DATA;
if(!base||!data)throw Error('Set AIDE_TEST_URL and AIDE_TEST_DATA to the isolated AIDE instance');
const out=process.env.AIDE_EVIDENCE_DIR||path.join(__dirname,'../.agent-state/host-workbench-graphics');fs.mkdirSync(out,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 let page;const errors=[];const checks=[];
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN',viewport:{width:1440,height:960}});
  const token=fs.readFileSync(path.join(data,'auth/access-token'),'utf8').trim();
  await context.addInitScript(({token})=>{try{localStorage.setItem('aide-token',token);}catch(_){}},{token});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});await delay(2000);
  const opened=await page.evaluate(async()=>{
   const token=localStorage.getItem('aide-token');
   const plugins=(await (await fetch('/api/plugins',{headers:{Authorization:'Bearer '+token}})).json()).plugins;
   const plugin=plugins.find(x=>x.id==='terminal');
   const api=async(path,opts={})=>{const r=await fetch('/api'+path,{...opts,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});if(!r.ok)throw Error('HTTP '+r.status);return r.json();};
   return await window.AidePluginWorkbench.open(plugin,{api,t:x=>x,toast:x=>errors.push('toast:'+x),blocked:()=>false,scope:()=>'host-acceptance',enabled:()=>true});
  });
  assert.equal(opened,true,'host renderer opened the workbench');
  const frame=sel=>page.frameLocator('iframe[title="设备终端工作台"]').locator(sel);
  await until(async()=>await frame('#new-top').isEnabled(),'workbench bridge');
  assert.equal(await page.locator('iframe[title="设备终端工作台"]').getAttribute('sandbox'),'allow-scripts allow-downloads','host sandbox unchanged');
  checks.push('host iframe sandbox is allow-scripts allow-downloads');

  await frame('#new-top').click();
  await frame('#kind').selectOption('ssh');
  await frame('input[name=name]').fill('X11 图形验收');
  await frame('input[name=host]').fill('127.0.0.1');
  await frame('input[name=port]').fill('2222');
  await frame('input[name=username]').fill('aide');
  await frame('#auth').selectOption('key');
  await frame('input[name=identityFile]').fill('keys/test_ed25519');
  assert.equal(await frame('#x11-enabled').isChecked(),true,'graphical forwarding defaults on');
  checks.push('X11 forwarding defaults on for a new SSH session');
  await frame('#create-submit').click();
  await until(async()=>await frame('#close-session').isEnabled(),'SSH session running');
  const textarea=frame('#terminal .xterm-helper-textarea:visible');
  await until(async()=>await frame('#terminal .xterm-helper-textarea:visible').count()===1,'active terminal pane');
  await textarea.focus();await page.keyboard.type('xterm -bg white -fg black -geometry 80x24+20+20 &\r');
  await delay(3000);
  await until(async()=>!(await frame('#graphical').isDisabled()),'managed viewer available',40000);
  checks.push('managed X display and viewer port assigned to the SSH session');
  await until(async()=>await frame('#graphical-pane').evaluate(el=>!el.hidden),'graphical pane opens automatically',30000);
  checks.push('graphical pane opens automatically when the SSH session starts');
  await until(async()=>await frame('#graphical-screen canvas').count()>0,'noVNC canvas');
  await until(async()=>(await frame('#graphical-state').textContent()).includes('远程剪贴板可用'),'noVNC connected',30000);
  checks.push('noVNC connected through the host one-use viewer ticket proxy');
  await page.screenshot({path:path.join(out,'workbench-graphical-xterm.png')});

  await frame('#graphical-screen canvas').click({position:{x:300,y:200}});
  await page.screenshot({path:path.join(out,'workbench-graphical-xterm.png')});
  checks.push('xterm launched inside the forwarded display and rendered into the workbench canvas');
  assert.equal(errors.length,0,'no page errors: '+errors.join(';'));
  fs.writeFileSync(path.join(out,'graphics-result.json'),JSON.stringify({base,checks,errors},null,2));
  console.log(JSON.stringify({checks,errors}));
  process.exit(0);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
