'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Sessions}=require('../sessions');
test('withdrawn desktop histories remain untouched and cannot hide supported terminal records',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-history-')),dir=path.join(root,'.aide','terminal-workbench');fs.mkdirSync(dir,{recursive:true,mode:0o700});const files=[];
 for(let i=1;i<=32;i++){const id=i.toString(16).padStart(24,'0'),raw=JSON.stringify({id,kind:i%2?'rdp':'vnc',status:'exited'});const file=path.join(dir,id+'.json');fs.writeFileSync(file,raw,{mode:0o600});files.push([file,raw]);}
 const id='f'.repeat(24),original={id,kind:'local',name:'retained Shell',status:'exited',cwd:'.',logging:true,createdAt:'2026-10-20T00:00:00Z'};fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(original),{mode:0o600});fs.writeFileSync(path.join(dir,id+'.log'),'preserved terminal output',{mode:0o600});
 const m=new Sessions();t.after(async()=>{await m.stop();fs.rmSync(root,{recursive:true,force:true});});assert.deepEqual(m.list(root).sessions.map(s=>s.id),[id]);for(const [file,raw]of files)assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(fs.readFileSync(path.join(dir,id+'.log'),'utf8'),'preserved terminal output');await assert.rejects(m.create(root,{kind:'rdp'}),/未知会话类型/);await assert.rejects(m.create(root,{kind:'vnc'}),/未知会话类型/);
});
