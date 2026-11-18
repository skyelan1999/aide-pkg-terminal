'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const {wsServer:WebSocketServer} = require('playwright-core/lib/utilsBundle');

const root = path.join(__dirname,'..');
const workbench = fs.readFileSync(path.join(root,'workbench.html'));
const viewer = fs.readFileSync(path.join(root,'viewer.html'));
const ticket = 'a'.repeat(64);
const windowPath = '/plugin-viewer/'+ticket+'/window';
const socketPath = '/plugin-viewer/'+ticket+'/websockify';
const framebuffer = {width:1280,height:800};
const sessions = [
  {id:'a'.repeat(24),name:'X11 device',kind:'ssh',host:'fixture',port:22,username:'qa',cwd:'.',status:'running',x11Enabled:true,x11ViewerPort:5701},
  {id:'b'.repeat(24),name:'Other shell',kind:'local',cwd:'.',status:'running'},
];

function hostPage(mode) {
  const fixtureSessions=mode==='push'?[{...sessions[0],relayEnabled:true},sessions[1]]:sessions;
  return `<!doctype html><style>iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>
<iframe title="Terminal test frame" sandbox="allow-scripts allow-downloads" src="/workbench"></iframe>
<script>
const mode=${JSON.stringify(mode)}, sessions=${JSON.stringify(fixtureSessions)}, frame=document.querySelector('iframe');
const sharedWindow=mode?.startsWith('shared-');
window.received={viewer:[],input:[],inputArgs:[],polls:[],outputStarts:[],outputStops:[]};
window.addEventListener('message',event=>{
  if(event.source!==frame.contentWindow||event.data?.type!=='aide.workbench.ready')return;
  const channel=new MessageChannel();
  window.outputEvent=event=>channel.port1.postMessage({protocol:1,...event});
  channel.port1.onmessage=e=>{
    const {requestId,method,tool,arguments:args}=e.data;
    const result={};
    if(method==='viewer.open'||method==='window.open'){
      window.received.viewer.push({method,args});
      const sharedCall=method==='window.open';
      const wantsPopup=sharedCall ? mode==='shared-popup'&&args.view==='graphics' : mode==='popup'&&args.openInWindow===true;
      if(wantsPopup){
        window.activated=navigator.userActivation.isActive;
        const popup=window.open('about:blank','_blank','popup,width=900,height=650');
        if(popup){popup.opener=null;popup.location=${JSON.stringify(windowPath)};result.windowOpened=true;}
      }
      result.protocol=1;
      if(sharedCall){
        result.windowOpened=result.windowOpened===true;
        if(!result.windowOpened)result.fallbackUrl=mode==='shared-invalid'?'/plugin-viewer/short/websockify':${JSON.stringify(socketPath)};
      }else{
        if(mode==='blocked')result.windowOpened=false;
        result.url=${JSON.stringify(socketPath)};
      }
    } else if(method==='terminal.output.start'){
      window.received.outputStarts.push(args);
      if(mode==='push'&&window.received.outputStarts.length===1){
        const text='REMOTE-PUSH';
        window.outputEvent({event:'terminal.output',subscription:args.subscription,
          output:{id:args.id,start:0,offset:text.length,reset:false,more:false,data:btoa(text)}});
      }
    } else if(method==='terminal.output.stop'){
      window.received.outputStops.push(args);
    } else if(tool==='terminal_session_poll'){
      window.received.polls.push(args);
      result.sessions=sessions;
      result.capabilities=mode==='push'?{inputReadback:true,inputReadbackFast:true}:{};
      if(mode==='push'&&window.fallbackOutput?.id===args?.id){
        result.output=window.fallbackOutput;window.fallbackOutput=null;
      }
    } else if(tool==='terminal_session_input'){
      window.received.input.push(args.data);window.received.inputArgs.push(args);
    }
    channel.port1.postMessage({requestId,status:'result',result});
  };
  frame.contentWindow.postMessage({type:'aide.workbench.connect',protocol:1,pluginId:'terminal',
    capabilities:['bridge.renew','daemon.detach',...(mode==='legacy'?[]:['viewer.window']),
      ...(sharedWindow?['window.open']:[]),...(mode==='push'?['terminal.output']:[])],
    tools:['terminal_session_poll','terminal_session_input','terminal_session_resize']
  },'*',[channel.port2]);
},{once:false});
</script>`;
}

