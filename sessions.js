'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const HISTORY = 512 * 1024, PAGE = 64 * 1024, MAX_SESSIONS = 32, MAX_ACTIVE = 16;
const LOG_BYTES = 2 * 1024 * 1024, LOG_FILES = 4;
const relay=require('./relay/client');
const net=require('node:net');
const {Telnet}=require('./telnet');
const {prepareX11}=require('./x11');
const {XServers}=require('./xserver');
const {Communications,data:communicationData}=require('./communications');
const COMM_KINDS=['tcp','tcp-server','udp','serial'];
const ID = /^[a-f0-9]{24}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Error(`数字须为 ${min}–${max} 的整数`);
  return n;
}
function text(value, fallback, limit) {
  const s = value === undefined ? fallback : String(value);
  if (!s || s.length > limit || /[\x00-\x1f\x7f]/.test(s)) throw Error('文本参数无效');
  return s;
}
function privateDir(dir, protect = true) {
  try { fs.mkdirSync(dir, {mode:0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('存储目录不能是符号链接');
  if (protect) fs.chmodSync(dir, 0o700);
}
function writePrivate(file, data, append = false) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC), 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
}
function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if (!fs.fstatSync(fd).isFile()) throw Error('存储文件无效'); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
function inside(root, relative, directory = true) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('路径必须位于当前工作区内');
  const real = fs.realpathSync(path.join(root, relative));
  if (real !== root && !real.startsWith(root + path.sep)) throw Error('路径越界');
  if (directory ? !fs.statSync(real).isDirectory() : !fs.statSync(real).isFile()) throw Error('路径类型无效');
  return real;
}
class Sessions {
  constructor() { this.spaces = new Map(); this.stopping = false; this.xservers = new XServers(); }
  space(workspace) {
    const context = typeof workspace === 'object' && workspace ? workspace : null;
    workspace = context ? context.storageRoot : workspace;
    if (!workspace || !path.isAbsolute(workspace)) throw Error('此工作区需要更新配套 Aide 的 SSH 工作区支持');
    const root = fs.realpathSync(workspace);
    const cacheKey=context?.stateRoot||root;
    if (this.spaces.has(cacheKey)) { const space=this.spaces.get(cacheKey); space.remote=context?.remote;space.disabledTools=context?.disabledTools||[]; return space; }
    const state=context?.stateRoot?fs.realpathSync(context.stateRoot):root;
    const base = path.join(state, '.aide'); privateDir(base, false);
    const dir = path.join(base, 'terminal-workbench'); privateDir(dir);
    // Import legacy local state once; never overwrite private state.
    const legacy=path.join(root,'.aide','terminal-workbench');
    if(state!==root&&!fs.existsSync(path.join(dir,'migrated'))&&fs.existsSync(legacy))for(const name of fs.readdirSync(legacy)){if(!/^(?:[a-f0-9]{24}\.(?:json|log(?:\.[1-3])?)|known_hosts)$/.test(name))continue;const destination=path.join(dir,name);const oldFile=path.join(legacy,name),bytes=readPrivate(oldFile);if(!fs.existsSync(destination))writePrivate(destination,bytes);if(readPrivate(destination).equals(bytes))fs.rmSync(oldFile);}
    if(state!==root)writePrivate(path.join(dir,'migrated'),'1');
    const space = {root, dir, remote:context?.remote, disabledTools:context?.disabledTools||[], records:new Map()};
    for (const file of fs.readdirSync(dir).filter(x => /^[a-f0-9]{24}\.json$/.test(x))) {
      const rec = JSON.parse(readPrivate(path.join(dir, file)));
      if (!ID.test(rec.id) || file !== rec.id + '.json') throw Error('会话记录损坏');
      if (!['local','workspace','ssh','telnet',...COMM_KINDS].includes(rec.kind)) continue;
      if (space.records.size >= MAX_SESSIONS) break;
      if (['starting','running'].includes(rec.status)) { rec.status = 'interrupted'; rec.endedAt = new Date().toISOString(); }
      rec.worker = null; rec.history = Buffer.alloc(0); rec.base = rec.offset = 0;
      rec.logLineNumber=0;rec.logLineStart=true;
      // Restore a bounded output tail. Live processes are deliberately never auto-restarted.
      for (let i = LOG_FILES - 1; i >= 0; i--) {
        const log = this.logPath(space, rec.id, i);
        if (fs.existsSync(log)) {const bytes=readPrivate(log);rec.logLineNumber+=(bytes.toString('binary').match(/\n/g)||[]).length;if(i===0&&bytes.length)rec.logLineStart=bytes[bytes.length-1]===10;this.remember(rec,bytes.subarray(-HISTORY));}
      }
      space.records.set(rec.id, rec);
      this.persist(space, rec);
    }
    this.spaces.set(cacheKey, space);
    return space;
  }
  public(rec) {
    const {copiedFrom,x11Enabled=false,x11Display,x11AuthorityFile,x11ViewerPort,x11ManagedServerId,x11Unavailable,terminalType,telnetLocalEcho=false,connectionRole,multicast,visibleToAide=true,relayEnabled,relayEndpoint,relayOnline,relayCheckedAt,id,name,kind,host,port,username,cwd,identityFile,identitySource,auth,devicePath,baudRate,dataBits,stopBits,parity,flowControl,bindPort,resource,cols,rows,status,createdAt,endedAt,exitCode,logging,logError} = rec;
    const liveViewer=x11ManagedServerId?this.xservers.list().find(server=>server.serverId===x11ManagedServerId)?.viewer:null;
    return {copiedFrom,x11Enabled,x11Display,x11AuthorityFile,x11ViewerPort:liveViewer?.wsPort||x11ViewerPort,x11ManagedServerId,x11Unavailable,terminalType,telnetLocalEcho,copyable:rec.kind!=='tcp'||!!rec.relayEnabled||connectionRole==='client',copyConnectable:!['serial','tcp-server'].includes(rec.kind),connectionRole,multicast,reconnectable:rec.kind!=='tcp'||!!rec.relayEnabled||connectionRole==='client',visibleToAide,relayEnabled,relayEndpoint,relayOnline,relayCheckedAt,id,name,kind,host,port,username,cwd,identityFile,identitySource,auth,devicePath,baudRate,dataBits,stopBits,parity,flowControl,bindPort,resource,cols,rows,status,createdAt,endedAt,exitCode,logging,logError,displayLineNumbers:rec.displayLineNumbers===true,displayTimestamps:rec.displayTimestamps===true,displaySettingsVersion:rec.displaySettingsVersion||0};
  }
  persist(space, rec) {
    const temporary = path.join(space.dir, rec.id + '.json.tmp');
    writePrivate(temporary, JSON.stringify(this.public(rec), null, 2) + '\n');
    fs.renameSync(temporary, path.join(space.dir, rec.id + '.json'));
  }
  logPath(space, id, index = 0) { return path.join(space.dir, id + '.log' + (index ? '.' + index : '')); }
  remember(rec, buffer) {
    rec.history = Buffer.concat([rec.history, buffer]); rec.offset += buffer.length;
    if (rec.history.length > HISTORY) rec.history = rec.history.subarray(-HISTORY);
    rec.base = rec.offset - rec.history.length;
    for (const ready of rec.outputWaiters || []) ready();
  }
  logOutput(rec,buffer) {
    if(rec.logLineNumber===undefined)rec.logLineNumber=0;if(rec.logLineStart===undefined)rec.logLineStart=true;
    const annotate=rec.displayLineNumbers||rec.displayTimestamps,chunks=[];let start=0;
    for(let i=0;i<buffer.length;i++){
      if(rec.logLineStart){rec.logLineNumber++;if(annotate){const parts=[];if(rec.displayLineNumbers)parts.push(String(rec.logLineNumber));if(rec.displayTimestamps)parts.push(new Date().toISOString());chunks.push(Buffer.from('['+parts.join(' ')+'] '));}rec.logLineStart=false;}
      if(buffer[i]===10){chunks.push(buffer.subarray(start,i+1));start=i+1;rec.logLineStart=true;}
    }
    if(start<buffer.length){if(start===0&&rec.logLineStart){rec.logLineNumber++;if(annotate){const parts=[];if(rec.displayLineNumbers)parts.push(String(rec.logLineNumber));if(rec.displayTimestamps)parts.push(new Date().toISOString());chunks.push(Buffer.from('['+parts.join(' ')+'] '));}rec.logLineStart=false;}chunks.push(buffer.subarray(start));}
    return annotate?Buffer.concat(chunks):buffer;
  }
  output(space, rec, buffer) {
    const logged=this.logOutput(rec,buffer);
    if (rec.logging && !rec.logError) {
      try {
        const log = this.logPath(space, rec.id);
        if (fs.existsSync(log) && fs.lstatSync(log).size + logged.length > LOG_BYTES) {
          fs.rmSync(this.logPath(space, rec.id, LOG_FILES - 1), {force:true});
          for (let i = LOG_FILES - 2; i >= 0; i--) {
            const old = this.logPath(space, rec.id, i);
            if (fs.existsSync(old)) fs.renameSync(old, this.logPath(space, rec.id, i + 1));
          }
        }
        writePrivate(log, logged, true);
      } catch (_) {
        rec.logError = '日志写入失败，请检查存储空间与权限';
        try { this.persist(space, rec); } catch (_) { /* output remains available in memory */ }
      }
    }
    this.remember(rec, buffer);
  }
  get(space, id, workspace) {
    if (typeof id !== 'string' || !ID.test(id) || !space.records.has(id)) throw Error('此工作区中不存在该会话');
    const rec=space.records.get(id);if(workspace?.workbench!==true&&rec.visibleToAide===false)throw Error('此工作区中不存在该会话');return rec;
  }
  list(workspace) {
    const space = this.space(workspace);
    return {capabilities:{inputReadback:true,sessionCopy:workspace?.sessionCopyVersion===1},workspace:{mode:space.remote?'ssh':'local',host:space.remote?.host,path:space.remote?.path},sessions:[...space.records.values()].filter(rec=>workspace?.workbench===true||rec.visibleToAide!==false).map(rec => this.public(rec)), storage:workspace?.stateRoot?'Aide 私有会话存储（按工作区隔离）':space.remote?'Aide 数据目录 / terminal-workspaces/<工作区标识>/.aide/terminal-workbench':'.aide/terminal-workbench', limits:{sessions:MAX_SESSIONS,active:MAX_ACTIVE,logBytes:LOG_BYTES,logFiles:LOG_FILES}};
  }
  async create(workspace, args, existing) {
    if (this.stopping) throw Error('后台正在停止');
    const space = this.space(workspace);
    if(!existing&&args.copyFrom!==undefined)return this.duplicate(workspace,args);
    if (!existing && space.records.size >= MAX_SESSIONS) throw Error('最多保留32个会话，请先删除已结束的记录');
    const active = [...this.spaces.values()].flatMap(s => [...s.records.values()]).filter(r => r.worker).length;
    if (active >= MAX_ACTIVE) throw Error('最多同时运行16个会话');
    let kind = args.kind || 'local';
    if (kind === 'local' && space.remote) kind = 'workspace';
    if (!['local','ssh','workspace','telnet',...COMM_KINDS].includes(kind)) throw Error('未知会话类型');
    if(args.x11Enabled!==undefined&&typeof args.x11Enabled!=='boolean')throw Error('X11 enabled must be boolean');
    if(args.x11Enabled&&kind!=='ssh')throw Error('X11 requires an independent SSH device session');
    const cwd = text(args.cwd, '.', 512);
    if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) throw Error('目录路径必须位于当前工作区内');
    const working = space.remote ? space.root : inside(space.root, cwd);
    const cols = integer(args.cols, 100, 20, 400), rows = integer(args.rows, 30, 5, 200);
    if(args.visibleToAide===false&&workspace?.workbench!==true)throw Error('请在工作台设置会话可见性');
    const rec = existing || {visibleToAide:args.visibleToAide!==false,id:crypto.randomBytes(12).toString('hex'), kind, name:text(args.name, kind === 'ssh' ? 'SSH 设备' : '本地终端', 80), cwd, cols, rows,
      createdAt:new Date().toISOString(),status:'starting',logging:args.logging !== false,offset:0,base:0,history:Buffer.alloc(0),worker:null};
    if(args.relay?.enabled&&!existing)return this.createRelay(space,rec,args,workspace);
    if(kind==='telnet')return this.startTelnet(space,rec,args);
    if(COMM_KINDS.includes(kind))return this.startCommunication(space,rec,args);
    if(process.platform==='win32')throw Error('交互式 PTY 需要 Linux/macOS；Windows 请使用 Aide Linux 容器');
    let argv = ['/bin/bash', '--noprofile', '--norc', '-i'];
    if (kind === 'workspace') {
      if (!space.remote) throw Error('当前不是 SSH 工作区');
      const remote=space.remote, quote=value=>"'"+String(value).replace(/'/g,"'\"'\"'")+"'";
      rec.host=remote.host;rec.username=remote.username;rec.port=remote.port;
      const base=remote.path||'.', directory=cwd==='.'?base:base.replace(/\/$/,'')+'/'+cwd;
      // Borrow only the authenticated workspace master. If it disappears,
      // ProxyCommand fails closed instead of connecting with different credentials.
      argv=['ssh','-F','/dev/null','-tt','-S',remote.socket,'-o','ControlMaster=no','-o','BatchMode=yes','-o','ProxyCommand=/bin/false','-o','EscapeChar=none','-p',String(remote.port||22),'-l',remote.username,remote.host,"cd -- "+quote(directory)+" && exec /bin/bash --noprofile --norc -i"];
    }
    let identityMaterial;
    let managedX11;
    if (kind === 'ssh' && args.x11Enabled && !args.x11Display) {
      try {
        managedX11 = await this.xservers.start({ width: args.x11Width, height: args.x11Height, viewer: true });
        args = { ...args, x11Display: managedX11.display, managedX11Authority: this.xservers.authorityFile(managedX11.serverId), managedX11ServerId: managedX11.serverId };
      } catch (error) {
        // Older Aide runtimes may not ship Xvfb; keep the SSH session usable
        // and surface the missing graphical capability instead of blocking login.
        args = { ...args, x11Enabled: false, x11Unavailable: error.message };
      }
    }
    const x11=prepareX11({...args,kind},space.root);
    if(kind==='ssh'){rec.x11Enabled=!!args.x11Enabled;rec.x11Display=args.x11Display;rec.x11AuthorityFile=args.x11AuthorityFile||args.managedX11Authority;rec.x11ManagedServerId=args.managedX11ServerId;rec.x11ViewerPort=managedX11?.viewer?.wsPort;if(managedX11)rec.x11Managed=true;if(args.x11Unavailable)rec.x11Unavailable=args.x11Unavailable;}
    if (kind === 'ssh') {
      rec.host = text(args.host, '', 253);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(rec.host) && !/^[a-fA-F0-9:]+$/.test(rec.host)) throw Error('SSH 主机名无效');
      rec.username = text(args.username, '', 64);
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(rec.username)) throw Error('SSH 用户名无效');
      rec.port = integer(args.port, 22, 1, 65535);
      const known = path.join(space.dir, 'known_hosts');
      // Refuse symlinks and ensure the file exists privately before OpenSSH reads it.
      writePrivate(known, '', true);
      argv = ['ssh','-F','/dev/null','-tt','-p',String(rec.port),'-l',rec.username,
        '-o','StrictHostKeyChecking=ask','-o','UserKnownHostsFile='+known,'-o','GlobalKnownHostsFile=/dev/null',
        '-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','ConnectTimeout=15','-o','IdentitiesOnly=yes',
        '-o','EscapeChar=none','-o','ForwardAgent=no',...(args.x11Enabled?[]:['-o','ClearAllForwardings=yes'])];
      rec.auth = args.auth || 'default';
      if (!['default','password','key'].includes(rec.auth)) throw Error('认证方式无效');
      if (rec.auth === 'password') argv.push('-o','PubkeyAuthentication=no','-o','PreferredAuthentications=password,keyboard-interactive');
      if (rec.auth === 'key') argv.push('-o','PreferredAuthentications=publickey','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no');
      if (args.identityFile && rec.auth !== 'password') {
        rec.identityFile = text(args.identityFile, '', 512);
        rec.identitySource = args.identitySource || '';
        identityMaterial = typeof workspace === 'object' ? workspace.identityMaterial : undefined;
        if (identityMaterial) argv.push('-i','@AIDE_MEMORY_KEY@');
        else {
          if (rec.identitySource || space.remote) throw Error('所选私钥需要配套宿主读取');
          argv.push('-i', inside(space.root, rec.identityFile, false));
        }
      } else if (rec.auth === 'key') throw Error('请选择私钥文件');
      argv.push(...x11.argv);
      if(rec.relayEnabled){const config=this.relayConfig(space,rec);rec.relayTunnel=await relay.tunnel(config,online=>{rec.relayOnline=online?'online':'offline';});const alias=rec.port===22?rec.host:'['+rec.host+']:'+rec.port;argv[argv.indexOf('-p')+1]=String(rec.relayTunnel.port);argv.push('-o','HostKeyAlias='+alias,'-o','CheckHostIP=no','127.0.0.1');}else argv.push(rec.host);
    }
    if(this.stopping){rec.relayTunnel?.close();throw Error('Session stopped while connecting');}
    space.records.set(rec.id, rec);
    try{this.persist(space,rec);}catch(error){rec.relayTunnel?.close();rec.relayTunnel=null;if(!existing)space.records.delete(rec.id);throw error;}
    const worker = spawn('python3', ['-I', path.join(__dirname, 'pty-worker.py')], {
      cwd:working, env:{PATH:process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME:process.env.HOME || '/home/aide', LANG:'C.UTF-8', PYTHONUNBUFFERED:'1',...x11.env}, stdio:['pipe','pipe','pipe']});
    rec.worker = worker;
    worker.stdin.on('error', () => {});
    worker.stderr.on('data', () => {}); // no credentials or arbitrary helper stderr in daemon events
    let finish;
    const ready = new Promise((resolve, reject) => { finish = {resolve,reject}; });
    const timer = setTimeout(() => { worker.kill('SIGTERM'); finish.reject(Error('PTY 启动超时')); }, 15000);
    const lines = readline.createInterface({input:worker.stdout});
    lines.on('line', line => {
      if(rec.worker!==worker)return;
      try {
        if (line.length > 32768) throw Error('PTY 响应过大');
        const msg = JSON.parse(line);
        if (msg.type === 'ready') { rec.status = 'running'; this.persist(space, rec); clearTimeout(timer); finish.resolve(); }
        else if (msg.type === 'output') this.output(space, rec, Buffer.from(msg.data, 'base64'));
        else if (msg.type === 'exit') rec.exitCode = msg.code;
        else if (msg.type === 'error') { rec.status = 'error'; clearTimeout(timer); finish.reject(Error('PTY 运行失败')); }
      } catch (_) { rec.status = 'error'; worker.kill('SIGTERM'); finish.reject(Error('PTY 通信失败')); }
    });
    const end = () => {
      if(rec.worker!==worker)return;
      clearTimeout(timer); rec.worker = null;rec.relayTunnel?.close();rec.relayTunnel=null;
      if (rec.status !== 'error') rec.status = 'exited';
      rec.endedAt = new Date().toISOString();
      try { this.persist(space, rec); } catch (_) { rec.logError = '会话状态保存失败'; }
      finish.reject(Error('PTY 已退出；请检查 Python、Shell 或 SSH 是否可用'));
    };
    worker.once('error', end); worker.once('close', end);
    worker.stdin.write(JSON.stringify({cwd:working, argv, cols, rows, identityMaterial})+'\n');
    await ready;
    return {session:this.public(rec)};
  }
  async duplicate(workspace,args){
    const space=this.space(workspace),source=this.get(space,args.copyFrom,workspace);
    if(space.records.size>=MAX_SESSIONS)throw Error('Session limit reached');
    if(typeof args.connect!=='undefined'&&typeof args.connect!=='boolean')throw Error('connect must be boolean');
    if(!this.public(source).copyable)throw Error('An accepted TCP peer cannot be duplicated as an outbound connection');
    if(args.connect&&!this.public(source).copyConnectable)throw Error('Copy settings only for exclusive serial/listener resources');
    const rec={};
    for(const key of ['kind','cwd','cols','rows','logging','visibleToAide','host','port','username','identityFile','identitySource','auth','devicePath','baudRate','dataBits','stopBits','parity','flowControl','bindPort','multicast','connectionRole','terminalType','telnetLocalEcho','x11Enabled','x11Display','x11AuthorityFile'])if(source[key]!==undefined)rec[key]=source[key];
    Object.assign(rec,{id:crypto.randomBytes(12).toString('hex'),copiedFrom:source.id,name:text(args.name,(source.name.slice(0,70)+' copy'),80),createdAt:new Date().toISOString(),status:'saved',history:Buffer.alloc(0),base:0,offset:0,worker:null});
    if(rec.kind==='udp')rec.bindPort=0;
    try{
      if(source.relayEnabled){const config=this.relayConfig(space,source);writePrivate(path.join(space.dir,rec.id+'.relay.json'),JSON.stringify(config));Object.assign(rec,{relayEnabled:true,relayEndpoint:source.relayEndpoint,relayOnline:'unknown'});}
      space.records.set(rec.id,rec);this.persist(space,rec);
    }catch(error){space.records.delete(rec.id);fs.rmSync(path.join(space.dir,rec.id+'.relay.json'),{force:true});throw error;}
    if(args.connect)return this.reconnect(workspace,{id:rec.id});
    return {session:this.public(rec)};
  }
  async startTelnet(space,rec,args){
    if(space.disabledTools?.includes('terminal_tcp_connect'))throw Error('TCP connections disabled by administrator');
    rec.host=text(args.host,'127.0.0.1',253);rec.port=integer(args.port,23,1,65535);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(rec.host)&&!/^[a-fA-F0-9:]+$/.test(rec.host))throw Error('Invalid Telnet host');
    rec.terminalType=text(args.terminalType,'xterm-256color',64);
    if(!/^[A-Za-z0-9_.+-]+$/.test(rec.terminalType))throw Error('Invalid Telnet terminal type');
    if(args.telnetLocalEcho!==undefined&&typeof args.telnetLocalEcho!=='boolean')throw Error('Telnet local echo must be boolean');
    rec.telnetLocalEcho=args.telnetLocalEcho===true;
    const attempt={cancelled:false,controller:new AbortController()},finish={};
    attempt.done=new Promise(resolve=>{finish.resolve=resolve;});rec.connectAttempt=attempt;
    rec.status='starting';rec.worker={};space.records.set(rec.id,rec);
    let socket;
    rec.transport={close:async()=>{attempt.cancelled=true;attempt.controller.abort();socket?.destroy();await attempt.done;}};
    try{
      this.persist(space,rec);
      if(rec.relayEnabled){socket=await relay.open(this.relayConfig(space,rec),'open',{signal:attempt.controller.signal});rec.relayOnline='online';}
      else socket=await new Promise((resolve,reject)=>{
        const value=net.createConnection({host:rec.host,port:rec.port});socket=value;
        const abort=()=>value.destroy(Error('Telnet connection cancelled'));
        attempt.controller.signal.addEventListener('abort',abort,{once:true});
        const cleanup=()=>attempt.controller.signal.removeEventListener('abort',abort);
        value.setTimeout(15000,()=>value.destroy(Error('Telnet connection timed out')));
        value.once('connect',()=>{cleanup();value.setTimeout(0);resolve(value);});value.once('error',error=>{cleanup();reject(error);});
      });
      if(attempt.cancelled||this.stopping||!space.records.has(rec.id)){socket.destroy();throw Error('Session stopped while connecting');}
      socket.setNoDelay(true);rec.telnetSocket=socket;rec.telnetInputCR=false;rec.status='running';delete rec.endedAt;delete rec.exitCode;
      rec.telnet=new Telnet(data=>{if(socket.writableLength>65536){socket.destroy(Error('Telnet negotiation queue full'));return;}socket.write(data);},data=>{if(rec.telnetSocket===socket)this.output(space,rec,data);},{cols:rec.cols,rows:rec.rows,terminal:rec.terminalType});
      socket.on('data',data=>{if(rec.telnetSocket!==socket)return;try{rec.telnet.receive(data);}catch(error){socket.destroy(error);}});
      socket.on('error',()=>{if(rec.telnetSocket===socket)rec.status='error';});
      socket.on('close',()=>{if(rec.telnetSocket!==socket)return;rec.telnet.finish();rec.telnet=null;rec.telnetSocket=null;rec.worker=null;if(rec.status!=='error')rec.status='exited';rec.endedAt=new Date().toISOString();if(space.records.has(rec.id))try{this.persist(space,rec);}catch(_){rec.logError='Session state save failed';}});
      rec.transport={close:()=>new Promise(resolve=>{if(socket.closed)return resolve();socket.once('close',resolve);socket.destroy();})};
      this.persist(space,rec);rec.telnet.start();socket.resume();return {session:this.public(rec)};
    }catch(error){socket?.destroy();rec.status=attempt.cancelled?'exited':'error';rec.endedAt=new Date().toISOString();rec.worker=null;rec.transport=null;if(space.records.has(rec.id))this.persist(space,rec);throw error;}
    finally{if(rec.connectAttempt===attempt)delete rec.connectAttempt;finish.resolve();}
  }
  async sendTelnet(space,rec,args){
    if(space.disabledTools?.includes('terminal_tcp_send'))throw Error('TCP sending disabled by administrator');
    const original=communicationData(args.data,args.format||'utf8');
    if(rec.telnetSocket.writableLength>65536)throw Error('Telnet send queue full; verify before retrying');
    let data=original;
    if(args.format==='hex')rec.telnetInputCR=false;
    else{
      let text=original.toString('utf8');const source=text;
      if(rec.telnetInputCR&&text.startsWith('\n'))text=text.slice(1);
      if(source.length)rec.telnetInputCR=source.endsWith('\r');
      data=Buffer.from(text.replace(/\r(?!\n)/g,'\r\n'));
    }
    const wire=rec.telnet.encode(data);
    if(rec.telnetLocalEcho&&!rec.telnet.remoteEcho)this.output(space,rec,data);
    await new Promise((resolve,reject)=>rec.telnetSocket.write(wire,error=>error?reject(error):resolve()));
    return {bytesWritten:original.length};
  }
  pinWorkspaceSocket(space,remote) {
    // Manual reconnect may receive the host's live control path rather than the
    // inode-pinned path supplied on initial creation. Freeze that exact master
    // before spawning SSH; never fall back to another connection or credential.
    try {
      const source=fs.lstatSync(remote.socket,{bigint:true});if(!source.isSocket())throw Error();
      // The trusted host already pinned this exact inode in its short private directory.
      // Do not turn it into an overlong ControlPath under the workspace state root.
      if(remote.pinned===true){
        if(typeof remote.masterSocket!=='string')throw Error();
        const master=fs.lstatSync(remote.masterSocket,{bigint:true});
        if(!master.isSocket()||master.dev!==source.dev||master.ino!==source.ino)throw Error();
        return {...remote};
      }
      const socket=path.join(space.dir,'.ssh-master-'+crypto.createHash('sha256').update(String(source.dev)+':'+String(source.ino)).digest('hex').slice(0,32));
      try{fs.linkSync(remote.socket,socket);}catch(error){if(error.code!=='EEXIST')throw error;}
      const pinned=fs.lstatSync(socket,{bigint:true});if(!pinned.isSocket()||pinned.dev!==source.dev||pinned.ino!==source.ino)throw Error();
      return {...remote,socket};
    } catch(_){throw Error('工作区 SSH 连接不可用，请先重新连接工作区');}
  }
  async reconnect(workspace,args) {
    const space=this.space(workspace),rec=this.get(space,args.id,workspace);
    if(this.stopping)throw Error('后台正在停止');
    if(rec.worker||rec.reconnecting||rec.relayConnecting)throw Error('会话已经连接或正在连接');
    if(!this.public(rec).reconnectable)throw Error('TCP 接入会话不能主动重连，请重新启动对应监听并等待设备接入；旧版未记录方向的 TCP 会话请新建客户端');
    const stored=this.public(rec);
    if(rec.x11Managed){delete stored.x11Display;delete stored.x11AuthorityFile;delete stored.x11ManagedServerId;delete stored.x11ViewerPort;}
    space.resources?.delete(rec.resource);rec.transport=null;
    rec.reconnecting=true;rec.status='starting';delete rec.endedAt;delete rec.exitCode;
    try {
      this.output(space,rec,Buffer.from('\r\n[重新连接 · '+new Date().toISOString()+']\r\n'));
      this.persist(space,rec);
      // The host's existing relay_connect admission loads canonical saved key
      // references for every stored session; browser/model overrides are ignored.
      const context=stored.kind==='workspace'?{...workspace,remote:this.pinWorkspaceSocket(space,workspace.remote)}:workspace;
      const result=await (rec.relayEnabled?this.relayConnect(context,{id:rec.id}):this.create(context,stored,rec));
      if(this.stopping)throw Error('后台正在停止');
      this.get(space,rec.id,workspace);return result;
    } catch(error) {
      if(rec.worker)await this.closeRecord(space,rec).catch(()=>{});
      rec.status='error';rec.endedAt=new Date().toISOString();this.persist(space,rec);throw error;
    } finally {rec.reconnecting=false;}
  }
  relayConfig(space,rec){return JSON.parse(readPrivate(path.join(space.dir,rec.id+'.relay.json')));}
  createRelay(space,rec,args,workspace){
    if(workspace?.workbench!==true||!workspace.stateRoot)throw Error('请通过新版工作台配置中继');
    if(!['ssh','telnet','tcp','udp','serial'].includes(rec.kind))throw Error('中继支持 SSH、TCP、UDP 和串口会话');
    const target={kind:rec.kind};
    if(rec.kind==='telnet'){target.terminalType=args.terminalType||'xterm-256color';target.telnetLocalEcho=args.telnetLocalEcho===true;}
    if(rec.kind==='serial')Object.assign(target,{devicePath:text(args.devicePath,'',512),baudRate:integer(args.baudRate,115200,1,4000000),dataBits:integer(args.dataBits,8,5,8),stopBits:Number(args.stopBits??1),parity:args.parity||'none',flowControl:!!args.flowControl});
    else Object.assign(target,{host:text(args.host,'127.0.0.1',253),port:integer(args.port,rec.kind==='ssh'?22:rec.kind==='telnet'?23:undefined,1,65535)});
    if(target.host&&!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(target.host))throw Error('目标主机名无效');
    if(rec.kind==='serial'&&(![1,1.5,2].includes(target.stopBits)||!['none','even','odd','mark','space'].includes(target.parity)))throw Error('串口参数无效');
    if(rec.kind==='ssh'){Object.assign(target,{username:text(args.username,'',64),auth:args.auth||'default',identityFile:args.identityFile,identitySource:args.identitySource});if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(target.username)||!['default','password','key'].includes(target.auth))throw Error('SSH 用户名或认证方式无效');if(target.auth==='key'&&!target.identityFile)throw Error('请选择私钥文件');}
    if(rec.kind==='ssh'){target.x11Enabled=!!args.x11Enabled;target.x11Display=args.x11Display;target.x11AuthorityFile=args.x11AuthorityFile;}
    const host=text(args.relay.host,'',253),port=integer(args.relay.port,17780,1,65535),key=String(args.relay.key||'').trim()||crypto.randomBytes(32).toString('base64');relay.keyBytes(key);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(host))throw Error('中继主机名无效');
    const config={id:crypto.createHmac('sha256',relay.keyBytes(key)).update('aide-relay-v1-id').digest('hex').slice(0,24),kind:rec.kind,host,port,key,listenHost:'0.0.0.0',listenPort:port,target};
    Object.assign(rec,target,{relayEnabled:true,relayEndpoint:host+':'+port,relayOnline:'unknown',status:'waiting'});
    writePrivate(path.join(space.dir,rec.id+'.relay.json'),JSON.stringify(config));space.records.set(rec.id,rec);this.persist(space,rec);
    return {session:this.public(rec)};
  }
  relayScript(workspace,args){
    if(workspace?.workbench!==true)throw Error('中继部署脚本仅允许从工作台下载');
    const space=this.space(workspace),rec=this.get(space,args.id,workspace);if(!rec.relayEnabled)throw Error('此会话未启用中继');
    const config=this.relayConfig(space,rec),script=relay.script({...config,...config.target});
    return {name:'aide-relay-'+rec.id+'.py',data:Buffer.from(script).toString('base64')};
  }
  visibility(workspace,args){
    if(workspace?.workbench!==true)throw Error('可见性仅允许在工作台修改');
    const space=this.space(workspace),rec=this.get(space,args.id,workspace);if(typeof args.visible!=='boolean')throw Error('visible 须为布尔值');rec.visibleToAide=args.visible;this.persist(space,rec);return {session:this.public(rec)};
  }
  async relayStatus(workspace,args){
    const space=this.space(workspace),rec=this.get(space,args.id,workspace);if(!rec.relayEnabled)throw Error('此会话未启用中继');
    try{await relay.open(this.relayConfig(space,rec),'probe');rec.relayOnline='online';}catch(_){rec.relayOnline='offline';}
    rec.relayCheckedAt=new Date().toISOString();this.persist(space,rec);return {session:this.public(rec)};
  }
  relayLine(space,rec,buffer,direction){const printable=buffer.toString('utf8').replace(/\uFFFD/g,'.').replace(/[\x00-\x1f\x7f]/g,'.');this.output(space,rec,Buffer.from(`[${new Date().toISOString()} ${direction} ${buffer.length} B] ${buffer.toString('hex').replace(/../g,'$& ').trim()} | ${printable}\r\n`));}
  async relayConnect(workspace,args){
    const space=this.space(workspace),rec=this.get(space,args.id,workspace);if(!rec.relayEnabled)return this.reconnect(workspace,args);if(this.stopping)throw Error('后台正在停止');if(rec.worker||rec.relayConnecting)throw Error('会话已经连接或正在连接');
    if([...this.spaces.values()].flatMap(s=>[...s.records.values()]).filter(r=>r.worker).length>=MAX_ACTIVE)throw Error('最多同时运行16个会话');
    rec.relayConnecting=true;try{
    const config=this.relayConfig(space,rec);
    if(rec.kind==='telnet')return await this.startTelnet(space,rec,config.target);
    if(rec.kind==='ssh'){await relay.open(config,'probe');this.get(space,args.id,workspace);rec.relayOnline='online';return this.create(workspace,{...config.target,cwd:rec.cwd},rec);}
    const socket=await relay.open(config);try{this.get(space,args.id,workspace);if(this.stopping)throw Error('后台正在停止');}catch(error){socket.destroy();throw error;}rec.relaySocket=socket;rec.relayOnline='online';rec.status='running';delete rec.endedAt;rec.worker={};
    let pending=Buffer.alloc(0);
    socket.on('data',chunk=>{
      if(rec.kind!=='udp'){this.relayLine(space,rec,chunk,'RX');return;}
      pending=Buffer.concat([pending,chunk]);while(pending.length>=4){const size=pending.readUInt32BE();if(size>65507){socket.destroy();return;}if(pending.length<4+size)return;this.relayLine(space,rec,pending.subarray(4,4+size),'RX');pending=pending.subarray(4+size);}
    });
    socket.on('error',()=>{});socket.on('close',()=>{rec.relaySocket=null;rec.worker=null;rec.status='exited';rec.endedAt=new Date().toISOString();if(space.records.has(rec.id))this.persist(space,rec);});
    rec.transport={close:()=>new Promise(resolve=>{if(socket.closed)return resolve();socket.once('close',resolve);socket.destroy();})};this.persist(space,rec);socket.resume();return {session:this.public(rec)};
    }finally{rec.relayConnecting=false;}
  }
  async sendRelay(space,rec,args){
    const data=communicationData(args.data,args.format||'utf8');if(rec.kind==='udp'&&data.length>65507)throw Error('UDP 报文过大');
    if(rec.relaySocket.writableLength>65536)throw Error('发送队列已满，请稍后重试');
    const frame=rec.kind==='udp'?Buffer.concat([Buffer.alloc(4),data]):data;if(rec.kind==='udp')frame.writeUInt32BE(data.length);
    await new Promise((resolve,reject)=>rec.relaySocket.write(frame,error=>error?reject(error):resolve()));this.relayLine(space,rec,data,'TX');return {bytesWritten:data.length};
  }
  communication(space) {
    if(space.communications)return space.communications;
    space.resources=new Map();
    space.communications=new Communications(space,(buffer,meta)=>{
      const rec=space.resources.get(meta.connectionId||meta.socketId||meta.path);
      if(!rec||!rec.worker)return;
      const printable=buffer.toString('utf8').replace(/\uFFFD/g,'.').replace(/[\x00-\x1f\x7f]/g,c=>c==='\n'?'\\n':c==='\r'?'\\r':'.');
      const line=`[${new Date().toISOString()} ${meta.direction==='in'?'RX':'TX'}${meta.remote?' '+meta.remote:''} ${buffer.length} B] ${buffer.toString('hex').replace(/../g,'$& ').trim()} | ${printable}\r\n`;
      this.output(space,rec,Buffer.from(line));
    },event=>{
      if(event.subtype==='connected'&&event.role==='server'){
        const listener=[...space.records.values()].find(r=>r.kind==='tcp-server'&&r.port===event.listenerPort&&r.worker);
        if(this.stopping||!listener||space.records.size>=MAX_SESSIONS||[...this.spaces.values()].flatMap(s=>[...s.records.values()]).filter(r=>r.worker).length>=MAX_ACTIVE){space.communications.call('tcp_close',{connectionId:event.connectionId}).catch(()=>{});return;}
        const rec={id:crypto.randomBytes(12).toString('hex'),visibleToAide:listener.visibleToAide!==false,connectionRole:'server',kind:'tcp',name:listener.name+' · '+event.remote,host:event.remote.slice(0,event.remote.lastIndexOf(':')),port:Number(event.remote.slice(event.remote.lastIndexOf(':')+1)),cwd:'.',cols:100,rows:30,createdAt:new Date().toISOString(),status:'running',logging:listener.logging,offset:0,base:0,history:Buffer.alloc(0),worker:{},resource:event.connectionId};
        rec.transport={close:()=>space.communications.call('tcp_close',{connectionId:event.connectionId})};space.resources.set(event.connectionId,rec);space.records.set(rec.id,rec);try{this.persist(space,rec);}catch(_){rec.status='error';rec.worker=null;space.communications.call('tcp_close',{connectionId:event.connectionId}).catch(()=>{});}
      }
      if(event.subtype==='closed'){
        const rec=space.resources.get(event.connectionId||event.socketId||event.path);if(rec&&rec.worker){rec.status='exited';rec.worker=null;rec.endedAt=new Date().toISOString();try{this.persist(space,rec);}catch(_){rec.logError='会话状态保存失败';}}
      }
    });
    return space.communications;
  }
  async startCommunication(space,rec,args) {
    const comm=this.communication(space);let result;
    if(['tcp','tcp-server','udp'].includes(rec.kind)){
      rec.host=text(args.host,'127.0.0.1',253);if(!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(rec.host)&&!/^[a-fA-F0-9:]+$/.test(rec.host))throw Error('通信主机名无效');
      rec.port=integer(args.port,rec.kind==='tcp'?undefined:0,rec.kind==='tcp'?1:0,65535);
    }
    if(rec.kind==='tcp'){result=await comm.call('tcp_connect',{host:rec.host,port:rec.port});rec.connectionRole='client';}
    if(rec.kind==='tcp-server'){result=await comm.call('tcp_listen',{port:rec.port});rec.port=result.port;rec.host=result.host;}
    if(rec.kind==='udp'){rec.bindPort=integer(args.bindPort,0,0,65535);rec.multicast=!!args.multicast;result=await comm.call('udp_bind',{port:rec.bindPort,multicast:rec.multicast,remoteHost:rec.host,remotePort:rec.port});rec.bindPort=result.port;rec.bindHost=result.host;}
    if(rec.kind==='serial'){
      rec.devicePath=text(args.devicePath,'',512);rec.baudRate=integer(args.baudRate,115200,1,4000000);rec.dataBits=integer(args.dataBits,8,5,8);rec.stopBits=Number(args.stopBits??1);rec.parity=args.parity||'none';rec.flowControl=!!args.flowControl;
      if(![1,1.5,2].includes(rec.stopBits)||!['none','even','odd','mark','space'].includes(rec.parity))throw Error('串口参数无效');
      result=await comm.call('serial_open',{path:rec.devicePath,baudRate:rec.baudRate,dataBits:rec.dataBits,stopBits:rec.stopBits,parity:rec.parity,flowControl:rec.flowControl});
    }
    rec.resource=result.connectionId||result.socketId||rec.devicePath||String(result.port);
    rec.status='running';rec.worker={};
    rec.transport={close:async()=>{
      if(rec.kind==='tcp')await comm.call('tcp_close',{connectionId:rec.resource});
      if(rec.kind==='tcp-server'){
        const mod=comm.modules.tcp,entry=mod.__state.listeners.get(rec.port);if(entry){for(const id of [...entry.conns])await comm.call('tcp_close',{connectionId:comm.token+':'+id});await new Promise(resolve=>entry.server.close(resolve));mod.__state.listeners.delete(rec.port);}
      }
      if(rec.kind==='udp')await comm.call('udp_close',{socketId:rec.resource});
      if(rec.kind==='serial')await comm.call('serial_close',{path:rec.devicePath});
    }};
    space.resources.set(rec.resource,rec);space.records.set(rec.id,rec);
    try{this.persist(space,rec);}catch(error){await rec.transport.close();space.records.delete(rec.id);throw error;}
    return {session:this.public(rec),communication:result};
  }
  async sendCommunication(space,rec,args){
    const comm=this.communication(space),buffer=communicationData(args.data,args.format||'utf8');
    if(rec.kind==='tcp-server')throw Error('请先选择已接入的TCP客户端会话');
    const values={data:buffer.toString('hex'),format:'hex'};
    if(rec.kind==='tcp')return comm.call('tcp_send',{...values,connectionId:rec.resource});
    if(rec.kind==='serial')return comm.call('serial_write',{...values,path:rec.devicePath});
    if(!rec.port)throw Error('UDP发送需要指定目标端口');
    return comm.call('udp_send',{...values,socketId:rec.resource,host:rec.host,port:rec.port});
  }
  async commCall(workspace,args){const space=this.space(workspace),comm=this.communication(space);const name=String(args.action||'').replace(/^terminal_/,'');
    if(workspace?.workbench!==true&&[...space.records.values()].some(rec=>rec.visibleToAide===false))throw Error('请使用可见会话的专用工具进行操作');
    const input=args.arguments||{};
    const converted={tcp_connect:{kind:'tcp',host:input.host,port:input.port},tcp_listen:{kind:'tcp-server',port:input.port},udp_bind:{kind:'udp',port:0,bindPort:input.port,multicast:input.multicast},serial_open:{...input,kind:'serial',devicePath:input.path}}[name];
    if(converted){const {session,communication:result}=await this.create(workspace,{...converted,name:input.name||name});return {...result,sessionId:session.id};}
    if(space.disabledTools?.includes('terminal_'+name))throw Error('通信工具已被管理员禁用');
    if(name==='ssh_fingerprint')return comm.fingerprint(args.arguments||{});
    const sessionMethods={session_logging:'logging',session_display:'display',session_configure:'configure',session_read:'read',session_visibility:'visibility'};if(sessionMethods[name])return this[sessionMethods[name]](workspace,input);
    const values={...(args.arguments||{})};
    if(name==='ssh_connect'&&typeof workspace==='object'&&workspace.identityMaterial){values.privateKey=Buffer.from(workspace.identityMaterial,'base64').toString();values.authType='publickey';}
    return comm.call(name,values);
  }
  send(workspace, args) {
    if (args.offset !== undefined) {
      // Validate before any input can execute. A readback failure must never
      // turn invalid parameters into a partly accepted write.
      if (!Number.isSafeInteger(args.offset) || args.offset < 0) throw Error('offset must be a non-negative safe integer');
      const requested = args.offset;
      const rec = this.get(this.space(workspace), args.id, workspace);
      return this.sendWithOutput(workspace, rec, args, requested);
    }
    return this.sendInput(workspace, args);
  }
  async sendWithOutput(workspace, rec, args, requested) {
    const result = await this.sendInput(workspace, args);
    // One short bounded wait may return a remote echo in the input ACK,
    // removing a second host RPC. Never wait on bulk paste or communication
    // packets, and never infer an echo from the bytes we just sent.
    if (['local','workspace','ssh','telnet'].includes(rec.kind) &&
        Buffer.byteLength(args.data) <= 256 && rec.offset === requested && !this.stopping) {
      await new Promise(resolve => {
        rec.outputWaiters ||= new Set();
        const ready = () => { clearTimeout(timer); rec.outputWaiters.delete(ready); resolve(); };
        const timer = setTimeout(ready, 32);
        rec.outputWaiters.add(ready);
      });
    }
    // A stale/invisible target must not expose output after an async write.
    this.get(this.space(workspace), args.id, workspace);
    return {...result, output:this.outputSince(rec, requested)};
  }
  sendInput(workspace, args) {
    const rec = this.get(this.space(workspace), args.id,workspace);
    if (!rec.worker || rec.status !== 'running') throw Error('会话已结束，创建新会话后重试');
    if(rec.kind==='telnet')return this.sendTelnet(this.space(workspace),rec,args);
    if(rec.relaySocket)return this.sendRelay(this.space(workspace),rec,args);
    if(rec.transport)return this.sendCommunication(this.space(workspace),rec,args);
    if (typeof args.data !== 'string' || Buffer.byteLength(args.data) > 16384) throw Error('单次输入不能超过16KiB');
    if (rec.worker.stdin.writableLength > 65536) throw Error('终端输入繁忙，请稍后重试');
    rec.worker.stdin.write(JSON.stringify({type:'input',data:Buffer.from(args.data).toString('base64')})+'\n');
    return {accepted:true};
  }
  resize(workspace, args) {
    const space = this.space(workspace), rec = this.get(space, args.id,workspace);
    rec.cols = integer(args.cols, 100, 20, 400); rec.rows = integer(args.rows, 30, 5, 200);
    if(rec.kind==='telnet'&&rec.telnet)rec.telnet.resize(rec.cols,rec.rows);
    if (rec.worker && !rec.transport) rec.worker.stdin.write(JSON.stringify({type:'resize',cols:rec.cols,rows:rec.rows})+'\n');
    this.persist(space, rec);
    return {session:this.public(rec)};
  }
  poll(workspace, args) {
    const space = this.space(workspace), rec = args.id ? this.get(space,args.id,workspace) : null;
    if (!rec) return this.list(workspace);
    const requested = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return {...this.list(workspace), output:this.outputSince(rec, requested)};
  }
  outputSince(rec, requested) {
    const start = Math.max(rec.base, Math.min(requested,rec.offset)), end = Math.min(rec.offset,start+PAGE);
    return {id:rec.id, start, data:rec.history.subarray(start-rec.base,end-rec.base).toString('base64'), offset:end, reset:requested < rec.base || requested > rec.offset, more:end < rec.offset};
  }
  async close(workspace, args) {
    const space = this.space(workspace), rec = this.get(space,args.id,workspace);
    if(rec.kind==='telnet'&&rec.connectAttempt)return this.closeRecord(space,rec);
    if(rec.reconnecting||rec.relayConnecting)throw Error('会话正在连接，请稍后再结束');
    return this.closeRecord(space,rec);
  }
  async closeRecord(space,rec) {
    if(rec.x11ManagedServerId){
      await this.xservers.stop(rec.x11ManagedServerId).catch(()=>{});
      delete rec.x11ManagedServerId; delete rec.x11ViewerPort;
    }
    if(rec.transport){await rec.transport.close();rec.worker=null;rec.status='exited';rec.endedAt=new Date().toISOString();this.persist(space,rec);return {session:this.public(rec)};}
    const worker = rec.worker;
    if (worker) {
      worker.stdin.write('{"type":"close"}\n');
      for (let i=0; i<40 && rec.worker; i++) await sleep(50);
      if (rec.worker) { worker.kill('SIGKILL'); await sleep(100); }
    }
    return {session:this.public(rec)};
  }
  logging(workspace, args) {
    const space = this.space(workspace), rec = this.get(space,args.id,workspace);
    if (typeof args.enabled !== 'boolean') throw Error('enabled 须为布尔值');
    rec.logging = args.enabled; delete rec.logError; this.persist(space,rec);
    return {session:this.public(rec)};
  }
  display(workspace,args) {
    const space=this.space(workspace),rec=this.get(space,args.id,workspace);
    if(typeof args.lineNumbers!=='boolean'||typeof args.timestamps!=='boolean')throw Error('显示设置须为布尔值');
    rec.displayLineNumbers=args.lineNumbers;rec.displayTimestamps=args.timestamps;rec.displaySettingsVersion=1;this.persist(space,rec);
    return {session:this.public(rec)};
  }
  configure(workspace,args) {
    const space=this.space(workspace),rec=this.get(space,args.id,workspace),editable=['name','cwd','host','port','username','auth','identityFile','identitySource','devicePath','baudRate','dataBits','stopBits','parity','flowControl','bindPort','multicast','terminalType','telnetLocalEcho','x11Enabled','x11Display','x11AuthorityFile','cols','rows','logging','visibleToAide','displayLineNumbers','displayTimestamps','relay'];
    if(!editable.some(key=>args[key]!==undefined))throw Error('请至少提供一个要修改的会话设置');
    if(args.visibleToAide!==undefined&&workspace?.workbench!==true)throw Error('仅工作台用户可修改会话可见性');
    for(const key of ['host','port'])if(args[key]!==undefined&&!['ssh','telnet','tcp','udp',...(key==='port'?['tcp-server']:[])].includes(rec.kind))throw Error(key+' 不适用于此会话类型');
    for(const key of ['username','auth','identityFile','identitySource'])if(args[key]!==undefined&&rec.kind!=='ssh')throw Error(key+' 仅适用于 SSH 会话');
    for(const key of ['terminalType','telnetLocalEcho'])if(args[key]!==undefined&&rec.kind!=='telnet')throw Error(key+' 仅适用于 Telnet 会话');
    for(const key of ['x11Enabled','x11Display','x11AuthorityFile'])if(args[key]!==undefined&&rec.kind!=='ssh')throw Error(key+' 仅适用于 SSH 会话');
    if(args.cwd!==undefined&&!['local','workspace','ssh'].includes(rec.kind))throw Error('cwd 仅适用于 Shell 会话');
    if(rec.kind==='tcp'&&rec.connectionRole!=='client'&&(args.host!==undefined||args.port!==undefined))throw Error('已接入的 TCP 会话不能修改其远端地址');
    if(rec.kind==='tcp-server'&&args.host!==undefined)throw Error('TCP 监听地址由系统固定');
    if(args.multicast!==undefined&&rec.kind!=='udp')throw Error('multicast 仅适用于 UDP 会话');
    for(const key of ['devicePath','baudRate','dataBits','stopBits','parity','flowControl'])if(args[key]!==undefined&&rec.kind!=='serial')throw Error(key+' 仅适用于串口会话');
    if(args.bindPort!==undefined&&rec.kind!=='udp')throw Error('bindPort 仅适用于 UDP 会话');
    if(args.host!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(args.host)&&!/^[a-fA-F0-9:]+$/.test(args.host))throw Error('主机名无效');
    if(args.username!==undefined&&!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(args.username))throw Error('用户名无效');
    let reconnect=false;
    if(args.name!==undefined)rec.name=text(args.name,rec.name,80);
    if(args.cwd!==undefined){const cwd=text(args.cwd,rec.cwd,512);if(path.isAbsolute(cwd)||cwd.split(/[\\/]/).includes('..'))throw Error('目录路径必须位于当前工作区内');if(rec.kind==='local')inside(space.root,cwd);if(cwd!==rec.cwd)reconnect=true;rec.cwd=cwd;}
    for(const [key,min,max] of [['port',1,65535],['baudRate',1,4000000],['dataBits',5,8],['bindPort',0,65535],['cols',20,400],['rows',5,200]])if(args[key]!==undefined){rec[key]=integer(args[key],rec[key]||min,min,max);if(['port','baudRate','dataBits','bindPort'].includes(key))reconnect=true;}
    if(args.terminalType!==undefined){rec.terminalType=text(args.terminalType,rec.terminalType||'xterm-256color',64);if(!/^[A-Za-z0-9_.+-]+$/.test(rec.terminalType))throw Error('Telnet 终端类型无效');reconnect=true;}
    if(args.telnetLocalEcho!==undefined){if(typeof args.telnetLocalEcho!=='boolean')throw Error('telnetLocalEcho 须为布尔值');rec.telnetLocalEcho=args.telnetLocalEcho;reconnect=true;}
    if(args.x11Enabled!==undefined){if(typeof args.x11Enabled!=='boolean')throw Error('x11Enabled 须为布尔值');rec.x11Enabled=args.x11Enabled;reconnect=true;}
    for(const key of ['x11Display','x11AuthorityFile'])if(args[key]!==undefined){const value=String(args[key]);if(value.length>512||/[\x00-\x1f\x7f]/.test(value))throw Error(key+' 参数无效');if(value)rec[key]=value;else delete rec[key];reconnect=true;}
    if(args.stopBits!==undefined){const value=Number(args.stopBits);if(![1,1.5,2].includes(value))throw Error('停止位设置无效');rec.stopBits=value;reconnect=true;}
    if(args.parity!==undefined){if(!['none','even','odd','mark','space'].includes(args.parity))throw Error('校验设置无效');rec.parity=args.parity;reconnect=true;}
    if(args.flowControl!==undefined){if(typeof args.flowControl!=='boolean')throw Error('flowControl 须为布尔值');rec.flowControl=args.flowControl;reconnect=true;}
    for(const key of ['host','username','devicePath'])if(args[key]!==undefined){rec[key]=text(args[key],rec[key]||'',key==='host'?253:key==='username'?64:512);reconnect=true;}
    if(args.identityFile!==undefined){const value=String(args.identityFile);if(value)value=text(value,rec.identityFile||'',512);if(value)rec.identityFile=value;else delete rec.identityFile;reconnect=true;}
    if(args.identitySource!==undefined){const value=String(args.identitySource);if(value)value=text(value,rec.identitySource||'',512);if(value)rec.identitySource=value;else delete rec.identitySource;reconnect=true;}
    if(args.auth!==undefined){if(!['default','password','key'].includes(args.auth))throw Error('认证方式无效');rec.auth=args.auth;reconnect=true;}
    for(const key of ['logging','visibleToAide','displayLineNumbers','displayTimestamps','multicast'])if(args[key]!==undefined){if(typeof args[key]!=='boolean')throw Error(key+' 须为布尔值');rec[key]=args[key];if(key==='displayLineNumbers'||key==='displayTimestamps')rec.displaySettingsVersion=1;if(key==='multicast')reconnect=true;}
    if(args.auth==='key'&&rec.kind==='ssh'&&!rec.identityFile)throw Error('key 认证须指定私钥文件');
    if(args.relay!==undefined){
      if(!args.relay||typeof args.relay!=='object'||Array.isArray(args.relay)||typeof args.relay.enabled!=='boolean')throw Error('relay 须包含 enabled 布尔值');
      const relayFile=path.join(space.dir,rec.id+'.relay.json');
      if(!args.relay.enabled){fs.rmSync(relayFile,{force:true});rec.relayEnabled=false;delete rec.relayEndpoint;rec.relayOnline='unknown';reconnect=true;}
      else {
        if(!['ssh','telnet','tcp','udp','serial'].includes(rec.kind))throw Error('中继支持 SSH、Telnet、TCP、UDP 和串口会话');
        let previous={};try{previous=this.relayConfig(space,rec);}catch(_){}
        const host=text(args.relay.host,previous.host||'',253),port=integer(args.relay.port,previous.port||17780,1,65535),key=String(args.relay.key||previous.key||crypto.randomBytes(32).toString('base64')).trim(),keyBytes=relay.keyBytes(key);
        if(!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(host))throw Error('中继主机名无效');
        const target={kind:rec.kind};if(rec.kind==='serial')Object.assign(target,{devicePath:rec.devicePath,baudRate:rec.baudRate||115200,dataBits:rec.dataBits||8,stopBits:rec.stopBits||1,parity:rec.parity||'none',flowControl:!!rec.flowControl});else Object.assign(target,{host:rec.host||'127.0.0.1',port:rec.port||(rec.kind==='ssh'?22:rec.kind==='telnet'?23:undefined)});if(rec.kind==='telnet')Object.assign(target,{terminalType:rec.terminalType||'xterm-256color',telnetLocalEcho:!!rec.telnetLocalEcho});
        if(rec.kind==='ssh')Object.assign(target,{username:rec.username,auth:rec.auth||'default',identityFile:rec.identityFile,identitySource:rec.identitySource,x11Enabled:!!rec.x11Enabled,x11Display:rec.x11Display,x11AuthorityFile:rec.x11AuthorityFile});
        const config={id:crypto.createHmac('sha256',keyBytes).update('aide-relay-v1-id').digest('hex').slice(0,24),kind:rec.kind,host,port,key,listenHost:'0.0.0.0',listenPort:port,target};
        writePrivate(relayFile,JSON.stringify(config));rec.relayEnabled=true;rec.relayEndpoint=host+':'+port;rec.relayOnline='unknown';reconnect=true;
      }
    }
    if(rec.relayEnabled&&reconnect&&args.relay===undefined){const config=this.relayConfig(space,rec),target={kind:rec.kind};if(rec.kind==='serial')Object.assign(target,{devicePath:rec.devicePath,baudRate:rec.baudRate||115200,dataBits:rec.dataBits||8,stopBits:rec.stopBits||1,parity:rec.parity||'none',flowControl:!!rec.flowControl});else Object.assign(target,{host:rec.host||'127.0.0.1',port:rec.port||(rec.kind==='ssh'?22:rec.kind==='telnet'?23:undefined)});if(rec.kind==='telnet')Object.assign(target,{terminalType:rec.terminalType||'xterm-256color',telnetLocalEcho:!!rec.telnetLocalEcho});if(rec.kind==='ssh')Object.assign(target,{username:rec.username,auth:rec.auth||'default',identityFile:rec.identityFile,identitySource:rec.identitySource,x11Enabled:!!rec.x11Enabled,x11Display:rec.x11Display,x11AuthorityFile:rec.x11AuthorityFile});config.target=target;writePrivate(path.join(space.dir,rec.id+'.relay.json'),JSON.stringify(config));}
    if((args.cols!==undefined||args.rows!==undefined)&&rec.worker&&!rec.transport)this.resize(workspace,{id:rec.id,cols:rec.cols,rows:rec.rows});
    this.persist(space,rec);
    return {session:this.public(rec),requiresReconnect:reconnect};
  }
  read(workspace,args) {
    const space=this.space(workspace),rec=this.get(space,args.id,workspace),limit=integer(args.limit,100,1,500),fromTime=args.fromTime===undefined?null:Date.parse(args.fromTime),toTime=args.toTime===undefined?null:Date.parse(args.toTime);
    if(args.fromTime!==undefined&&!Number.isFinite(fromTime)||args.toTime!==undefined&&!Number.isFinite(toTime))throw Error('时间须为可解析的 ISO 时间');
    if(fromTime!==null||toTime!==null){if(args.fromLine!==undefined||args.toLine!==undefined)throw Error('行范围和时间范围请分开查询');}
    const first=integer(args.fromLine,1,1,Number.MAX_SAFE_INTEGER),last=args.toLine===undefined?Number.MAX_SAFE_INTEGER:integer(args.toLine,first,1,Number.MAX_SAFE_INTEGER);if(last<first)throw Error('结束行不能早于起始行');
    const chunks=[];for(let index=LOG_FILES-1;index>=0;index--){const file=this.logPath(space,rec.id,index);if(fs.existsSync(file))chunks.push(readPrivate(file));}
    const lines=chunks.length?Buffer.concat(chunks).toString('utf8').split('\n'):[];if(lines.at(-1)==='')lines.pop();const totalLines=lines.length,records=[];let bytes=0,hasMore=false,selectedFrom=null,selectedTo=null;
    for(let i=0;i<lines.length;i++){const lineNumber=i+1,textLine=lines[i],match=/^\[(?:(\d+)\s+)?(\d{4}-\d\d-\d\dT[^\]]+Z)\]\s/.exec(textLine);let include;if(fromTime!==null||toTime!==null){if(!match)continue;const time=Date.parse(match[2]);include=(fromTime===null||time>=fromTime)&&(toTime===null||time<=toTime);}else include=lineNumber>=first&&lineNumber<=last;if(!include)continue;const line=textLine.length>8192?textLine.slice(0,8192)+'…[行已截断]':textLine,encoded=Buffer.byteLength(line,'utf8')+1;if(records.length>=limit||bytes+encoded>128*1024){hasMore=true;break;}records.push(line);bytes+=encoded;selectedFrom??=lineNumber;selectedTo=lineNumber;}
    if((fromTime!==null||toTime!==null)&&!records.length)throw Error('指定时间范围内没有可读取的日志行');
    const nextLine=hasMore&&selectedTo!==null?selectedTo+1:null;
    return {firstLine:records.length?selectedFrom:null,lastLine:records.length?selectedTo:null,totalLines,text:records.join('\n'),hasMore,nextLine,limit};
  }
  logs(workspace, args) {
    const space = this.space(workspace), rec = this.get(space,args.id,workspace);
    const files=[];
    for (let index=LOG_FILES-1; index>=0; index--) {
      const file=this.logPath(space,rec.id,index);
      if (fs.existsSync(file)) { const stat=fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('日志文件无效'); files.push({index,bytes:stat.size}); }
    }
    if (args.index === undefined) return {files};
    const index=integer(args.index,0,0,LOG_FILES-1), file=this.logPath(space,rec.id,index), offset=integer(args.offset,0,0,Number.MAX_SAFE_INTEGER);
    // A frozen identity prevents a rotation from silently joining two different files.
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      const stat=fs.fstatSync(fd), identity=`${stat.dev}:${stat.ino}`;
      if (args.identity && args.identity!==identity) throw Error('日志已轮转，请重新导出');
      const data=Buffer.alloc(Math.min(PAGE,Math.max(0,stat.size-offset)));
      const count=fs.readSync(fd,data,0,data.length,offset);
      return {index,identity,data:data.subarray(0,count).toString('base64'),offset:offset+count,bytes:stat.size,more:offset+count<stat.size};
    } finally { fs.closeSync(fd); }
  }
  remove(workspace, args) {
    const space=this.space(workspace), rec=this.get(space,args.id,workspace);
    if (rec.worker||rec.reconnecting||rec.relayConnecting) throw Error('请先关闭会话，再删除记录与日志');
    for (let i=0;i<LOG_FILES;i++) fs.rmSync(this.logPath(space,rec.id,i),{force:true});
    fs.rmSync(path.join(space.dir,rec.id+'.relay.json'),{force:true});
    fs.rmSync(path.join(space.dir,rec.id+'.json')); space.records.delete(rec.id);space.resources?.delete(rec.resource);
    return {deleted:true};
  }
  async xserverStart(_workspace, args = {}) { return this.xservers.start(args); }
  xserverStatus() { return { servers: this.xservers.list() }; }
  async xserverStop(_workspace, args = {}) { return this.xservers.stop(args.serverId); }
  async stop() {
    this.stopping=true;
    await this.xservers.stopAll();
    await Promise.allSettled([...this.spaces.values()].flatMap(space=>[...space.records.values()].filter(rec=>rec.worker).map(rec=>this.closeRecord(space,rec))));
    for(const space of this.spaces.values()){await space.communications?.close();for(const rec of space.records.values())if(rec.transport&&rec.worker){rec.worker=null;rec.status='exited';rec.endedAt=new Date().toISOString();try{this.persist(space,rec);}catch(_){}}}
  }
}
module.exports={Sessions, HISTORY, PAGE, LOG_BYTES, LOG_FILES};
