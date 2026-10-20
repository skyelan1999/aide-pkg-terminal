'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn,spawnSync}=require('node:child_process');
const {Sessions}=require('../sessions'),{rdpFingerprint}=require('../desktop/runtime'),{target,wait}=require('./desktop-fixture.cjs');
const enabled=!!process.env.AIDE_DESKTOP_RUNTIME_ROOT;
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await wait(50);}throw Error('desktop acceptance timed out');}
async function fixture(t,kind,useRelay){const password=kind==='vnc'?'abc123':'password',remote=await target(kind,kind==='vnc'?password:undefined),root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-work-')),state=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-state-'));const m=new Sessions({desktopRuntimeRoot:process.env.AIDE_DESKTOP_RUNTIME_ROOT}),ui={storageRoot:root,stateRoot:state,workbench:true},ai={...ui,workbench:false};let agent;
 t.after(async()=>{await m.stop();if(agent&&agent.exitCode===null){const done=new Promise(r=>agent.once('exit',r));agent.kill();await done;}await remote.close();fs.rmSync(root,{recursive:true,force:true});fs.rmSync(state,{recursive:true,force:true});});
 const args={kind,host:remote.host,port:remote.port,username:'device',width:800,height:600,name:kind+' fixture',visibleToAide:true};if(kind==='rdp')args.certificateFingerprint=(await rdpFingerprint(remote)).certificateFingerprint;
 if(useRelay){const net=require('node:net'),s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));args.relay={enabled:true,host:'127.0.0.1',port,key:crypto.randomBytes(32).toString('base64')};}
 const rec=(await m.create(ui,args)).session;if(useRelay){const script=m.relayScript(ui,{id:rec.id}),file=path.join(root,'relay.py');fs.writeFileSync(file,Buffer.from(script.data,'base64'),{mode:0o600});agent=spawn('python3',[file],{stdio:['ignore','pipe','pipe']});let stderr='';agent.stderr.on('data',d=>stderr+=d);await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error(stderr)),8000);agent.stdout.once('data',()=>{clearTimeout(timer);r();});agent.once('exit',()=>{clearTimeout(timer);j(Error(stderr));});});assert.equal((await m.relayStatus(ui,{id:rec.id})).session.relayOnline,'online');}
 return{m,ui,ai,rec,root,state,remote,password};}
