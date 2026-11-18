"use strict";
// Real xterm rendering + OpenSSH + optional generated Python TLS relay.
// Host bridge RPC is substituted with serialized calls and a controlled fixture delay.
const {chromium}=require('playwright'),{Sessions}=require(process.env.LATENCY_RUNTIME_ROOT?process.env.LATENCY_RUNTIME_ROOT+'/sessions':'../sessions'),{Server}=require('ssh2');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
const {StringDecoder}=require('node:string_decoder');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const echoDelay=Number(process.env.TERMINAL_LATENCY_ECHO_MS||15);
const bridgeDelay=Number(process.env.TERMINAL_LATENCY_BRIDGE_MS||12);
const browserExecutable=process.env.TERMINAL_LATENCY_CHROMIUM||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
const relayPython=process.env.TERMINAL_LATENCY_PYTHON||'python3';
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
(async()=>{
 const out=process.env.AIDE_EVIDENCE_DIR;if(!out)throw Error('Set AIDE_EVIDENCE_DIR');fs.mkdirSync(out,{recursive:true});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-latency-')),state=fs.mkdtempSync(path.join(os.tmpdir(),'ssh-latency-state-')),m=new Sessions(),ui={storageRoot:root,stateRoot:state,workbench:true};
 let remoteInput='';
 const peers=new Set(),password=crypto.randomBytes(18).toString('hex'),timers=new Set();let browser,agent;
 const host=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
 const server=new Server({hostKeys:[host]},c=>{peers.add(c);c.on('error',()=>{});c.on('close',()=>peers.delete(c));c.on('authentication',a=>a.method==='password'&&a.password===password?a.accept():a.reject(['password']));c.on('ready',()=>c.on('session',accept=>{const s=accept();s.on('pty',a=>a());s.on('window-change',a=>a?.());s.on('shell',accept=>{const stream=accept(),decoder=new StringDecoder('utf8');stream.on('error',()=>{});stream.write('LATENCY_READY\r\n');stream.on('data',data=>{const value=decoder.write(data);remoteInput+=value;const timer=setTimeout(()=>{timers.delete(timer);if(!stream.destroyed)stream.write('REMOTE['+value+']\r\n');},echoDelay);timers.add(timer);});});}));});
 const results=[],errors=[];
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({executablePath:browserExecutable,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const relay of [false,true]){
   remoteInput='';
   const args={kind:'ssh',name:relay?'Relay SSH':'Direct SSH',host:'127.0.0.1',port:server.address().port,username:'device',auth:'password'};
   if(relay)args.relay={enabled:true,host:'127.0.0.1',port:await port()};
   const rec=(await m.create(ui,args)).session;
   if(relay){const script=m.relayScript(ui,{id:rec.id}),file=path.join(root,'agent.py');fs.writeFileSync(file,Buffer.from(script.data,'base64'),{mode:0o600});agent=spawn(relayPython,[file],{stdio:['ignore','pipe','pipe']});let err='';agent.stderr.on('data',d=>err+=d);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('agent timeout '+err)),8000);agent.stdout.once('data',()=>{clearTimeout(timer);resolve();});agent.once('exit',()=>{clearTimeout(timer);reject(Error('agent exit '+err));});});await m.relayConnect(ui,{id:rec.id});}
   const page=await browser.newPage({viewport:{width:1440,height:960}});page.on('pageerror',e=>errors.push(e.message));let inFlight=0,maxInFlight=0,calls=0,probes=0,probesWhileActive=0,dropAck=false;
   await page.exposeFunction('terminalCall',async(tool,args)=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);calls++;if(tool.endsWith('_relay_status')){probes++;if(m.list(ui).sessions.some(s=>s.status==='running'))probesWhileActive++;}try{assert.equal(inFlight,1,'single-flight bridge contract');await wait(bridgeDelay);const action=tool.replace('terminal_session_',''),method={input:'send',delete:'remove',comm:'commCall',relay_script:'relayScript',relay_connect:typeof m.reconnect==='function'?'reconnect':'relayConnect',relay_status:'relayStatus'}[action]||action;const result=await m[method](ui,args);if(action==='input'&&dropAck){dropAck=false;throw Error('Fixture reply lost after accepted input');}return{status:'result',result};}finally{inFlight--;}});
   await page.exposeFunction('dropNextAck',()=>{dropAck=true;});
   await page.addInitScript(accelerate=>{if(accelerate){const interval=window.setInterval.bind(window);window.setInterval=(fn,delay,...args)=>interval(fn,delay===15000?500:delay,...args);}window.fixtureClient={connect:async()=>({capabilities:['bridge.renew','daemon.detach']}),onEvent(){},close(){},call:(tool,args)=>window.terminalCall(tool,args)};},!process.env.LATENCY_BASELINE);
   let html=process.env.LATENCY_BASELINE?execFileSync('git',['show','31f67f4:workbench.html'],{cwd:path.join(__dirname,'..'),maxBuffer:4*1024*1024,encoding:'utf8'}):fs.readFileSync(path.join(process.env.LATENCY_HTML_ROOT||path.join(__dirname,'..'),'workbench.html'),'utf8');
   html=html.replace("bridge = AideWorkbenchClient.create('terminal')","bridge = window.fixtureClient").replace(/term.open\((?:view|element)\);/,'$&window.latencyTerminal=term;');
   await page.route('https://terminal-latency.test/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('https://terminal-latency.test/');
   await page.waitForFunction(()=>!!window.latencyTerminal);await page.locator('[data-session-id="'+rec.id+'"]').click();
   const text=()=>page.evaluate(()=>{const t=window.latencyTerminal,b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString()).join('\n');});
   async function until(pattern){for(let i=0;i<300;i++){if(pattern.test(await text()))return;await wait(20);}throw Error('SSH handshake timeout '+pattern);}
   await until(/authenticity|fingerprint|password/i);await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();if(!/password/i.test(await text())){await page.keyboard.type('yes');await page.keyboard.press('Enter');await until(/password/i);}await page.keyboard.type(password);await page.keyboard.press('Enter');await until(/LATENCY_READY/);
   let reconnectVerified=false;
   const samples=[];for(const ch of 'abcdefghij'){
    await wait(90+(ch.charCodeAt(0)%5)*37);
    await page.evaluate(ch=>{window.echoStart=performance.now();window.echoLatency=null;const t=window.latencyTerminal,subscription=t.onRender(()=>{const b=t.buffer.active;for(let i=0;i<b.length;i++)if(b.getLine(i).translateToString().includes('REMOTE['+ch+']')){window.echoLatency=performance.now()-window.echoStart;subscription.dispose();break;}});},ch);
    await page.keyboard.type(ch);await page.waitForFunction(()=>window.echoLatency!==null,{},{polling:'raf',timeout:4000});samples.push(Math.round(await page.evaluate(()=>window.echoLatency)));
   }
   if(process.env.AIDE_TEST_RECONNECT){
    assert(await page.locator('#reconnect-session').isDisabled(),'running session cannot reconnect twice');
    await page.locator('#close-session').click();await page.locator('#confirm-accept').click();
    await page.waitForFunction(()=>!document.getElementById('reconnect-session').disabled);
    for(const width of [1440,390]){await page.setViewportSize({width,height:960});await page.locator('#reconnect-session').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,(relay?'relay':'direct')+'-reconnect-'+width+'.png')});assert(!(await page.locator('html').evaluate(e=>e.scrollWidth>e.clientWidth+1)),'reconnect toolbar overflow');}
    await page.setViewportSize({width:1440,height:960});await page.locator('#reconnect-session').click();
    await until(/重新连接[\s\S]*password:/i);await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus();await page.keyboard.type(password);await page.keyboard.press('Enter');
    await until(/重新连接[\s\S]*LATENCY_READY/);assert.equal(m.list(ui).sessions.length,1);assert.equal(m.list(ui).sessions[0].id,rec.id);assert(await page.locator('#reconnect-session').isDisabled());reconnectVerified=true;
   }
   let burstMs;
   if(!process.env.LATENCY_BASELINE){
    const burst='abcdefghijklmnopqrstuvwx',expected=remoteInput+burst;
    const start=performance.now();await page.keyboard.type(burst,{delay:5});
    for(let i=0;i<200&&remoteInput!==expected;i++)await wait(5);
    assert.equal(remoteInput,expected,'rapid typing reaches the remote SSH peer in order');
    burstMs=Math.round(performance.now()-start);
    const prior=remoteInput;
    const paste=process.env.TERMINAL_LATENCY_ASCII_ONLY?'0123456789'.repeat(800):'a'.repeat(4095)+'🙂雪'+'0123456789'.repeat(390);await page.evaluate(paste=>window.latencyTerminal.paste(paste),paste);await page.keyboard.type('Z');
    for(let i=0;i<200&&remoteInput!==prior+paste+'Z';i++)await wait(20);
    assert(remoteInput===prior+paste+'Z','paste and subsequent key preserve exact byte order');
    await wait(100);
    assert.equal(maxInFlight,1);assert.equal(probesWhileActive,0,'background probe cannot block active SSH');if(!process.env.AIDE_TEST_RECONNECT)assert.equal(probes,0);
    const before=remoteInput;await page.evaluate(()=>window.dropNextAck());await page.keyboard.type('Q');
    await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('不会自动重发'));
    await wait(300);assert.equal(remoteInput,before+'Q','uncertain accepted input must not be replayed');
   }
   const sorted=[...samples].sort((a,b)=>a-b);if(!process.env.LATENCY_BASELINE)assert(sorted[5]<300,'fixture median must stay below300ms');results.push({kind:relay?'ssh-relay-tls':'ssh-direct',samplesMs:samples,medianMs:(sorted[4]+sorted[5])/2,p90Ms:sorted[8],maxMs:sorted[9],burst24Ms:burstMs,bridgeCalls:calls,maxInFlight,automaticProbes:probes,probesWhileActive,reconnectVerified});
   await page.screenshot({path:path.join(out,relay?'relay-ssh.png':'direct-ssh.png')});await page.close();await m.close(ui,{id:rec.id});m.remove(ui,{id:rec.id});if(agent){const exited=new Promise(r=>agent.once('exit',r));agent.kill();await exited;agent=null;}
  }
  assert.deepEqual(errors,[]);const result={status:'PASS',baseline:!!process.env.LATENCY_BASELINE,bridgeDelayMs:bridgeDelay,remoteEchoDelayMs:echoDelay,scope:'Chromium xterm, OpenSSH, and generated Python TLS1.3 relay with a synthetic single-flight host bridge and loopback peer.',results,errors};fs.writeFileSync(path.join(out,'latency.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await browser?.close();await m.stop();if(agent&&agent.exitCode===null){const exited=new Promise(r=>agent.once('exit',r));agent.kill();await exited;}for(const timer of timers)clearTimeout(timer);for(const c of peers)c.end();server.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(state,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
