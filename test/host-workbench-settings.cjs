'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
const base=process.env.AIDE_TEST_URL,data=process.env.AIDE_TEST_DATA;
if(!base||!data)throw Error('AIDE_TEST_URL and AIDE_TEST_DATA are required');
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({ignoreHTTPSErrors:true});
  const token=fs.readFileSync(path.join(data,'auth/access-token'),'utf8').trim();
  await context.addInitScript(({token})=>{try{localStorage.setItem('aide-token',token);}catch(_){}},{token});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,2000));
  await page.evaluate(async()=>{
    const token=localStorage.getItem('aide-token');
    const plugins=(await (await fetch('/api/plugins',{headers:{Authorization:'Bearer '+token}})).json()).plugins;
    const plugin=plugins.find(x=>x.id==='terminal');
    const api=async(p,o={})=>{const r=await fetch('/api'+p,{...o,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});if(!r.ok)throw Error('HTTP '+r.status);return r.json();};
    return window.AidePluginWorkbench.open(plugin,{api,t:x=>x,toast:x=>{},blocked:()=>false,scope:()=>'host-workbench-settings',enabled:()=>true});
  });
  const frame=page.frameLocator('iframe[title="设备终端工作台"]');
  const f=selector=>frame.locator(selector);
  await page.waitForTimeout(1500);
  const sessions=f('#sessions button.session');
  if(await sessions.count()===0)throw Error('需要一个 SSH 会话作为设置验收夹具');
  let target=null;
  for(let i=0;i<await sessions.count();i++){
    const button=sessions.nth(i);await button.click();await page.waitForTimeout(400);
    if(/SSH/.test(await f('#connection-kind').textContent().catch(()=>''))){target=button;break;}
  }
  if(!target)throw Error('需要一个 SSH 会话作为设置验收夹具');
  const oldName=await f('#connection-name').textContent();
  await f('#display-settings').click();await page.waitForTimeout(250);
  if(process.env.AIDE_TEST_EVIDENCE)await page.screenshot({path:process.env.AIDE_TEST_EVIDENCE});
  const checks={
    dialogOpen:await f('#settings-dialog').evaluate(el=>el.open),
    sshSection:await f('#set-ssh').evaluate(el=>!el.hidden),
    networkSection:await f('#set-network').evaluate(el=>!el.hidden),
    relaySection:await f('#set-relay').evaluate(el=>!el.hidden),
    displaySection:await f('#show-line-numbers').evaluate(el=>el.offsetParent!==null),
    name:await f('#set-name').inputValue(),
    host:await f('#set-host').inputValue(),
    port:await f('#set-port').inputValue(),
    username:await f('#set-username').inputValue(),
    auth:await f('#set-auth').inputValue(),
    identity:await f('#set-identity-file').inputValue(),
    x11:await f('#set-x11').isChecked(),
    controls:await f('#settings-form').evaluate(form=>[...form.querySelectorAll('input,select,button')].filter(el=>el.offsetParent!==null).length)
  };
  if(!checks.dialogOpen||!checks.sshSection||!checks.networkSection||!checks.relaySection||!checks.displaySection||!checks.name||!checks.port||!checks.username||checks.controls<18)throw Error('设置表单缺少必要字段: '+JSON.stringify(checks));
  await f('#show-line-numbers').check();
  await f('#set-name').fill(oldName+' · 设置');
  await f('#settings-save').click();await page.waitForTimeout(700);
  checks.saved=(await f('#connection-name').textContent())===oldName+' · 设置';
  checks.closed=!(await f('#settings-dialog').evaluate(el=>el.open));
  await f('#display-settings').click();await page.waitForTimeout(200);
  checks.displayPersisted=await f('#show-line-numbers').isChecked();
  await f('#show-line-numbers').uncheck();
  await f('#set-name').fill(oldName);
  await f('#settings-save').click();await page.waitForTimeout(500);
  checks.restored=(await f('#connection-name').textContent())===oldName;
  checks.errors=errors;
  console.log(JSON.stringify(checks,null,2));
  await browser.close();
  if(!checks.saved||!checks.closed||!checks.displayPersisted||!checks.restored||errors.length)process.exit(2);
})().catch(error=>{console.error(error);process.exit(1);});