for(const kind of ['vnc','rdp'])for(const useRelay of [false,true])test(kind+' '+(useRelay?'Python TLS relay':'direct')+' provides real pixels, virtual mouse/keyboard, screenshot, MP4 and private media',{skip:!enabled,timeout:60000},async t=>{
 const f=await fixture(t,kind,useRelay),{m,ui,ai,rec,remote,password}=f;
 const result=await m.desktopCall(ui,{id:rec.id,action:'connect',password});assert.equal(result.session.kind,kind);assert.equal(result.session.id,rec.id);assert.equal(result.session.relayEnabled,!!useRelay||undefined);
 await m.desktopCall(ai,{id:rec.id,action:'click',x:120,y:150});await m.desktopCall(ai,{id:rec.id,action:'text',text:'abc'});await m.desktopCall(ai,{id:rec.id,action:'key',key:'Enter'});await m.desktopCall(ai,{id:rec.id,action:'key',key:'.'});await m.desktopCall(ai,{id:rec.id,action:'keydown',key:'Control'});await m.desktopCall(ai,{id:rec.id,action:'keyup',key:'Control'});await m.desktopCall(ai,{id:rec.id,action:'combo',keys:['Control','a']});await m.desktopCall(ai,{id:rec.id,action:'double_click',x:130,y:160});await m.desktopCall(ai,{id:rec.id,action:'scroll',x:130,y:160,delta:2});await m.desktopCall(ai,{id:rec.id,action:'drag',x:120,y:150,toX:200,toY:180});await until(()=>remote.events.some(e=>e.type===4&&e.x===120&&e.y===150)&&remote.events.filter(e=>e.type===2).length>=4);
 const shot=await m.desktopCall(ai,{id:rec.id,action:'capture'});assert.equal(shot.mediaType,'image/jpeg');assert(Buffer.from(shot.imageBase64,'base64').subarray(0,2).equals(Buffer.from([255,216])));assert(shot.bytes>1000);
 await assert.rejects(m.desktopCall(ai,{id:rec.id,action:'click',x:99999,y:1}),/范围/);await assert.rejects(m.desktopCall(ai,{id:rec.id,action:'key',key:'exec sh'}),/键名/);
 await m.desktopCall(ui,{id:rec.id,action:'record_start',seconds:1});await wait(1500);const video=await m.desktopCall(ai,{id:rec.id,action:'record_stop'});assert.equal(video.mediaType,'video/mp4');const page=await m.desktopCall(ai,{id:rec.id,action:'media_read',mediaId:video.id});const media=path.join(f.state,'video-fixture.mp4');fs.writeFileSync(media,Buffer.from(page.data,'base64'));assert.equal(page.more,false);const probe=spawnSync('/usr/bin/ffprobe',['-v','error','-show_entries','stream=codec_name,width,height','-of','json',media],{encoding:'utf8'});assert.equal(probe.status,0,probe.stderr);assert(JSON.parse(probe.stdout).streams.some(s=>s.codec_name==='h264'));
 m.visibility(ui,{id:rec.id,visible:false});for(const action of ['frame','click','capture','record_start','record_stop','media_list','media_read'])await assert.rejects(m.desktopCall(ai,{id:rec.id,action,x:1,y:1,mediaId:shot.id,password}),/不存在/);assert.equal(m.list(ai).sessions.length,0);assert.equal((await m.desktopCall(ui,{id:rec.id,action:'media_list'})).media.length,2);
 const saved=fs.readFileSync(path.join(m.space(ui).dir,rec.id+'.json'),'utf8');assert(!saved.includes(password));assert(!fs.existsSync(path.join(f.root,'.aide','terminal-workbench')));await m.close(ui,{id:rec.id});assert.equal(m.list(ui).sessions[0].status,'exited');
 assert.equal((await m.desktopCall(ui,{id:rec.id,action:'media_read',mediaId:shot.id})).id,shot.id);await m.desktopCall(ui,{id:rec.id,action:'media_delete',mediaId:shot.id});assert.equal((await m.desktopCall(ui,{id:rec.id,action:'connect',password})).session.id,rec.id);await m.close(ui,{id:rec.id});
});
test('desktop hidden session rejects connect/probe/trust and disabled actions cannot use generic dispatcher',{skip:!enabled},async t=>{const f=await fixture(t,'vnc',false),{m,ui,ai,rec}=f;m.visibility(ui,{id:rec.id,visible:false});await assert.rejects(m.desktopCall(ai,{action:'connect',id:rec.id,password:f.password}),/不存在/);await assert.rejects(m.desktopCall(ai,{action:'probe_rdp',id:rec.id}),/不存在/);await assert.rejects(m.desktopCall(ai,{action:'trust_rdp',id:rec.id,certificateFingerprint:'a'.repeat(64)}),/不存在/);m.visibility(ui,{id:rec.id,visible:true});const restricted={...ui,disabledTools:['terminal_desktop_connect']};await assert.rejects(m.desktopCall(restricted,{action:'connect',id:rec.id,password:f.password}),/禁用/);});
for(const kind of ['vnc','rdp'])test(kind+' rejects wrong credentials/pins and permits a clean retry without persisting secrets',{skip:!enabled,timeout:60000},async t=>{
 const {m,ui,rec,password}=await fixture(t,kind,false);
 if(kind==='rdp'){
  const original=rec.certificateFingerprint;
  await m.desktopCall(ui,{id:rec.id,action:'trust_rdp',certificateFingerprint:'a'.repeat(64)});
  await assert.rejects(m.desktopCall(ui,{id:rec.id,action:'connect',password}),/失败|退出|取消|未就绪/);
  await m.desktopCall(ui,{id:rec.id,action:'trust_rdp',certificateFingerprint:original});
 }
 await assert.rejects(m.desktopCall(ui,{id:rec.id,action:'connect',password:'wrong!'}),/失败|退出|取消|未就绪/);
 assert.equal((await m.desktopCall(ui,{id:rec.id,action:'connect',password})).session.id,rec.id);
 assert(!JSON.stringify(m.list(ui)).includes(password));
 await m.close(ui,{id:rec.id});
});
test('daemon stop during desktop authentication cancels only owned native processes',{skip:!enabled,timeout:20000},async t=>{
 const net=require('node:net'),peers=new Set(),server=net.createServer(s=>{peers.add(s);s.on('close',()=>peers.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-cancel-')),m=new Sessions({desktopRuntimeRoot:process.env.AIDE_DESKTOP_RUNTIME_ROOT}),ui={storageRoot:root,stateRoot:root,workbench:true};
 t.after(async()=>{await m.stop();for(const s of peers)s.destroy();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const rec=(await m.create(ui,{kind:'vnc',host:'127.0.0.1',port:server.address().port})).session,pending=m.desktopCall(ui,{id:rec.id,action:'connect',password:'abc123'});pending.catch(()=>{});
 const record=m.space(ui).records.get(rec.id);await until(()=>record.desktop?.client);await m.stop();await assert.rejects(pending,/取消|退出|失败|未就绪/);await until(()=>record.desktop.children.size===0);assert(record.desktop.closed);assert(!fs.existsSync(record.desktop.runDir));
});