function mockRFB(socket) {
  const desktop=Buffer.from('Synthetic X11 desktop');
  const init=Buffer.alloc(24+desktop.length);
  init.writeUInt16BE(framebuffer.width,0);
  init.writeUInt16BE(framebuffer.height,2);
  Buffer.from([32,24,0,1,0,255,0,255,0,255,0,8,16,0,0,0]).copy(init,4);
  init.writeUInt32BE(desktop.length,20);
  desktop.copy(init,24);
  const clipboard=Buffer.from('Synthetic clipboard');
  const cut=Buffer.alloc(8+clipboard.length);
  cut[0]=3;cut.writeUInt32BE(clipboard.length,4);clipboard.copy(cut,8);
  const pixels=Buffer.alloc(16+framebuffer.width*framebuffer.height*4);
  pixels.writeUInt16BE(1,2);
  pixels.writeUInt16BE(framebuffer.width,8);
  pixels.writeUInt16BE(framebuffer.height,10);
  pixels.fill(Buffer.from([180,95,35,0]),16);
  let step=0, painted=false;
  socket.send(Buffer.from('RFB 003.008\n'));
  socket.on('message',data => {
    if(painted&&data.length===6&&data[0]===5&&(data[1]&1)){
      socket.lastPress={x:data.readUInt16BE(2),y:data.readUInt16BE(4)};
    }
    step++;
    if(step===1)socket.send(Buffer.from([1,1]));
    if(step===2)socket.send(Buffer.alloc(4));
    if(step===3)setTimeout(()=>{if(socket.readyState===1){socket.send(init);socket.send(cut);}},300);
    if(step>=4&&!painted){painted=true;socket.send(pixels);}
  });
}

