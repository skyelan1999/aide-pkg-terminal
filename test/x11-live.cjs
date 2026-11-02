'use strict';
// Explicit integration check: real Xvfb, xauth, sshd and xmessage in a disposable
// container. Run through scripts/test-x11-live.py, never on the native host.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {workspace,relayFor,until,wait}=require('./session-feature-fixture');
assert(process.env.AIDE_LIVE_X11_ROOT&&fs.existsSync('/.dockerenv'),'use the isolated real-X11 wrapper');
assert.equal(process.getuid(),1000,'exercise the normal unprivileged runtime UID');
const evidence=process.env.AIDE_EVIDENCE_DIR||'/tmp/terminal-real-x11-evidence';fs.mkdirSync(evidence,{recursive:true});
const tree=()=>execFileSync('xwininfo',['-root','-tree'],{encoding:'utf8',env:process.env});
for(const viaRelay of [false,true])test('real authenticated Xvfb + xauth + OpenSSH '+(viaRelay?'TLS relay and copied session':'direct')+' displays an actual X client',{timeout:30000},async t=>{
  const f=workspace(t),label=viaRelay?'relay':'direct',sourceRoot=process.env.AIDE_LIVE_X11_ROOT;
  for(const name of ['identity','Xauthority']){fs.copyFileSync(path.join(sourceRoot,name),path.join(f.root,name));fs.chmodSync(path.join(f.root,name),0o400);}
  const authority=path.join(f.root,'Xauthority'),beforeAuthority=fs.readFileSync(authority),authorityInode=fs.statSync(authority).ino;
  const target={host:'127.0.0.1',port:Number(process.env.AIDE_LIVE_X11_PORT),username:process.env.AIDE_LIVE_X11_USER,auth:'key',identityFile:'identity',x11Enabled:true,x11Display:process.env.DISPLAY,x11AuthorityFile:'Xauthority'};
  let id=viaRelay?(await relayFor(t,f,'ssh',target)).id:(await f.m.create(f.ui,{kind:'ssh',...target})).session.id;
  if(viaRelay)await f.m.relayConnect(f.ui,{id});
  await until(()=>/fingerprint|authenticity/.test(f.output(id)),'host key prompt');f.m.send(f.ui,{id,data:'yes\r'});
  f.m.send(f.ui,{id,data:"printf '\\nACTUAL_SSH_READY\\n'\r"});await until(()=>f.output(id).includes('\r\nACTUAL_SSH_READY\r\n'),'authenticated remote shell').catch(error=>{console.error('SSH diagnostic:',f.output(id));throw error;});
  if(viaRelay){
    const original=id,copy=(await f.m.create(f.ui,{copyFrom:id,connect:true,name:'actual X11 relay copy'})).session;id=copy.id;
    f.m.send(f.ui,{id,data:"printf '\\nACTUAL_COPY_READY\\n'\r"});await until(()=>f.output(id).includes('\r\nACTUAL_COPY_READY\r\n'));
    await f.m.close(f.ui,{id:original});assert.equal(f.m.list(f.ui).sessions.find(s=>s.id===id).status,'running');
  }
  const title='AIDE-REAL-X11-'+label;
  const command="printf '\\nFORWARDED_DISPLAY=%s\\n' \"$DISPLAY\"; xmessage -name "+title+' -title '+title+" -geometry 440x150+40+80 -buttons Close:0 'Actual "+label+" SSH X11 rendering' >/dev/null 2>&1 & AIDE_X11_PID=$!; printf 'ACTUAL_XCLIENT_STARTED\\n'\r";
  f.m.send(f.ui,{id,data:command});await until(()=>tree().includes('"'+title+'"'),'real X client window in X server tree');await wait(150);
  const windows=tree();assert(windows.includes(title));assert.match(f.output(id),/FORWARDED_DISPLAY=localhost:\d+\.0/);
  const capture=execFileSync('xwd',['-root','-silent'],{env:process.env,maxBuffer:8*1024*1024});const xwd=path.join(evidence,label+'.xwd'),png=path.join(evidence,label+'.png');fs.writeFileSync(xwd,capture);execFileSync('python3',[path.join(__dirname,'xwd-to-png.py'),xwd,png]);
  fs.writeFileSync(path.join(evidence,label+'-window-tree.txt'),windows);
  assert(fs.readFileSync(authority).equals(beforeAuthority),'OpenSSH must leave the provided authority unchanged');assert.equal(fs.statSync(authority).ino,authorityInode);
  const record={status:'pass',transport:label,clientUID:process.getuid(),realXServer:'Xvfb',realXauth:true,realSSHServer:true,realSSHClient:true,actualXClient:'xmessage',windowTitle:title,screen:{width:800,height:600},pngSHA256:crypto.createHash('sha256').update(fs.readFileSync(png)).digest('hex'),copiedSessionAfterSourceClose:viaRelay,localAuthorityMode:'0400',providedAuthorityUnchanged:true,scope:'Isolated Linux Xvfb rendering; not macOS XQuartz or user-device acceptance'};
  fs.writeFileSync(path.join(evidence,label+'-report.json'),JSON.stringify(record,null,2)+'\n');
  f.m.send(f.ui,{id,data:'kill "$AIDE_X11_PID"\r'});await until(()=>!tree().includes('"'+title+'"'),'remote client cleanup');
});
