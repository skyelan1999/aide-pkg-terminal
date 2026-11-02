'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {Sessions}=require('../sessions');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label='condition'){for(let i=0;i<200;i++){if(await fn())return;await wait(15);}throw Error('Timed out: '+label);}
function workspace(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-feature-')),state=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-feature-state-')),manager=new Sessions();const ui={storageRoot:root,stateRoot:state,workbench:true,sessionCopyVersion:1};t.after(async()=>{await manager.stop();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(state,{recursive:true,force:true});});return {root,state,m:manager,ui,ai:{...ui,workbench:false},output:id=>Buffer.from(manager.poll(ui,{id}).output.data,'base64').toString()};}
async function telnetServer(t,{echo=true,reply=true}={}){
  const peers=new Set(),records=[];let sequence=0;
  const server=net.createServer(socket=>{
    peers.add(socket);socket.on('error',()=>{});socket.on('close',()=>peers.delete(socket));
    const row={id:++sequence,wire:[],application:[],socket};records.push(row);let state='data',line=[];
    // Independent minimal server-side decoder, not the client implementation.
    socket.on('data',chunk=>{row.wire.push(chunk);for(const b of chunk){
      if(state==='iac'){if(b===255){line.push(255);row.application.push(255);state='data';}else if([251,252,253,254].includes(b))state='option';else if(b===250)state='sub';else state='data';continue;}
      if(state==='option'){state='data';continue;}if(state==='sub'){if(b===255)state='sub-iac';continue;}if(state==='sub-iac'){state=b===240?'data':'sub';continue;}
      if(b===255){state='iac';continue;}row.application.push(b);line.push(b);
      if(b===10){if(reply)socket.write('PEER '+row.id+':'+Buffer.from(line).toString());line=[];}
    }});
    const negotiation=Buffer.from([255,echo?251:252,1,255,253,31,255,253,24,255,250,24,1,255,240]);
    (async()=>{for(const b of negotiation){if(socket.destroyed)return;socket.write(Buffer.from([b]));await wait(1);}if(!socket.destroyed)socket.write('READY '+row.id+'\r\n');})();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of peers)s.destroy();await new Promise(r=>server.close(r));});
  return {server,records,port:server.address().port};
}
async function relayFor(t,f,kind,target){
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const created=await f.m.create(f.ui,{kind,...target,relay:{enabled:true,host:'127.0.0.1',port,key:crypto.randomBytes(32).toString('base64')}});const id=created.session.id;
  const space=f.m.space(f.ui),config=f.m.relayConfig(space,f.m.get(space,id,f.ui));config.listenHost='127.0.0.1';fs.writeFileSync(path.join(space.dir,id+'.relay.json'),JSON.stringify(config),{mode:0o600});
  const file=path.join(f.root,'agent.py');fs.writeFileSync(file,Buffer.from(f.m.relayScript(f.ui,{id}).data,'base64'),{mode:0o600});
  const agent=spawn(process.env.AIDE_TEST_PYTHON||'python3',[file],{stdio:['ignore','pipe','pipe']});let stderr='';agent.stderr.on('data',b=>stderr+=b);
  t.after(async()=>{if(agent.exitCode===null){const closed=new Promise(r=>agent.once('exit',r));agent.kill();await closed;}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Relay start timeout: '+stderr)),8000);agent.once('exit',()=>{clearTimeout(timer);reject(Error('Relay start failed (requires cryptography): '+stderr));});agent.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
  return {id,config,agent};
}
module.exports={workspace,telnetServer,relayFor,until,wait};
