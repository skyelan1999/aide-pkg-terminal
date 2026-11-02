'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {workspace,telnetServer,relayFor,until,wait}=require('./session-feature-fixture');
test('copy creates new identity, private settings and empty history; local PTYs remain independent',async t=>{
  const f=workspace(t),source=(await f.m.create(f.ui,{kind:'local',name:'source',visibleToAide:false,cols:90,rows:25})).session;
  f.m.send(f.ui,{id:source.id,data:"printf '\\nSOURCE_ONLY\\n'\r"});await until(()=>f.output(source.id).includes('\r\nSOURCE_ONLY\r\n'));
  await assert.rejects(f.m.create(f.ai,{copyFrom:source.id}),/不存在/);
  const saved=(await f.m.create(f.ui,{copyFrom:source.id,name:'saved'})).session;
  assert.notEqual(saved.id,source.id);assert.equal(saved.status,'saved');assert.equal(saved.visibleToAide,false);assert.equal(saved.copiedFrom,source.id);assert.equal(f.output(saved.id),'');assert.deepEqual(f.m.logs(f.ui,{id:saved.id}).files,[]);
  const copy=(await f.m.create(f.ui,{copyFrom:source.id,name:'parallel',connect:true})).session;
  f.m.send(f.ui,{id:copy.id,data:"printf '\\nCOPY_ONLY\\n'\r"});await until(()=>f.output(copy.id).includes('\r\nCOPY_ONLY\r\n'));
  assert(!f.output(source.id).includes('COPY_ONLY'));assert(!f.output(copy.id).includes('SOURCE_ONLY'));
  await f.m.close(f.ui,{id:source.id});assert.equal(f.m.get(f.m.space(f.ui),copy.id,f.ui).status,'running');f.m.send(f.ui,{id:copy.id,data:"printf '\\nSTILL_ALIVE\\n'\r"});await until(()=>f.output(copy.id).includes('\r\nSTILL_ALIVE\r\n'));
});
test('direct Telnet negotiates fragmented options, resizes and copies into independent connections',async t=>{
  const f=workspace(t),server=await telnetServer(t),source=(await f.m.create(f.ui,{kind:'telnet',host:'127.0.0.1',port:server.port})).session;
  await until(()=>f.output(source.id).includes('READY 1'));assert(!Buffer.from(f.m.poll(f.ui,{id:source.id}).output.data,'base64').includes(255));
  f.m.resize(f.ui,{id:source.id,cols:255,rows:40});await until(()=>Buffer.concat(server.records[0].wire).includes(Buffer.from([255,250,31,0,255,255,0,40,255,240])),'NAWS escaped window');
  const copy=(await f.m.create(f.ui,{copyFrom:source.id,name:'other',connect:true,host:'never-contact.invalid',port:1,cwd:'../escape'})).session;await until(()=>f.output(copy.id).includes('READY 2'));
  await f.m.send(f.ui,{id:source.id,data:'alpha\r'});await f.m.send(f.ui,{id:copy.id,data:'beta\r'});
  await until(()=>f.output(source.id).includes('PEER 1:alpha'));await until(()=>f.output(copy.id).includes('PEER 2:beta'));assert(!f.output(source.id).includes('beta'));assert(!f.output(copy.id).includes('alpha'));
  await f.m.close(f.ui,{id:source.id});await f.m.send(f.ui,{id:copy.id,data:'gamma\r'});await until(()=>f.output(copy.id).includes('gamma'));
  await f.m.close(f.ui,{id:copy.id});await f.m.reconnect(f.ui,{id:copy.id});await until(()=>f.output(copy.id).includes('READY 3'));
});
test('Telnet local echo is opt-in after server refusal; default never adds secret input to output',async t=>{
  const f=workspace(t),server=await telnetServer(t,{echo:false,reply:false});
  const original=(await f.m.create(f.ui,{kind:'telnet',host:'127.0.0.1',port:server.port})).session;await until(()=>f.output(original.id).includes('READY 1'));
  await f.m.send(f.ui,{id:original.id,data:'no_local_secret'});await until(()=>Buffer.from(server.records[0].application).includes(Buffer.from('no_local_secret')));assert(!f.output(original.id).includes('no_local_secret'));
  const local=(await f.m.create(f.ui,{kind:'telnet',host:'127.0.0.1',port:server.port,telnetLocalEcho:true})).session;await until(()=>f.output(local.id).includes('READY 2'));await f.m.send(f.ui,{id:local.id,data:'explicit_echo'});assert(f.output(local.id).includes('explicit_echo'));
  server.records[1].socket.write(Buffer.from([255,251,1]));await until(()=>f.m.get(f.m.space(f.ui),local.id,f.ui).telnet.remoteEcho);await f.m.send(f.ui,{id:local.id,data:'server_echo_only'});assert(!f.output(local.id).includes('server_echo_only'));
});
test('one deployed TLS relay supports two independent Telnet copies with fragmented IAC and separate close',async t=>{
  const f=workspace(t),server=await telnetServer(t),relay=await relayFor(t,f,'telnet',{host:'127.0.0.1',port:server.port});
  await f.m.relayConnect(f.ui,{id:relay.id});await until(()=>f.output(relay.id).includes('READY 1'));
  const copy=(await f.m.create(f.ui,{copyFrom:relay.id,name:'same relay',connect:true})).session;await until(()=>f.output(copy.id).includes('READY 2'));
  assert.deepEqual(f.m.relayConfig(f.m.space(f.ui),f.m.get(f.m.space(f.ui),copy.id,f.ui)),relay.config);
  assert(!JSON.stringify(f.m.list(f.ui)).includes(relay.config.key));
  await f.m.send(f.ui,{id:relay.id,data:'relay_one\r'});await f.m.send(f.ui,{id:copy.id,data:'relay_two\r'});await until(()=>f.output(relay.id).includes('PEER 1:relay_one'));await until(()=>f.output(copy.id).includes('PEER 2:relay_two'));
  assert(!f.output(relay.id).includes('relay_two'));assert(!f.output(copy.id).includes('relay_one'));
  f.m.resize(f.ui,{id:copy.id,cols:255,rows:40});await until(()=>Buffer.concat(server.records[1].wire).includes(Buffer.from([255,250,31,0,255,255,0,40,255,240])));
  await f.m.close(f.ui,{id:relay.id});f.m.remove(f.ui,{id:relay.id});await f.m.send(f.ui,{id:copy.id,data:'after_source_deleted\r'});await until(()=>f.output(copy.id).includes('after_source_deleted'));assert.equal(relay.agent.exitCode,null);
  await f.m.close(f.ui,{id:copy.id});await f.m.reconnect(f.ui,{id:copy.id});await until(()=>f.output(copy.id).includes('READY 3'));
});
test('pending Telnet direct connection can be closed without revival; active record cannot be deleted',async t=>{
  const f=workspace(t),server=await telnetServer(t);const outcome=f.m.create(f.ui,{kind:'telnet',host:'127.0.0.1',port:server.port}).then(x=>x,error=>error);
  const rec=f.m.list(f.ui).sessions[0];assert(rec);assert.throws(()=>f.m.remove(f.ui,{id:rec.id}),/关闭/);await f.m.close(f.ui,{id:rec.id});assert.match((await outcome).message,/cancelled|stopped/);await wait(30);assert.equal(f.m.get(f.m.space(f.ui),rec.id,f.ui).worker,null);
});
test('pending TLS relay Telnet remains single-flight and cancellation closes it promptly',async t=>{
  const f=workspace(t),peers=new Set(),server=net.createServer(s=>{peers.add(s);s.on('error',()=>{});s.on('data',()=>{});s.on('close',()=>peers.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of peers)s.destroy();await new Promise(r=>server.close(r));});
  const rec=(await f.m.create(f.ui,{kind:'telnet',host:'127.0.0.1',port:23,relay:{enabled:true,host:'127.0.0.1',port:server.address().port,key:crypto.randomBytes(32).toString('base64')}})).session;
  const pending=f.m.relayConnect(f.ui,{id:rec.id}).then(x=>x,error=>error);await until(()=>f.m.get(f.m.space(f.ui),rec.id,f.ui).connectAttempt);
  assert.equal(f.m.get(f.m.space(f.ui),rec.id,f.ui).relayConnecting,true);await assert.rejects(f.m.relayConnect(f.ui,{id:rec.id}),/正在连接/);
  const start=Date.now();await f.m.close(f.ui,{id:rec.id});assert(Date.now()-start<1500);assert.match((await pending).message,/cancelled/);await until(()=>peers.size===0);assert.equal(f.m.get(f.m.space(f.ui),rec.id,f.ui).worker,null);assert.equal(f.m.get(f.m.space(f.ui),rec.id,f.ui).relayConnecting,false);
});
test('exclusive listeners copy configuration only; administrative TCP denial applies to Telnet',async t=>{
  const f=workspace(t),source=(await f.m.create(f.ui,{kind:'tcp-server',port:0})).session;await assert.rejects(f.m.create(f.ui,{copyFrom:source.id,connect:true}),/exclusive/);const copy=(await f.m.create(f.ui,{copyFrom:source.id})).session;assert.equal(copy.status,'saved');assert.equal(copy.port,source.port);assert.equal(f.m.get(f.m.space(f.ui),source.id,f.ui).status,'running');
  await assert.rejects(f.m.create({...f.ui,disabledTools:['terminal_tcp_connect']},{kind:'telnet',host:'127.0.0.1',port:23}),/disabled/);
});

