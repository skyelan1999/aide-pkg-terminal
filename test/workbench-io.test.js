'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/workbench.js'),'utf8');
function productionFunction(name){const match=new RegExp('  (?:async )?function '+name+'\\(').exec(source);assert(match,name);const end=source.indexOf('\n  }',match.index);return source.slice(match.index,end+4);}
test('input readback and later polls render overlapping output exactly once and preserve reset semantics',()=>{
 const writes=[],frames=[],pane={offset:0,timestamps:new Map(),term:{buffer:{active:{baseY:0,cursorY:0}},write(b,cb){writes.push(Buffer.from(b));cb?.();},reset(){this.resets=(this.resets||0)+1;},writeln(){}}};
 const box={panes:new Map([['session',pane]]),bytes:b=>Buffer.from(b,'base64'),Date,Number,Math,requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},renderGutter(){}};
 vm.runInNewContext('let emptyPolls=0,interactiveUntil=0;'+productionFunction('scheduleGutter')+productionFunction('acceptOutput')+';globalThis.accept=acceptOutput;',box);
 const output=(start,text)=>({id:'session',start,data:Buffer.from(text).toString('base64'),offset:start+Buffer.byteLength(text),reset:false});
 box.accept('session',output(0,'abc'));box.accept('session',output(0,'abc'));box.accept('session',output(0,'abcdef'));box.accept('session',{...output(6,'wrong'),id:'other'});
 assert.equal(Buffer.concat(writes).toString(),'abcdef');assert.equal(pane.offset,6);assert.equal(frames.length,1,'gutter work coalesces into one animation frame');
 box.accept('session',{...output(20,'tail'),reset:true});assert.equal(pane.term.resets,1);assert.equal(pane.offset,24);
});
test('dispatch captures latest consumed offset, stays single-flight and never retries an uncertain input',async()=>{
 const calls=[],writes=[],panes=new Map([['session',{offset:12}]]);
 let active=0,max=0;
 const box={panes,requests:{input:[{tool:'input',args:{id:'session',data:'x'},resolve:v=>writes.push(v),reject:e=>writes.push(e.message)}],normal:[]},dispatching:true,inputBurst:0,inputReadback:true,stopped:false,connected:true,bridge:{async call(tool,args){active++;max=Math.max(max,active);calls.push({tool,args});active--;throw Error('ack lost after acceptance');}},Error};
 vm.runInNewContext(productionFunction('dispatch')+';globalThis.run=dispatch;',box);await box.run();assert.equal(max,1);assert.equal(calls.length,1);assert.equal(calls[0].args.offset,12);assert.deepEqual(writes,['ack lost after acceptance']);
});
