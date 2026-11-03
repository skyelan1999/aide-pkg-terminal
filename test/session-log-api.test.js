'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {workspace}=require('./session-feature-fixture');

test('display flags annotate only newly saved logs and read API returns bounded line/time pages',t=>{
  const f=workspace(t),space=f.m.space(f.ui),id='a'.repeat(24);
  const rec={id,kind:'ssh',name:'read fixture',host:'192.0.2.4',username:'demo',port:22,auth:'default',status:'running',logging:true,history:Buffer.alloc(0),offset:0,base:0,worker:null};
  space.records.set(id,rec);f.m.persist(space,rec);
  const raw=Buffer.from(Array.from({length:8},(_,i)=>`sample ${i+1}\r\n`).join(''));
  f.m.display(f.ui,{id,lineNumbers:true,timestamps:true});f.m.output(space,rec,raw);
  const logged=fs.readFileSync(f.m.logPath(space,id),'utf8');
  assert.match(logged,/^\[1 \d{4}-\d\d-\d\dT.*Z\] sample 1/m);
  assert.match(logged,/^\[8 \d{4}-\d\d-\d\dT.*Z\] sample 8/m);
  assert.equal(rec.history.toString(),raw.toString(),'live terminal bytes remain raw');
  const slice=f.m.read(f.ui,{id,fromLine:2,toLine:3});assert.equal(slice.firstLine,2);assert.equal(slice.lastLine,3);assert.match(slice.text,/sample 2/);assert.match(slice.text,/sample 3/);assert.equal(slice.text.split('\n').length,2);
  const page=f.m.read(f.ui,{id,fromLine:1,limit:2});assert.equal(page.hasMore,true);assert.equal(page.nextLine,3);assert.equal(page.text.split('\n').length,2);
  assert.equal(f.m.read(f.ui,{id,toLine:2}).lastLine,2);
  const firstTime=/\[(?:\d+) (\d{4}-\d\d-\d\dT[^\]]+Z)\]/.exec(logged)[1];assert.match(f.m.read(f.ui,{id,fromTime:firstTime,toTime:firstTime}).text,/sample 1/);
  f.m.configure(f.ui,{id,displayLineNumbers:false,displayTimestamps:false});assert.match(f.m.read(f.ui,{id,fromTime:firstTime,toTime:firstTime}).text,/sample 1/);
  f.m.output(space,rec,Buffer.from('later\n'));
  assert.equal(fs.readFileSync(f.m.logPath(space,id),'utf8').split('\n').at(-2),'later','disabled markers are not written');
  assert.throws(()=>f.m.read(f.ui,{id,fromLine:1,fromTime:firstTime}),/分开查询/);
});

test('configure preserves active sessions, reports reconnect needs, and stores secrets privately for SSH and X11',async t=>{
  const f=workspace(t),space=f.m.space(f.ui),id='b'.repeat(24),worker={stdin:{write(){}}};
  const rec={id,kind:'ssh',name:'ssh fixture',host:'192.0.2.5',username:'demo',port:22,auth:'default',status:'running',logging:true,history:Buffer.alloc(0),offset:0,base:0,worker,cols:100,rows:30};
  space.records.set(id,rec);f.m.persist(space,rec);
  const key=crypto.randomBytes(32).toString('base64');
  const result=f.m.configure(f.ui,{id,name:'updated',host:'192.0.2.6',displayLineNumbers:true,x11Enabled:true,x11Display:':9',x11AuthorityFile:'keys/Xauthority',relay:{enabled:true,host:'relay.example',port:17780,key}});
  assert.equal(result.requiresReconnect,true);assert.equal(rec.worker,worker);assert.equal(result.session.name,'updated');assert.equal(result.session.displayLineNumbers,true);assert.equal(JSON.stringify(result).includes(key),false);
  const relayConfig=f.m.relayConfig(space,rec);assert.equal(relayConfig.target.host,'192.0.2.6');assert.equal(relayConfig.target.x11Enabled,true);assert.equal(relayConfig.target.x11Display,':9');assert.equal(relayConfig.target.x11AuthorityFile,'keys/Xauthority');assert.equal(relayConfig.key,key);
  assert.equal((await f.m.commCall(f.ui,{action:'session_read',arguments:{id,fromLine:1}})).totalLines,0);
  assert.throws(()=>f.m.configure(f.ai,{id,visibleToAide:false}),/仅工作台/);
  assert.equal(rec.password,undefined);rec.worker=null;
});

test('configure supports Telnet options, UDP multicast and checks incompatible fields',t=>{
  const f=workspace(t),space=f.m.space(f.ui),id='c'.repeat(24);
  const telnet={id,kind:'telnet',name:'telnet fixture',host:'192.0.2.7',port:23,status:'exited',logging:true,history:Buffer.alloc(0),offset:0,base:0,worker:null};space.records.set(id,telnet);f.m.persist(space,telnet);
  const key=crypto.randomBytes(32).toString('base64');const out=f.m.configure(f.ui,{id,terminalType:'vt100',telnetLocalEcho:true,port:2323,relay:{enabled:true,host:'relay.example',port:17781,key}});
  assert.equal(out.requiresReconnect,true);const target=f.m.relayConfig(space,telnet).target;assert.equal(target.terminalType,'vt100');assert.equal(target.telnetLocalEcho,true);assert.equal(target.port,2323);
  assert.throws(()=>f.m.configure(f.ui,{id,x11Enabled:true}),/仅适用于 SSH/);
  const udpId='d'.repeat(24),udp={id:udpId,kind:'udp',name:'udp fixture',host:'127.0.0.1',port:9000,bindPort:9001,status:'exited',logging:true,history:Buffer.alloc(0),offset:0,base:0,worker:null};space.records.set(udpId,udp);f.m.persist(space,udp);
  assert.equal(f.m.configure(f.ui,{id:udpId,multicast:true,bindPort:9002}).requiresReconnect,true);
  assert.throws(()=>f.m.configure(f.ui,{id:udpId,terminalType:'xterm'}),/仅适用于 Telnet/);
});

test('manifest keeps host bridge within its 16-tool limit and exposes direct Aide APIs',()=>{
  const manifest=require('../manifest.json'),index=require('../index.js'),registered=[];
  assert(manifest.workbench.tools.length<=16);
  assert(manifest.workbench.tools.includes('terminal_session_comm'));
  const ctx={tool(definition){registered.push(definition.name);},slot(){},provide(){}};
  index.apply(ctx);
  for(const name of ['terminal_session_display','terminal_session_configure','terminal_session_read'])assert(registered.includes(name));
});
