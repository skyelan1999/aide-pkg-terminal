'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),dgram=require('node:dgram');
const {Sessions}=require('../sessions');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await wait(20);}throw Error('Expected reconnect result');}
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-reconnect-')),state=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-reconnect-state-')),m=new Sessions(),ui={storageRoot:root,stateRoot:state,workbench:true};t.after(async()=>{await m.stop();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(state,{recursive:true,force:true});});return{root,state,m,ui,ai:{...ui,workbench:false}};}
test('manual reconnect reuses local session identity, private visibility, log and config across daemon restart',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'device'));
 const rec=(await f.m.create(f.ui,{kind:'local',cwd:'device',name:'Saved device',visibleToAide:false})).session;
 f.m.send(f.ui,{id:rec.id,data:"printf '\\nBEFORE_RECONNECT\\n'\r"});await until(()=>Buffer.from(f.m.poll(f.ui,{id:rec.id}).output.data,'base64').toString().includes('\r\nBEFORE_RECONNECT\r\n'));
 await assert.rejects(f.m.reconnect(f.ui,{id:rec.id}),/已经连接/);await f.m.close(f.ui,{id:rec.id});
 await assert.rejects(f.m.reconnect(f.ai,{id:rec.id,workbench:true}),/不存在/);
 const log=f.m.logs(f.ui,{id:rec.id,index:0});const prefix=Buffer.from(log.data,'base64');
 const result=await f.m.reconnect(f.ui,{id:rec.id,host:'evil.invalid',cwd:'../escape',name:'override'});
 assert.equal(result.session.id,rec.id);assert.equal(result.session.name,'Saved device');assert.equal(result.session.cwd,'device');assert.equal(result.session.createdAt,rec.createdAt);assert.equal(result.session.visibleToAide,false);assert.equal(result.session.endedAt,undefined);assert.equal(result.session.exitCode,undefined);assert.equal(f.m.list(f.ui).sessions.length,1);
 f.m.send(f.ui,{id:rec.id,data:"printf '\\nAFTER_RECONNECT\\n'\r"});await until(()=>Buffer.from(f.m.poll(f.ui,{id:rec.id}).output.data,'base64').toString().includes('\r\nAFTER_RECONNECT\r\n'));
 assert(Buffer.from(f.m.logs(f.ui,{id:rec.id,index:0}).data,'base64').subarray(0,prefix.length).equals(prefix));await f.m.close(f.ui,{id:rec.id});await f.m.stop();
 const next=new Sessions();t.after(()=>next.stop());const restored=await next.relayConnect(f.ui,{id:rec.id});assert.equal(restored.session.id,rec.id);assert.equal(next.list(f.ai).sessions.length,0);await next.close(f.ui,{id:rec.id});
});
test('TCP/UDP client reconnect and listener restart retain the same record; accepted peers cannot be dialled back',async t=>{
 const f=fixture(t),sockets=new Set();const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});s.on('data',d=>s.write(d));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const s of sockets)s.destroy();server.close();});
 const tcp=(await f.m.create(f.ui,{kind:'tcp',host:'127.0.0.1',port:server.address().port})).session;
 await f.m.close(f.ui,{id:tcp.id});assert.equal((await f.m.reconnect(f.ui,{id:tcp.id})).session.id,tcp.id);await f.m.send(f.ui,{id:tcp.id,data:'TCP_RECONNECTED'});await until(()=>Buffer.from(f.m.poll(f.ui,{id:tcp.id}).output.data,'base64').toString().includes('TCP_RECONNECTED'));await f.m.close(f.ui,{id:tcp.id});
 const udpServer=dgram.createSocket('udp4');await new Promise(r=>udpServer.bind(0,'127.0.0.1',r));udpServer.on('message',(d,r)=>udpServer.send(d,r.port,r.address));t.after(()=>udpServer.close());
 const udp=(await f.m.create(f.ui,{kind:'udp',host:'127.0.0.1',port:udpServer.address().port})).session;await f.m.close(f.ui,{id:udp.id});const rebound=(await f.m.reconnect(f.ui,{id:udp.id})).session;assert.equal(rebound.id,udp.id);assert.equal(rebound.bindPort,udp.bindPort);await f.m.send(f.ui,{id:udp.id,data:'UDP_RECONNECTED'});await until(()=>Buffer.from(f.m.poll(f.ui,{id:udp.id}).output.data,'base64').toString().includes('UDP_RECONNECTED'));await f.m.close(f.ui,{id:udp.id});
 const listener=(await f.m.create(f.ui,{kind:'tcp-server',port:0})).session;await f.m.close(f.ui,{id:listener.id});const restarted=(await f.m.reconnect(f.ui,{id:listener.id})).session;assert.equal(restarted.port,listener.port);
 const client=net.connect(listener.port,'127.0.0.1');client.on('error',()=>{});t.after(()=>client.destroy());await until(()=>f.m.list(f.ui).sessions.some(s=>s.connectionRole==='server'));const peer=f.m.list(f.ui).sessions.find(s=>s.connectionRole==='server');await f.m.close(f.ui,{id:peer.id});await assert.rejects(f.m.reconnect(f.ui,{id:peer.id}),/接入会话不能主动重连/);await f.m.close(f.ui,{id:listener.id});
});
test('failed reconnect keeps saved identity/config and logs, prevents concurrent reconnect and can be retried',async t=>{
 const f=fixture(t);let sockets=[];const server=net.createServer(s=>{sockets.push(s);s.on('error',()=>{});});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const rec=(await f.m.create(f.ui,{kind:'tcp',host:'127.0.0.1',port,name:'retry device'})).session;await f.m.close(f.ui,{id:rec.id});for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));
 const pending=f.m.reconnect(f.ui,{id:rec.id});await assert.rejects(f.m.reconnect(f.ui,{id:rec.id}),/正在连接/);await assert.rejects(pending);assert.equal(f.m.list(f.ui).sessions[0].status,'error');assert.equal(f.m.list(f.ui).sessions[0].host,'127.0.0.1');assert.equal(f.m.list(f.ui).sessions.length,1);
 await new Promise(r=>server.listen(port,'127.0.0.1',r));t.after(()=>{for(const s of sockets)s.destroy();server.close();});assert.equal((await f.m.reconnect(f.ui,{id:rec.id})).session.id,rec.id);await f.m.close(f.ui,{id:rec.id});
});