for(const viaRelay of [false,true])test('Telnet '+(viaRelay?'relay':'direct')+' rejects input after send policy revocation with zero outgoing payload',async t=>{
 const f=workspace(t),server=await telnetServer(t);let id;
 if(viaRelay){id=(await relayFor(t,f,'telnet',{host:'127.0.0.1',port:server.port})).id;await f.m.relayConnect(f.ui,{id});}
 else id=(await f.m.create(f.ui,{kind:'telnet',host:'127.0.0.1',port:server.port})).session.id;
 await until(()=>f.output(id).includes('READY 1'));await wait(30);
 const size=Buffer.concat(server.records[0].wire).length;
 await assert.rejects(f.m.send({...f.ui,disabledTools:['terminal_tcp_send']},{id,data:'FORBIDDEN_SECRET'}),/sending disabled/);
 await wait(30);assert.equal(Buffer.concat(server.records[0].wire).length,size);assert.equal(server.records[0].application.length,0);assert(!f.output(id).includes('FORBIDDEN_SECRET'));
});

for(const viaRelay of [false,true])test('Telnet '+(viaRelay?'relay':'direct')+' preserves one newline when a 16KiB input boundary splits CRLF',async t=>{
 const f=workspace(t),server=await telnetServer(t);let source;
 if(viaRelay){source=(await relayFor(t,f,'telnet',{host:'127.0.0.1',port:server.port})).id;await f.m.relayConnect(f.ui,{id:source});}
 else source=(await f.m.create(f.ui,{kind:'telnet',host:'127.0.0.1',port:server.port})).session.id;
 await until(()=>f.output(source).includes('READY 1'));
 const copy=(await f.m.create(f.ui,{copyFrom:source,connect:true})).session;await until(()=>f.output(copy.id).includes('READY 2'));
 const prefix='z'.repeat(16383),expected=Buffer.from(prefix+'\r\n');await f.m.send(f.ui,{id:source,data:prefix+'\r\n'});await f.m.send(f.ui,{id:copy.id,data:prefix+'\r'});await f.m.send(f.ui,{id:copy.id,data:'\n'});
 await until(()=>server.records.every(r=>r.application.length>=expected.length));assert.deepEqual(Buffer.from(server.records[0].application),expected);assert.deepEqual(Buffer.from(server.records[1].application),expected);
});
