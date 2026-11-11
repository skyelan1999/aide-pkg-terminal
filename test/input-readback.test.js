'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Sessions}=require('../sessions');
function fixture(t,{echoDelay=2}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-input-readback-')),manager=new Sessions(),context={storageRoot:root,stateRoot:root,workbench:true};
 const space=manager.space(context),timers=new Set(),writes=[];
 const rec={id:'a'.repeat(24),kind:'ssh',status:'running',visibleToAide:true,logging:false,offset:0,base:0,history:Buffer.alloc(0),worker:{stdin:{writableLength:0,write(frame){const value=JSON.parse(frame);writes.push(Buffer.from(value.data,'base64'));if(echoDelay!==null){const timer=setTimeout(()=>{timers.delete(timer);manager.output(space,rec,writes.at(-1));},echoDelay);timers.add(timer);}}}}};
 space.records.set(rec.id,rec);
 t.after(async()=>{for(const timer of timers)clearTimeout(timer);space.records.clear();await manager.stop();fs.rmSync(root,{recursive:true,force:true});});
 return {manager,context,space,rec,writes};
}
test('short input ACK returns real output from the same session and supports legacy input',async t=>{
 const f=fixture(t);assert.equal(f.manager.list(f.context).capabilities.inputReadback,true);
 const result=await f.manager.send(f.context,{id:f.rec.id,data:'snow \u96ea',offset:0});
 assert.equal(result.accepted,true);assert.equal(result.output.id,f.rec.id);assert.equal(result.output.start,0);
 assert.equal(Buffer.from(result.output.data,'base64').toString(),'snow \u96ea');
 assert.equal(result.output.offset,Buffer.byteLength('snow \u96ea'));assert.equal(f.writes.length,1);
 assert.equal(f.rec.outputWaiters.size,0);
 assert.deepEqual(f.manager.send(f.context,{id:f.rec.id,data:'legacy'}),{accepted:true});
});
test('invalid readback offsets are rejected before input can execute',async t=>{
 const f=fixture(t);
 for(const offset of [-1,0.5,'0',Number.MAX_SAFE_INTEGER+1])await assert.rejects(async()=>f.manager.send(f.context,{id:f.rec.id,data:'must not send',offset}));
 assert.equal(f.writes.length,0);
});
test('no echo times out boundedly, is not synthesized or resent, and later poll sees exact bytes',async t=>{
 const f=fixture(t,{echoDelay:null}),start=performance.now();
 const result=await f.manager.send(f.context,{id:f.rec.id,data:'one shot',offset:0});
 assert(performance.now()-start<200);assert.equal(result.output.data,'');assert.equal(result.output.offset,0);assert.equal(f.writes.length,1);assert.equal(f.rec.outputWaiters.size,0);
 f.manager.output(f.space,f.rec,Buffer.from('late remote echo'));
 const polled=f.manager.poll(f.context,{id:f.rec.id,offset:0});assert.equal(Buffer.from(polled.output.data,'base64').toString(),'late remote echo');assert.equal(f.writes.length,1);
});
test('bulk input does not wait for echo and existing output can be collected without another write',async t=>{
 const f=fixture(t,{echoDelay:null});
 f.manager.output(f.space,f.rec,Buffer.from('remote'));
 const result=await f.manager.send(f.context,{id:f.rec.id,data:'X'.repeat(8192),offset:0});
 assert.equal(f.rec.outputWaiters,undefined);assert.equal(result.output.data,Buffer.from('remote').toString('base64'));assert.equal(f.writes.length,1);assert.equal(f.writes[0].length,8192);
});
test('visibility is rechecked after async input before returning output',async t=>{
 const f=fixture(t,{echoDelay:null}),ai={...f.context,workbench:false};
 const result=f.manager.send(ai,{id:f.rec.id,data:'accepted only once',offset:0});f.rec.visibleToAide=false;
 await assert.rejects(result,/不存在/);assert.equal(f.writes.length,1);assert.equal(f.rec.outputWaiters.size,0);
});
