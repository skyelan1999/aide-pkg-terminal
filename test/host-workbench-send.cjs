'use strict';
// Host acceptance for issue #35: real AIDE container, real iframe sandbox,
// real Go Workbench bridge. TCP/UDP peers live on the host, serial peer in-container.
// Run: AIDE_TEST_URL=... AIDE_TEST_DATA=... node test/host-workbench-send.cjs
const {chromium}=require('playwright'),net=require('node:net'),dgram=require('node:dgram');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.env.AIDE_TEST_URL,data=process.env.AIDE_TEST_DATA;
if(!base||!data)throw Error('Set AIDE_TEST_URL and AIDE_TEST_DATA to the isolated AIDE instance');
const out=process.env.AIDE_EVIDENCE_DIR||path.join(__dirname,'../.agent-state/host-workbench-send');fs.mkdirSync(out,{recursive:true});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(50);}throw Error('Timed out: '+label);}
const markers={tcp:'TCP_HOST_'+Date.now(),udp:'UDP_HOST_'+Date.now(),serial:'SERIAL_HOST_'+Date.now()};
const received={tcp:[],udp:[]};
(async()=>{
 const tcp=net.createServer(s=>{s.on('data',b=>{received.tcp.push(b.toString());s.write(b);});});
 await new Promise(r=>tcp.listen(25201,'0.0.0.0',r));
 const udp=dgram.createSocket('udp4');udp.on('message',(m,r)=>{received.udp.push(m.toString());udp.send(m,r.port,r.address);});
 await new Promise(r=>udp.bind(25202,'0.0.0.0',r));
 const serialLog=()=>{try{return fs.readFileSync(process.env.AIDE_SERIAL_PEER_LOG||'/nonexistent','utf8');}catch{return '';}};
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 let page;const errors=[];const checks=[];
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN',viewport:{width:1440,height:960}});
  const token=fs.readFileSync(path.join(data,'auth/access-token'),'utf8').trim();
  await context.addInitScript(({token})=>{try{localStorage.setItem('aide-token',token);}catch(_){}},{token});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});await delay(2000);
  // Host RC3's panel button is gated on page state; use the same host renderer
  // entry point with the instance's real token and the real /plugins API.
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
  async function create(kind,name,fill){
   await frame('#new-top').click();await frame('#kind').selectOption(kind);await frame('input[name=name]').fill(name);
   await fill();await frame('#create-submit').click();
   await until(async()=>await frame('#create-dialog').evaluate(d=>!d.open),'create '+name);
   await until(async()=>await frame('#send-packet').isVisible(),'send form '+name);
  }
  await create('tcp','host TCP',async()=>{await frame('input[name=networkHost]').fill('host.docker.internal');await frame('input[name=networkPort]').fill('25201');});
  await frame('#send-data').fill(markers.tcp);await frame('#send-packet').click();
  await until(()=>received.tcp.some(x=>x.includes(markers.tcp)),'TCP peer receives marker');
  checks.push('TCP send form delivered marker through the AIDE bridge');
  await create('udp','host UDP',async()=>{await frame('input[name=networkHost]').fill('host.docker.internal');await frame('input[name=networkPort]').fill('25202');});
  await frame('#send-data').fill(markers.udp);await frame('#send-packet').click();
  await until(()=>received.udp.some(x=>x.includes(markers.udp)),'UDP peer receives marker');
  checks.push('UDP send form delivered marker through the AIDE bridge');
  await create('serial','host serial',async()=>{await frame('#serial-port-select').selectOption('__manual__');await frame('input[name=devicePath]').fill('/tmp/ttyA');});
  await frame('#send-data').fill(markers.serial);await frame('#send-packet').click();
  await until(()=>serialLog().includes(markers.serial),'serial peer receives marker');
  checks.push('serial send form delivered marker through the AIDE bridge');
  assert.equal(errors.length,0,'no page errors: '+errors.join(';'));
  await page.screenshot({path:path.join(out,'workbench-send.png')});
  fs.writeFileSync(path.join(out,'host-send-result.json'),JSON.stringify({base,checks,markers,received,serial:serialLog(),errors},null,2));
  console.log(JSON.stringify({checks,tcpBytes:received.tcp.length,udpBytes:received.udp.length,serial:serialLog().trim()}));
  process.exit(0);
 }finally{await browser.close();tcp.close();udp.close();}
})().catch(e=>{console.error(e);process.exit(1);});
