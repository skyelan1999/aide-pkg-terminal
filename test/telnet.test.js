'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {Telnet,OPT,IAC,DO,DONT,WILL,WONT,SB,SE}=require('../telnet');
function codec(options){const wire=[],out=[];return {wire,out,value:new Telnet(b=>wire.push(Buffer.from(b)),b=>out.push(Buffer.from(b)),options)};}
test('IAC, UTF-8, CR-NUL and CR-LF survive every receive fragmentation boundary',()=>{
  const packet=Buffer.concat([Buffer.from('hello\r\n'),Buffer.from([IAC,WILL,OPT.ECHO]),Buffer.from('world\r\0'),Buffer.from([IAC,IAC]),Buffer.from(' snow: \u96ea')]);
  for(let at=0;at<=packet.length;at++){
    const f=codec();f.value.receive(packet.subarray(0,at));f.value.receive(packet.subarray(at));f.value.finish();
    assert.deepEqual(Buffer.concat(f.out),Buffer.concat([Buffer.from('hello\r\nworld\r'),Buffer.from([255]),Buffer.from(' snow: \u96ea')]),'split '+at);
    assert.deepEqual(Buffer.concat(f.wire),Buffer.from([IAC,DO,OPT.ECHO]));
  }
});
test('TTYPE negotiation and NAWS escape 255 in window size, repeated negotiations do not loop',()=>{
  const f=codec({cols:255,rows:200});f.value.start();const offered=f.wire.length;
  for(const b of [IAC,DO,OPT.NAWS,IAC,DO,OPT.TTYPE,IAC,SB,OPT.TTYPE,1,IAC,SE])f.value.receive(Buffer.from([b]));
  assert.deepEqual(f.wire[offered],Buffer.from([IAC,SB,OPT.NAWS,0,255,255,0,200,IAC,SE]));
  assert.deepEqual(f.wire.at(-1),Buffer.concat([Buffer.from([IAC,SB,OPT.TTYPE,0]),Buffer.from('xterm-256color'),Buffer.from([IAC,SE])]));
  const before=f.wire.length;for(let i=0;i<100;i++)f.value.receive(Buffer.from([IAC,DO,OPT.NAWS,IAC,DO,OPT.TTYPE]));assert.equal(f.wire.length,before);
  f.value.resize(400,255);assert.deepEqual(f.wire.at(-1),Buffer.from([IAC,SB,OPT.NAWS,1,144,0,255,255,IAC,SE]));
});
test('binary directions negotiate independently; NVT encoding and literal IAC stay exact',()=>{
  const f=codec(),input=Buffer.from([13,0,10,255]);assert.deepEqual(f.value.encode(input),Buffer.from([13,0,0,13,10,255,255]));
  f.value.receive(Buffer.from([IAC,DO,OPT.BINARY]));assert.deepEqual(f.value.encode(input),Buffer.from([13,0,10,255,255]));
  f.value.receive(Buffer.from([13]));f.value.receive(Buffer.from([IAC,WILL,OPT.BINARY,0,10,IAC,IAC]));assert.deepEqual(Buffer.concat(f.out),Buffer.from([13,0,10,255]));
});
test('unsupported options are refused without repeated reply storms; ECHO refusal clears state',()=>{
  const f=codec();for(let i=0;i<50;i++)f.value.receive(Buffer.from([IAC,DO,99,IAC,WILL,98]));assert.deepEqual(Buffer.concat(f.wire),Buffer.from([IAC,WONT,99,IAC,DONT,98]));
  f.value.receive(Buffer.from([IAC,WILL,OPT.ECHO]));assert(f.value.remoteEcho);f.value.receive(Buffer.from([IAC,WONT,OPT.ECHO]));assert(!f.value.remoteEcho);
});
test('oversized subnegotiation fails boundedly and closed codec emits no new responses',()=>{
  const f=codec();assert.throws(()=>f.value.receive(Buffer.concat([Buffer.from([IAC,SB]),Buffer.alloc(4097,42)])),/4096/);
  const g=codec();g.value.receive(Buffer.from([13]));g.value.finish();assert.deepEqual(Buffer.concat(g.out),Buffer.from([13]));const n=g.wire.length;g.value.receive(Buffer.from([IAC,DO,OPT.NAWS]));assert.equal(g.wire.length,n);
});