async function verifyCanvas(locator) {
  await locator.waitFor();
  for(let n=0;n<20;n++){
    const drawn=await locator.evaluate(canvas=>{
      if(!canvas.width||!canvas.height)return false;
      const [red,green,blue,alpha]=canvas.getContext('2d').getImageData(1,1,1,1).data;
      return red===180&&green===95&&blue===35&&alpha===255;
    });
    if(drawn)return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('The synthetic RFB frame was not drawn');
}

async function verifyFit(canvas,screenId) {
  let bounds;
  for(let attempt=0;attempt<20;attempt++){
    bounds=await canvas.evaluate((element,id)=>{
      const canvas=element.getBoundingClientRect();
      const screen=element.ownerDocument.getElementById(id).getBoundingClientRect();
      return {
        fits:canvas.width>0&&canvas.height>0&&canvas.left>=screen.left-1&&
          canvas.top>=screen.top-1&&canvas.right<=screen.right+1&&canvas.bottom<=screen.bottom+1,
        width:canvas.width,height:canvas.height,screenWidth:screen.width,screenHeight:screen.height,
        pixelWidth:element.width,pixelHeight:element.height,
      };
    },screenId);
    if(bounds.fits)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert(bounds.fits,'the full framebuffer fits inside the viewer '+JSON.stringify(bounds));
  assert.equal(bounds.pixelWidth,framebuffer.width);
  assert.equal(bounds.pixelHeight,framebuffer.height);
  assert(Math.abs(bounds.width/bounds.height-framebuffer.width/framebuffer.height)<0.025,
    'scaling preserves the remote framebuffer aspect ratio');
}

async function verifyPointer(page,canvas,sockets) {
  const box=await canvas.boundingBox();
  assert(box,'scaled canvas is visible');
  const socket=[...sockets.clients].find(client=>client.readyState===1);
  await page.mouse.click(box.x+box.width*0.75,box.y+box.height*0.75);
  for(let n=0;n<20&&!socket.lastPress;n++)await new Promise(resolve=>setTimeout(resolve,25));
  assert(socket.lastPress,'a click reached the remote framebuffer');
  assert(Math.abs(socket.lastPress.x-framebuffer.width*0.75)<=4,'pointer x follows framebuffer scale');
  assert(Math.abs(socket.lastPress.y-framebuffer.height*0.75)<=4,'pointer y follows framebuffer scale');
}

async function verifyMode(browser,base,mode,sockets) {
  const context=await browser.newContext({viewport:{width:1440,height:960}});
  try {
    await context.addInitScript(() => {
      window.copyWrites=[];
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copyWrites.push(text)}});
    });
    const page=await context.newPage();
    page.setDefaultTimeout(8000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/?mode='+mode);
    const frame=page.frameLocator('iframe[title="Terminal test frame"]');
    const button=frame.locator('#graphical'),pane=frame.locator('#graphical-pane');
    await frame.locator('#detail-state').filter({hasText:'运行中'}).waitFor();
    assert.equal(await pane.isVisible(),false,'initial X11 session leaves viewer closed');
    assert.deepEqual(await page.evaluate(()=>window.received.viewer),[]);
    const popupMode=mode==='popup'||mode==='shared-popup';
    const popupPromise=popupMode?page.waitForEvent('popup',{timeout:4000}):null;
    await button.click();
    if(popupPromise){
      const popup=await popupPromise;
      popup.on('pageerror',error=>errors.push(error.message));
      await popup.waitForURL('**'+windowPath);
      await popup.getByText('图形已连接',{exact:true}).waitFor();
      const canvas=popup.locator('#viewer-screen canvas');
      await verifyCanvas(canvas);
      await verifyFit(canvas,'viewer-screen');
      assert.equal(await popup.evaluate(()=>window.opener===null),true);
      assert.equal(await page.evaluate(()=>window.activated),true,'parent receives live browser activation');
      assert.equal(await pane.isVisible(),false);
      await popup.locator('#viewer-copy').waitFor();
      assert.deepEqual(await popup.evaluate(()=>window.copyWrites),[],'remote clipboard is not written automatically');
      await popup.locator('#viewer-copy').click();
      assert.deepEqual(await popup.evaluate(()=>window.copyWrites),['Synthetic clipboard']);
      for(const socket of sockets.clients)socket.close(1000);
      await popup.locator('#viewer-state').filter({hasText:/已断开|连接中断/}).waitFor();
      assert.equal(await popup.locator('#viewer-screen canvas').count(),0,'disconnected window clears its framebuffer');
      assert.equal(await popup.locator('#viewer-copy').isVisible(),false,'disconnected window clears its clipboard controls');
      const closed=popup.waitForEvent('close');
      await popup.locator('#viewer-close').click().catch(error=>{if(!popup.isClosed())throw error;});
      await closed;
      assert.equal(await frame.locator('#terminal-area').isVisible(),true);
      await frame.locator('#terminal .terminal-pane:not([hidden]) .xterm-helper-textarea').press('x');
      await page.waitForFunction(()=>window.received.input.join('').includes('x'));
    } else if(mode==='shared-invalid'){
      await frame.locator('#notice span').filter({hasText:'图形窗口地址无效'}).waitFor();
      assert.equal(await pane.isVisible(),false,'invalid fallback leaves no graph pane open');
      assert.equal(sockets.clients.size,0,'invalid fallback creates no viewer connection');
    } else {
      try { await pane.waitFor(); } catch (error) {
        const notice=await frame.locator('#notice span').textContent();
        throw Error(JSON.stringify({mode,notice,viewerRequests:await page.evaluate(()=>window.received.viewer),errors}),{cause:error});
      }
      const input=frame.locator('#terminal .terminal-pane:not([hidden]) .xterm-helper-textarea');
      await input.focus();
      await pane.getByText('图形已连接',{exact:true}).waitFor();
      const canvas=pane.locator('canvas');
      await verifyCanvas(canvas);
      await verifyFit(canvas,'graphical-screen');
      assert.equal(await input.evaluate(el=>el===el.ownerDocument.activeElement),true,'viewer connection keeps keyboard focus');
      const terminal=await frame.locator('#terminal-area').boundingBox(),graphics=await pane.boundingBox();
      assert(terminal.width>200&&terminal.x+terminal.width<=graphics.x+1,'desktop panes do not overlap');
      await page.keyboard.type('probe');
      await page.waitForFunction(()=>window.received.input.join('').includes('probe'));
      await verifyPointer(page,canvas,sockets);
      const workbench=page.frames().find(value=>value.url().endsWith('/workbench'));
      await pane.locator('#graphical-copy').waitFor();
      assert.deepEqual(await workbench.evaluate(()=>window.copyWrites),[]);
      await frame.locator('#tabs button').filter({hasText:'Other shell'}).click();
      assert.equal(await pane.isVisible(),true,'switching Shell retains the independent graphical pane');
      await page.setViewportSize({width:390,height:840});
      await verifyFit(canvas,'graphical-screen');
      const mobileTerminal=await frame.locator('#terminal-area').boundingBox(),mobileGraphics=await pane.boundingBox();
      assert(mobileTerminal.height>140&&mobileTerminal.y+mobileTerminal.height<=mobileGraphics.y+1,'narrow screens stack two independent panes');
      await pane.locator('#graphical-close').click();
      assert.equal(await pane.isVisible(),false);
    }
    const expected = mode.startsWith('shared-')
      ? {method:'window.open',args:{view:'graphics',viewerPort:5701}}
      : {method:'viewer.open',args:mode==='legacy'?{port:5701}:{port:5701,openInWindow:true}};
    assert.deepEqual(await page.evaluate(()=>window.received.viewer),[expected]);
    assert.deepEqual(errors,[]);
    console.log('PASS: '+mode+' viewer');
  } finally { await context.close(); }
}

