'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Sessions}=require('../sessions');
test('merged SSH API pins host keys, performs scoped SFTP, isolates handles and never records credentials',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aide-terminal-sftp-')),other=fs.mkdtempSync(path.join(os.tmpdir(),'aide-terminal-sftp-other-')),m=new Sessions();t.after(async()=>{await m.stop();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(other,{recursive:true,force:true});});
 const call=(action,args={})=>m.commCall(root,{action,arguments:args});const password='fixture-only-password',server=await call('ssh_simulate_start',{port:0,expectedPassword:password});
 const probe=await call('ssh_fingerprint',{host:'127.0.0.1',port:server.port});assert.equal(probe.verified,false);assert(probe.hostFingerprint.startsWith('SHA256:'));
 await assert.rejects(call('ssh_connect',{host:'127.0.0.1',port:server.port,username:'fixture',password}),/hostFingerprint/);
 await assert.rejects(call('ssh_connect',{host:'127.0.0.1',port:server.port,username:'fixture',password,hostFingerprint:'SHA256:'+'A'.repeat(43)}),/连接失败/);
 const client=await call('ssh_connect',{host:'127.0.0.1',port:server.port,username:'fixture',password,hostFingerprint:probe.hostFingerprint});await call('ssh_simulate_set_rule',{serverId:server.serverId,rules:[{commandMatch:'version',reply:'device-1'}]});const command=await call('ssh_exec',{connectionId:client.connectionId,command:'version'});assert.equal(command.stdout,'device-1');
 fs.writeFileSync(path.join(root,'upload.txt'),'fixture-data');await call('ssh_sftp_put',{connectionId:client.connectionId,localPath:'upload.txt',remotePath:'remote.txt'});await call('ssh_sftp_get',{connectionId:client.connectionId,remotePath:'remote.txt',localPath:'download.txt'});assert.equal(fs.readFileSync(path.join(root,'download.txt'),'utf8'),'fixture-data');
 await assert.rejects(call('ssh_sftp_get',{connectionId:client.connectionId,remotePath:'remote.txt',localPath:'../escape.txt'}),/相对路径/);fs.symlinkSync(other,path.join(root,'outside'));await assert.rejects(call('ssh_sftp_get',{connectionId:client.connectionId,remotePath:'remote.txt',localPath:'outside/escape.txt'}),/越界/);
 await assert.rejects(m.commCall(other,{action:'ssh_exec',arguments:{connectionId:client.connectionId,command:'version'}}),/工作区/);
 const events=m.communication(m.space(root)).events;assert(!JSON.stringify(events).includes(password));await call('ssh_close',{connectionId:client.connectionId});await call('ssh_simulate_stop',{serverId:server.serverId});
});
test('disabled protocol tools cannot be bypassed through shared session input or action dispatch',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aide-terminal-policy-')),m=new Sessions();t.after(async()=>{await m.stop();fs.rmSync(root,{recursive:true,force:true});});
 const context={storageRoot:root,disabledTools:['terminal_udp_send']};const rec=(await m.create(context,{kind:'udp',host:'127.0.0.1',port:9})).session;
 await assert.rejects(m.send(context,{id:rec.id,data:'must not send'}),/管理员禁用/);await assert.rejects(m.commCall(context,{action:'udp_send',arguments:{host:'127.0.0.1',port:9,data:'must not send'}}),/管理员禁用/);
});

test('SFTP simulator root is canonicalized, accepts a symlinked alias and still rejects escapes (issue #6)',t=>{
 const {sftpPathGuard,canonicalSftpRoot}=require('../communications/ssh').__test;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aide-sftp-realpath-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'aide-sftp-outside-'));
 const alias=path.join(os.tmpdir(),'aide-sftp-alias-'+process.pid+'-'+Date.now());
 t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});try{fs.rmSync(alias,{recursive:false,force:true});}catch(_){}});
 fs.symlinkSync(root,alias,'dir');
 const canonical=canonicalSftpRoot(root);assert.equal(canonicalSftpRoot(alias),canonical,'macOS /var and /private/var normalize to one root');
 const guard=sftpPathGuard(alias);
 fs.mkdirSync(path.join(root,'nested'));
 assert.equal(guard('file.txt'),path.join(canonical,'file.txt'));
 assert.equal(guard('nested/file.txt'),path.join(canonical,'nested','file.txt'));
 fs.symlinkSync(outside,path.join(root,'escape'),'dir');
 assert.throws(()=>guard('escape/secret.txt'),/越界/);
 assert.throws(()=>guard('../outside.txt'),/越界/);
});
