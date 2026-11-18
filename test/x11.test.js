'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {Server}=require('ssh2'),{prepareX11}=require('../x11');
const {Sessions}=require('../sessions');
const {workspace,relayFor,until,wait}=require('./session-feature-fixture');
const cookie='0123456789abcdef0123456789abcdef';
function xauthFixture(root){const bin=path.join(root,'bin');fs.mkdirSync(bin);const executable=path.join(bin,'xauth');fs.writeFileSync(executable,"#!/bin/sh\nprintf 'fixture/unix:0 MIT-MAGIC-COOKIE-1 "+cookie+"\\n'\n",{mode:0o700});fs.writeFileSync(path.join(root,'Xauthority'),'synthetic fixture only',{mode:0o600});return bin;}
test('X11 preflight requires explicit SSH, valid DISPLAY, executable xauth and bounded authority path',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-x11-settings-')),root=fs.realpathSync(base);try{
    const bin=xauthFixture(root),env={PATH:bin,HOME:root};
    assert.deepEqual(prepareX11({},root,env),{argv:[],env:{}});
    const args={kind:'ssh',x11Enabled:true,x11Display:'127.0.0.1:10.0',x11AuthorityFile:'Xauthority'},v=prepareX11(args,root,env);
    assert(v.argv.includes('-X'));assert(v.argv.includes('ForwardX11Trusted=no'));assert(!v.argv.includes('-Y'));assert.equal(v.env.XAUTHORITY,path.join(root,'Xauthority'));
    assert.throws(()=>prepareX11({...args,kind:'workspace'},root,env),/independent SSH/);
    for(const display of ['host:0;touch /tmp/oops','$(id):0','host:0\n','../outside:0'])assert.throws(()=>prepareX11({...args,x11Display:display},root,env),/DISPLAY/);
    assert.throws(()=>prepareX11({...args,x11AuthorityFile:'../outside'},root,env),/relative/);
    const outside=path.join(os.tmpdir(),'terminal-x11-outside-'+crypto.randomBytes(8).toString('hex'));fs.writeFileSync(outside,'secret');fs.symlinkSync(outside,path.join(root,'escape'));try{assert.throws(()=>prepareX11({...args,x11AuthorityFile:'escape'},root,env),/escapes/);}finally{fs.rmSync(outside);}
    assert.throws(()=>prepareX11(args,root,{PATH:'',HOME:root}),/xauth/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('direct and relayed workbench SSH can use trusted forwarding only to their managed display', async t=>{
  const f=workspace(t),bin=xauthFixture(f.root),previous=process.env.PATH;
  process.env.PATH=bin+path.delimiter+previous;
  t.after(()=>{process.env.PATH=previous;});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aide-terminal-x11-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const authority=path.join(directory,'Xauthority');
  fs.writeFileSync(authority,'synthetic fixture only',{mode:0o600});
  const original=f.m.xservers;
  let starts=0,stops=0,available=true;
  f.m.xservers={
    start:async()=>{starts++;if(!available)throw Error('fixture missing Xvfb');return {serverId:'x-test',display:':90',status:'running'};},
    authorityFile:()=>authority,
    stop:async()=>{stops++;},
    stopAll:()=>original.stopAll(),
  };
  const request={kind:'ssh',x11Enabled:true,x11Trusted:true,managedX11Authority:'/forged',managedX11ServerId:'fake'};
  const direct={};
  const graphics=await f.m.openSessionX11({root:f.root},direct,request,f.ui);
  assert.deepEqual(graphics.argv.slice(0,3),['-Y','-o','ForwardX11Trusted=yes']);
  assert.deepEqual(graphics.env,{DISPLAY:':90',XAUTHORITY:authority});
  assert.equal(direct.x11Display,undefined);
  assert.equal(direct.x11ManagedServerId,'x-test');
  await f.m.releaseManagedX11(direct);
  assert.equal(stops,1);
  assert.equal(direct.x11Trusted,undefined);
  assert.equal((await f.m.openSessionX11({root:f.root},{},request,{...f.ui,workbench:false})).argv[0],'-X');
  const relayed={relayEnabled:true};
  const relayedGraphics=await f.m.openSessionX11({root:f.root},relayed,request,f.ui);
  assert.deepEqual(relayedGraphics.argv.slice(0,3),['-Y','-o','ForwardX11Trusted=yes']);
  assert.equal(relayed.x11Trusted,true);
  const external={...request,x11Display:':9',x11AuthorityFile:'Xauthority'};
  const realRoot=fs.realpathSync(f.root);
  const untrusted=await f.m.openSessionX11({root:realRoot},{relayEnabled:true},external,f.ui);
  assert.equal(untrusted.argv[0],'-X');
  assert.equal(untrusted.env.XAUTHORITY,path.join(realRoot,'Xauthority'));
  const customAuthority=await f.m.openSessionX11({root:realRoot},{relayEnabled:true},{...request,x11AuthorityFile:'Xauthority'},f.ui);
  assert.equal(customAuthority.argv[0],'-X');
  assert.equal(starts,4);
  available=false;
  const failed={};
  assert.deepEqual(await f.m.openSessionX11({root:f.root},failed,request,f.ui),{argv:[],env:{}});
  assert.equal(failed.x11Unavailable,'fixture missing Xvfb');
  assert.equal(failed.x11Trusted,undefined);
  assert.equal(failed.x11Enabled,true);
  assert.deepEqual(await f.m.openSessionX11({root:f.root},{},{...request,x11Enabled:false},f.ui),{argv:[],env:{}});
});
test('legacy managed credentials are discarded while saved external settings and copies are preserved', async t=>{
  const f=workspace(t),space=f.m.space(f.ui);
  const managed={id:'a'.repeat(24),name:'managed',kind:'ssh',status:'exited',x11Enabled:true,
    x11Display:':90',x11AuthorityFile:'/tmp/aide-terminal-x11-old/Xauthority',x11ViewerPort:5990};
  const external={...managed,id:'b'.repeat(24),name:'external',x11Display:':7',x11AuthorityFile:'keys/Xauthority',x11ViewerPort:undefined};
  for(const row of [managed,external])fs.writeFileSync(path.join(space.dir,row.id+'.json'),JSON.stringify(row),{mode:0o600});
  const revived=new Sessions();
  t.after(()=>revived.stop());
  let [a,b]=revived.list(f.ui).sessions;
  assert.equal(a.x11Enabled,true);
  assert.equal(a.x11Display,undefined);
  assert.equal(a.x11AuthorityFile,undefined);
  assert.equal(a.x11ViewerPort,undefined);
  assert.equal(b.x11Display,':7');
  assert.equal(b.x11AuthorityFile,'keys/Xauthority');
  const copied=await revived.create(f.ui,{copyFrom:a.id,connect:false});
  assert.equal(copied.session.x11Enabled,true);
  assert.equal(copied.session.x11Display,undefined);
  const disk=JSON.parse(fs.readFileSync(path.join(space.dir,a.id+'.json'),'utf8'));
  assert.equal(disk.x11AuthorityFile,undefined);
  assert.equal(disk.x11Trusted,undefined);
});
function setup(info,invalid=false){const protocol=Buffer.from(info.protocol),auth=Buffer.from(invalid?'f'.repeat(String(info.cookie).length):String(info.cookie),'hex'),header=Buffer.alloc(12);header[0]=108;header.writeUInt16LE(11,2);header.writeUInt16LE(protocol.length,6);header.writeUInt16LE(auth.length,8);return Buffer.concat([header,protocol,Buffer.alloc((4-protocol.length%4)%4),auth,Buffer.alloc((4-auth.length%4)%4)]);}
async function xEndpoint(t){
  const requests=[],peers=new Set(),server=net.createServer(s=>{peers.add(s);s.on('error',()=>{});s.on('close',()=>peers.delete(s));let pending=Buffer.alloc(0);s.on('data',b=>{pending=Buffer.concat([pending,b]);if(pending.length<12)return;const pn=pending.readUInt16LE(6),an=pending.readUInt16LE(8),start=12+pn+(4-pn%4)%4;if(pending.length<start+an)return;requests.push({protocol:pending.subarray(12,12+pn).toString(),cookie:pending.subarray(start,start+an).toString('hex')});s.write('X11_FORWARDED_OK');pending=Buffer.alloc(0);});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();for(const s of peers)s.destroy();});return {requests,display:'127.0.0.1:'+(server.address().port-6000)+'.0'};
}
async function sshServer(t){
  const clients=[],records=[],host=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}}).privateKey;
  const server=new Server({hostKeys:[host]},client=>{clients.push(client);const rec={client,reply:[]};records.push(rec);client.on('error',()=>{});client.on('authentication',ctx=>ctx.method==='password'&&ctx.password==='fixture-login'?ctx.accept():ctx.reject(['password']));
    client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',accept=>accept());session.on('x11',(accept,reject,info)=>{rec.info=info;accept();});session.on('shell',accept=>{rec.shell=accept();rec.shell.write('SSH_X11_READY\r\n');rec.shell.on('data',b=>rec.shell.write('SSH_ECHO:'+b));});}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const c of clients)c.end();server.close();});
  return {port:server.address().port,records,open:(record,invalid=false)=>new Promise((resolve,reject)=>{const admission=setTimeout(()=>reject(Error('X11 channel admission timed out')),2500);record.client.x11('127.0.0.1',12345,(err,stream)=>{clearTimeout(admission);if(err)return reject(err);const timer=setTimeout(()=>{stream.destroy();if(invalid)resolve();else reject(Error('Synthetic X11 forwarding response timed out'));},invalid?500:3000);stream.on('error',()=>{});stream.on('data',b=>{clearTimeout(timer);record.reply.push(b);resolve(Buffer.concat(record.reply));});stream.on('close',()=>{clearTimeout(timer);if(invalid)resolve();else reject(Error('Synthetic X11 channel closed before response'));});stream.write(setup(record.info,invalid));});})};
}
for(const viaRelay of [false,true])test('real OpenSSH untrusted X11 '+(viaRelay?'through one TLS relay with independent SSH copy':'direct channel')+' authenticates and forwards a synthetic X11 setup',{timeout:25000},async t=>{
  const diagnostics={};try {
  const f=workspace(t),bin=xauthFixture(f.root),previous=process.env.PATH;process.env.PATH=bin+path.delimiter+previous;t.after(()=>{process.env.PATH=previous;});
  const x=await xEndpoint(t),ssh=await sshServer(t),target={host:'127.0.0.1',port:ssh.port,username:'device',auth:'password',x11Enabled:true,x11Display:x.display,x11AuthorityFile:'Xauthority'};
  const source=viaRelay?(await relayFor(t,f,'ssh',target)).id:(await f.m.create(f.ui,{kind:'ssh',...target})).session.id;
  diagnostics.output=()=>f.output(source);diagnostics.requests=()=>x.requests.length;
  if(viaRelay)await f.m.relayConnect(f.ui,{id:source});
  await until(()=>/fingerprint|authenticity/.test(f.output(source)),'host-key confirmation');f.m.send(f.ui,{id:source,data:'yes\r'});await until(()=>/password/i.test(f.output(source)));f.m.send(f.ui,{id:source,data:'fixture-login\r'});await until(()=>f.output(source).includes('SSH_X11_READY'));
  assert.equal(ssh.records[0].info.protocol,'MIT-MAGIC-COOKIE-1');assert.notEqual(String(ssh.records[0].info.cookie),cookie,'OpenSSH must substitute a spoof cookie');
  assert.match((await ssh.open(ssh.records[0])).toString(),/X11_FORWARDED_OK/);assert.deepEqual(x.requests[0],{protocol:'MIT-MAGIC-COOKIE-1',cookie});
  await ssh.open(ssh.records[0],true);await wait(50);assert.equal(x.requests.length,1,'bad remote X11 cookie must not reach local X endpoint');
  if(viaRelay){
    const copied=(await f.m.create(f.ui,{copyFrom:source,name:'independent SSH copy',connect:true})).session;await until(()=>/password/i.test(f.output(copied.id)));assert(!/authenticity/.test(f.output(copied.id)),'existing verified device identity reused, not bypassed');f.m.send(f.ui,{id:copied.id,data:'fixture-login\r'});await until(()=>f.output(copied.id).includes('SSH_X11_READY'));
    assert.equal(ssh.records.length,2);assert.match((await ssh.open(ssh.records[1])).toString(),/X11_FORWARDED_OK/);await f.m.close(f.ui,{id:source});f.m.send(f.ui,{id:copied.id,data:'after_source_close\r'});await until(()=>f.output(copied.id).includes('SSH_ECHO:after_source_close'));assert.equal(f.m.list(f.ui).sessions.find(s=>s.id===copied.id).x11Enabled,true);
  }
  assert(!JSON.stringify(f.m.list(f.ui)).includes('fixture-login'));assert(!f.output(source).includes('fixture-login'));
  // This is actual SSH/X11 cookie and byte forwarding against a synthetic X11
  // endpoint. Rendering windows in a real native X Server is a separate check.
  } catch(error){console.error('X11 fixture error:',error.message,{requests:diagnostics.requests?.(),messages:diagnostics.output?.().split('\n').filter(s=>/X11|xauth|forward/i.test(s))});throw error;}
});
