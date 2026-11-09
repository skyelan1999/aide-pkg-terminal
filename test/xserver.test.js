'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {XServers}=require('../xserver');
const delay=ms=>new Promise(r=>setTimeout(r,ms));

function fakeBin(root){
 const bin=path.join(root,'bin');fs.mkdirSync(bin);
 const argsFile=path.join(root,'xvfb-args.txt');
 fs.writeFileSync(path.join(bin,'xauth'),'#!/bin/sh\nprintf cookie > "$2"\n',{mode:0o755});
 fs.writeFileSync(path.join(bin,'Xvfb'),'#!/bin/sh\nprintf "%s\\n" "$@" > "$XARGS"\nexec sleep 30\n',{mode:0o755});
 const env={...process.env,PATH:bin+path.delimiter+(process.env.PATH||''),XARGS:argsFile};
 return {bin:path.join(bin,'Xvfb'),xauth:path.join(bin,'xauth'),env,argsFile};
}

test('managed X display starts Unix-only Xvfb with a private cookie and revokes it on stop (issue #40)',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aide-xserver-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const fake=fakeBin(root);const manager=new XServers({bin:fake.bin,xauth:fake.xauth,env:fake.env});
 t.after(()=>manager.stopAll());
 const server=await manager.start({width:1024,height:768,depth:24});
 assert.equal(server.display,':90');assert.equal(server.status,'running');assert.equal(manager.usage(),1);
 const internal=manager.servers.get(server.serverId);
 assert.equal(fs.statSync(internal.dir).mode&0o777,0o700,'cookie directory is private');
 assert.equal(fs.statSync(internal.cookieFile).mode&0o777,0o600,'cookie file is private');
 assert(fs.readFileSync(internal.cookieFile).length>0);
 const argv=fs.readFileSync(fake.argsFile,'utf8').trim().split('\n');
 assert.deepEqual(argv.slice(0,2),['-auth',internal.cookieFile]);
 assert(argv.includes('-nolisten')&&argv.includes('tcp'),'Xvfb must not listen on TCP');
 assert(argv.includes(':90'));
 assert(!JSON.stringify(manager.list()).includes('cookie'),'status never exposes cookie bytes');
 await manager.stop(server.serverId);
 assert.equal(manager.usage(),0);
 assert(!fs.existsSync(internal.dir),'cookie directory is removed on stop');
 await delay(700);assert(internal.process.exitCode!==null||internal.process.signalCode!==null,'Xvfb process is terminated');
});

test('managed X display rejects invalid geometry, displays and over-allocation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aide-xserver-bad-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const fake=fakeBin(root);const manager=new XServers({bin:fake.bin,xauth:fake.xauth,env:fake.env});t.after(()=>manager.stopAll());
 await assert.rejects(manager.start({width:400}),/width/);
 await assert.rejects(manager.start({depth:8}),/depth/);
 await assert.rejects(manager.start({display:':5'}),/display/);
 await assert.rejects(manager.start({display:'127.0.0.1:90'}),/display/);
 const started=[];for(let i=0;i<4;i++)started.push(await manager.start());
 await assert.rejects(manager.start(),/最多 4 个/);
 await assert.rejects(manager.stop('x-does-not-exist'),/不存在/);
});
