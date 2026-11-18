'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Sessions}=require('../sessions');

test('X11 capture binds the managed display, workspace, visibility and file owner',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-capture-unit-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manager=new Sessions();
  const ui={storageRoot:root,workbench:true};
  const ai={storageRoot:root,workbench:false};
  const space=manager.space(ui);
  const first='a'.repeat(24), second='b'.repeat(24), captureId='c'.repeat(24);
  space.records.set(first,{id:first,kind:'ssh',status:'running',visibleToAide:true,x11ManagedServerId:'owned'});
  space.records.set(second,{id:second,kind:'ssh',status:'running',visibleToAide:false});
  const authority=path.join(root,'Xauthority');
  manager.xservers.list=()=>[{serverId:'owned',display:':93',status:'running',width:640,height:480}];
  manager.xservers.authorityFile=id=>id==='owned'?authority:null;
  const png=Buffer.from('89504e470d0a1a0a','hex');
  let startCalls=0;
  manager.captures.start=(dir,id,display,actualAuthority,kind)=>{
    assert.equal(id,first);
    assert.equal(display,':93');
    assert.equal(actualAuthority,authority);
    assert.equal(kind,'png');
    startCalls++;
    const file=path.join(dir,`${id}-${captureId}.png`);
    fs.writeFileSync(file,png,{mode:0o600});
    return {done:Promise.resolve({file,capture:{id:captureId}})};
  };
  await assert.rejects(manager.captureSession(ai,{id:second,action:'list'}),/不存在/);
  await assert.rejects(manager.captureSession(ai,{id:first,action:'screenshot'}),/文本参数无效/);
  await assert.rejects(manager.captureSession({...ai,disabledTools:['terminal_session_capture']},{id:first,action:'list'}),/禁用/);
  await assert.rejects(manager.captureSession(ui,{id:second,action:'screenshot'}),/内置 X Server/);

  const picture=await manager.captureSession(ai,{id:first,action:'screenshot',purpose:'检查 RViz 显示',display:':999'});
  assert.equal(picture.protocol,'plugin-tool-images-v1');
  assert.equal(picture.source.sessionId,first);
  assert.equal(picture.images[0].dataBase64,png.toString('base64'));
  assert.equal(startCalls,1);
  await assert.rejects(manager.captureSession(ai,{id:first,action:'read',captureId}),/工作台/);
  await assert.rejects(manager.captureSession(ui,{id:second,action:'read',captureId}),/读取位置无效/);
  await assert.rejects(manager.captureSession(ui,{id:first,action:'read',captureId:'../escape'}),/编号无效/);
  const part=await manager.captureSession(ui,{id:first,action:'read',captureId,offset:2});
  assert.equal(part.data,png.subarray(2).toString('base64'));
  assert.equal(part.nextOffset,png.length);
  await assert.rejects(manager.captureSession(ai,{id:second,action:'frames',captureId}),/不存在/);
  await assert.rejects(manager.captureSession(ui,{id:first,action:'frames',captureId}),/Aide 的视觉任务/);
  await assert.rejects(manager.captureSession(ai,{id:first,action:'frames',frameCount:5}),/1–4/);
  await assert.rejects(manager.captureSession(ai,{id:first,action:'frames',startMs:500,endMs:400}),/录像时间范围无效/);
  await assert.rejects(manager.captureSession(ai,{id:first,action:'frames',captureId}),/没有该录像/);
  manager.captures.frames=async (dir, session, clip, count, start, end) => {
    assert.equal(path.basename(dir),'x11-captures');
    assert.deepEqual([session,clip,count,start,end],[first,captureId,3,125,1000]);
    return {frames:[{timeMs:125}]};
  };
  assert.deepEqual(await manager.captureSession(ai,{
    id:first,action:'frames',captureId,frameCount:3,startMs:125,endMs:1000
  }),{frames:[{timeMs:125}]});
  const other=fs.mkdtempSync(path.join(root,'another-'));
  await assert.rejects(manager.captureSession({storageRoot:other,workbench:true},{id:first,action:'list'}),/不存在/);
});