async function verifyOutputPush(browser, base) {
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  try {
    await page.goto(base+'/?mode=push');
    const frame=page.frameLocator('iframe[title="Terminal test frame"]');
    await page.waitForFunction(()=>window.received.outputStarts.length===1);
    const first=await page.evaluate(()=>window.received.outputStarts[0]);
    assert.equal(first.id,sessions[0].id);
    assert.equal(first.offset,0);
    const rows=frame.locator('.terminal-pane:not([hidden]) .xterm-rows');
    const packet=(id,start,text)=>({id,start,offset:start+Buffer.byteLength(text),reset:false,more:false,data:Buffer.from(text).toString('base64')});
    const push=async (subscription,output)=>page.evaluate(event=>window.outputEvent(event),{event:'terminal.output',subscription,output});
    const seeded=packet(first.id,0,'REMOTE-PUSH');
    await rows.filter({hasText:'REMOTE-PUSH'}).waitFor();
    const pollCount=await page.evaluate(()=>window.received.polls.filter(args=>args.id).length);
    await frame.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').press('x');
    await page.waitForFunction(()=>window.received.inputArgs.length===1);
    const typed=await page.evaluate(()=>window.received.inputArgs[0]);
    assert.equal(typed.data,'x');
    assert.equal(typed.offset,seeded.offset);
    assert.equal(typed.waitForOutput,false,'push uses immediate input ACK without fabricating an echo');
    assert.equal(await page.evaluate(()=>window.received.polls.filter(args=>args.id).length),pollCount);
    const recovered=packet(first.id,seeded.offset,'-POLL-FALLBACK');
    await page.evaluate(({subscription,output})=>{
      window.fallbackOutput=output;
      window.outputEvent({event:'terminal.output.end',subscription});
    },{subscription:first.subscription,output:recovered});
    await rows.filter({hasText:'REMOTE-PUSH-POLL-FALLBACK'}).waitFor();
    assert.equal(await page.evaluate(()=>window.received.outputStarts.length),1,'failed push does not spin-restart');
    await frame.locator('#tabs button').filter({hasText:'Other shell'}).click();
    await push(first.subscription,packet(first.id,recovered.offset,'-STALE'));
    await frame.locator('#tabs button').filter({hasText:'X11 device'}).click();
    await page.waitForFunction(()=>window.received.outputStarts.length===2);
    const second=await page.evaluate(()=>window.received.outputStarts[1]);
    assert(second.subscription>first.subscription);
    assert.equal(second.offset,recovered.offset);
    const next=packet(second.id,recovered.offset,'-NEW');
    await push(second.subscription,next);
    await rows.filter({hasText:'REMOTE-PUSH-POLL-FALLBACK-NEW'}).waitFor();
    assert(!(await rows.textContent()).includes('STALE'));
    await frame.locator('#tabs button').filter({hasText:'Other shell'}).click();
    await page.waitForFunction(()=>window.received.outputStops.length===1);
    assert.deepEqual(await page.evaluate(()=>window.received.outputStops),[{subscription:second.subscription}]);
    console.log('PASS: relay output push, scope switching and polling fallback');
  } finally { await page.close(); }
}

(async()=>{
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(url.pathname==='/workbench'){res.end(workbench);return;}
    if(url.pathname===windowPath){
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws://${req.headers.host}; sandbox allow-scripts`);
      res.end(viewer);return;
    }
    res.end(hostPage(url.searchParams.get('mode')));
  });
  const sockets=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!==socketPath){socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,mockRFB);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    const base='http://127.0.0.1:'+server.address().port;
    for(const mode of ['legacy','popup','blocked','shared-popup','shared-blocked','shared-invalid']){
      await verifyMode(browser,base,mode,sockets);
    }
    await verifyOutputPush(browser,base);
  } finally {
    await browser.close();
    for(const socket of sockets.clients)socket.terminate();
    sockets.close();server.close();
  }
})().catch(error=>{console.error(error);process.exit(1);});
