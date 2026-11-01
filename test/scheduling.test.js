'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const text=process.env.TERMINAL_SCHEDULER_BASELINE?require('node:child_process').execFileSync('git',['show','origin/main:src/workbench.js'],{encoding:'utf8'}):fs.readFileSync('src/workbench.js','utf8');
 const start=text.includes('  const requests =')?text.indexOf('  const requests ='):text.indexOf('  function enqueue(');
 const calls=[],gates=[];let inFlight=0,maxInFlight=0;
 const ctx={queueMicrotask,stopped:false,connected:true,queue:Promise.resolve(),bridge:{call:async(tool,args)=>{
  inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);assert.equal(inFlight,1);
  calls.push({tool,args});try{return await new Promise((resolve,reject)=>gates.push({resolve:value=>resolve({status:'result',result:value}),reject}));}finally{inFlight--;}
 }}};
 vm.createContext(ctx,{codeGeneration:{strings:false,wasm:false}});vm.runInContext(text.slice(start,text.indexOf('  function fail(',start))+'\nglobalThis.enqueueCall=enqueue;',ctx);
 return {ctx,calls,gates,get maxInFlight(){return maxInFlight;},call:(t,a)=>ctx.enqueueCall(t,a)};
}
test('keyboard and interrupt pass queued logs, preserving single-flight and input order',async()=>{
 const f=fixture(),first=f.call('logs',{page:0});await tick();
 const log1=f.call('logs',{page:1}),log2=f.call('logs',{page:2}),key=f.call('input',{id:'owned',data:'x'}),interrupt=f.call('input',{id:'owned',data:'\x03'});
 f.gates.shift().resolve('first');await first;await tick();
 assert.equal(f.calls[1].tool,'terminal_session_input');assert.equal(f.calls[1].args.data,'x');
 for(let i=0;i<4;i++){f.gates.shift().resolve('ok');await tick();}
 await Promise.all([log1,log2,key,interrupt]);assert.deepEqual(f.calls.filter(c=>c.tool.endsWith('_input')).map(c=>c.args.data),['x','\x03']);assert.equal(f.maxInFlight,1);
});
test('bounded input bursts allow queued background work and failures are never replayed',async()=>{
 const f=fixture(),first=f.call('logs',{page:0});await tick();
 const inputs=Array.from({length:12},(_,i)=>f.call('input',{data:String(i)}));const poll=f.call('poll',{});
 f.gates.shift().resolve('first');await first;await tick();
 for(let i=0;i<13;i++){f.gates.shift().resolve('ok');await tick();}
 await Promise.all([...inputs,poll]);const index=f.calls.findIndex(c=>c.tool.endsWith('_poll'));assert(index>0&&index<=9,'poll progresses after at most8 inputs');
 const error=new Error('ack lost'),write=f.call('input',{data:'uncertain'});const handled=write.then(()=>assert.fail('must reject'),e=>assert.equal(e,error));await tick();f.gates.shift().reject(error);await handled;
 const next=f.call('poll',{});await tick();f.gates.shift().resolve('ok');await next;assert.equal(f.calls.filter(c=>c.args.data==='uncertain').length,1);
});
test('closed workbench rejects queued work without calling the bridge',async()=>{
 const f=fixture();f.ctx.stopped=true;await assert.rejects(f.call('input',{data:'x'}),/工作台已关闭/);assert.equal(f.calls.length,0);
});
