'use strict';
let sessions;
module.exports = {
  name: 'terminal',
  apply(ctx) {
    const add = (name, description, handler, properties = {}, required = []) => ctx.tool({name, description,
      parameters:{type:'object',properties,required,additionalProperties:false}, handler});
    add('terminal-run','记录 shell 命令提案，等待用户审阅与手动运行；不会直接执行',(args,api)=>api.proposeCommand(String(args.command||'')),{command:{type:'string'}},['command']);
    add('terminal-history','只读列出当前工作区目录',(args,api)=>({text:api.listFiles(args.path||'.').join('\n')}),{path:{type:'string'}});
    const run = method => (args,api) => {
      if (process.env.AIDE_DAEMON !== '1') throw Error('终端工作台需要启用 daemon 常驻插件支持');
      if(api.terminalContext?.communicationsVersion!==1||api.terminalContext?.relayVersion!==1)throw Error('请更新配套 Aide：统一通信工作台需要新版宿主策略上下文');
      if(method==='create'&&args.copyFrom&&api.terminalContext?.sessionCopyVersion!==1)throw Error('Session copy requires an updated Aide host');
      sessions ||= new (require('./sessions').Sessions)();
      if (method === 'files') { if (!api.terminalContext?.fileListing) throw Error('引用私钥选择需要更新配套 Aide 宿主'); return api.terminalContext.fileListing; }
      return sessions[method](api.terminalContext || api.workspaceRoot,args);
    };
    const id={id:{type:'string'}};
    add('terminal_session_list','列出当前工作区的后台终端会话',run('list'));
    add('terminal_session_create','创建本地/SSH/Telnet/TCP/UDP/串口会话，relay保存待部署配置；copyFrom复制已有会话，默认仅复制设置，connect=true才新建独立连接（串口/固定监听仅复制设置）；仅在用户明确授权时调用',run('create'),{
      copyFrom:{type:'string',pattern:'^[a-f0-9]{24}$'},connect:{type:'boolean'},x11Enabled:{type:'boolean'},x11Display:{type:'string'},x11AuthorityFile:{type:'string'},terminalType:{type:'string'},telnetLocalEcho:{type:'boolean'},kind:{type:'string',enum:['local','ssh','telnet','tcp','tcp-server','udp','serial']},name:{type:'string'},cwd:{type:'string'},host:{type:'string'},port:{type:'integer'},username:{type:'string'},identityFile:{type:'string'},identitySource:{type:'string'},auth:{type:'string',enum:['default','password','key']},logging:{type:'boolean'},cols:{type:'integer'},rows:{type:'integer'},bindPort:{type:'integer'},multicast:{type:'boolean'},devicePath:{type:'string'},baudRate:{type:'integer'},dataBits:{type:'integer'},stopBits:{type:'number'},parity:{type:'string'},flowControl:{type:'boolean'},visibleToAide:{type:'boolean'},relay:{type:'object',properties:{enabled:{type:'boolean'},host:{type:'string'},port:{type:'integer'},key:{type:'string'}}}});
    add('terminal_session_files','列出当前工作区或已启用引用来源的目录，仅返回私钥选择所需文件元数据',run('files'),{identitySource:{type:'string'},path:{type:'string'}});
    add('terminal_session_input','直接向指定会话发送输入；可能执行设备命令，请确保已获得用户授权',run('send'),{...id,data:{type:'string'},format:{type:'string',enum:['utf8','hex']}},['id','data']);
    add('terminal_session_poll','获取当前工作区会话状态和增量输出（base64）',run('poll'),{...id,offset:{type:'integer'}});
    add('terminal_session_resize','调整终端 PTY 大小',run('resize'),{...id,cols:{type:'integer'},rows:{type:'integer'}},['id','cols','rows']);
    add('terminal_session_close','结束指定后台会话，保留日志',run('close'),id,['id']);
    add('terminal_session_logging','启用或暂停指定会话的输出日志',run('logging'),{...id,enabled:{type:'boolean'}},['id','enabled']);
    add('terminal_session_display','保存会话行号和时间戳显示设置，并将之后记录的日志行加上已启用标记',run('display'),{...id,lineNumbers:{type:'boolean'},timestamps:{type:'boolean'}},['id','lineNumbers','timestamps']);
    add('terminal_session_configure','修改已有会话的手动配置。连接目标等配置在下次手动重连时生效；不会自动重连或中断当前会话。中继密钥只写入私有配置，不会从工具结果返回。',run('configure'),{...id,name:{type:'string'},cwd:{type:'string'},host:{type:'string'},port:{type:'integer'},username:{type:'string'},auth:{type:'string',enum:['default','password','key']},identityFile:{type:'string'},identitySource:{type:'string'},devicePath:{type:'string'},baudRate:{type:'integer'},dataBits:{type:'integer'},stopBits:{type:'number'},parity:{type:'string',enum:['none','even','odd','mark','space']},flowControl:{type:'boolean'},bindPort:{type:'integer'},multicast:{type:'boolean'},terminalType:{type:'string'},telnetLocalEcho:{type:'boolean'},x11Enabled:{type:'boolean'},x11Display:{type:'string'},x11AuthorityFile:{type:'string'},cols:{type:'integer'},rows:{type:'integer'},logging:{type:'boolean'},visibleToAide:{type:'boolean'},displayLineNumbers:{type:'boolean'},displayTimestamps:{type:'boolean'},relay:{type:'object',properties:{enabled:{type:'boolean'},host:{type:'string'},port:{type:'integer'},key:{type:'string'}}}},['id']);
    add('terminal_session_read','按行号或时间范围读取现有会话日志；默认最多返回100行，最多500行且128 KiB，适合分段读取避免占用过多上下文。',run('read'),{...id,fromLine:{type:'integer'},toLine:{type:'integer'},fromTime:{type:'string'},toTime:{type:'string'},limit:{type:'integer'}},['id']);
    add('terminal_session_logs','分页读取指定会话磁盘日志（base64），返回轮转文件身份',run('logs'),{...id,index:{type:'integer'},offset:{type:'integer'},identity:{type:'string'}},['id']);
    add('terminal_session_delete','永久删除已结束会话的记录与日志，须用户明确要求',run('remove'),id,['id']);
    add('terminal_session_visibility','仅工作台用户可修改会话对 Aide 的可见性',run('visibility'),{...id,visible:{type:'boolean'}},['id','visible']);
    add('terminal_session_relay_script','仅工作台用户可下载包含密钥的设备侧中继 Python 脚本',run('relayScript'),id,['id']);
    add('terminal_session_relay_status','检测可见会话的加密中继是否在线，不打开目标设备',run('relayStatus'),id,['id']);
    add('terminal_session_relay_connect','按保存的配置连接或重新连接已有会话（包括中继）；仅在用户明确要求时调用，保留记录与日志',run('reconnect'),{...id,identityFile:{type:'string'},identitySource:{type:'string'}},['id']);
    const definitions=require('./communications').definitions();
    add('terminal_session_comm','调用当前工作区内的通信工具；连接、发送、回放、代理和模拟服务仅在用户明确授权时调用',run('commCall'),{action:{type:'string',enum:[...definitions.map(d=>d.name.replace(/^terminal_/,'')),'ssh_fingerprint','session_logging','session_display','session_configure','session_read','session_visibility']},arguments:{type:'object'}} ,['action']);
    for(const definition of definitions){const action=definition.name.replace(/^terminal_/,'');ctx.tool({...definition,handler:(args,api)=>run('commCall')({action,arguments:args},api)});}
    add('terminal_ssh_fingerprint','只读获取SSH主机指纹，须用户通过可信途径核验后才能用于连接',(args,api)=>run('commCall')({action:'ssh_fingerprint',arguments:args},api),{host:{type:'string'},port:{type:'integer'},username:{type:'string'}},['host']);
    add('terminal_xserver_start','在 Aide 运行环境内启动受管 Xvfb display 并生成私有 MIT cookie；仅 Unix socket，不监听 TCP；不会安装或修改系统 X Server',run('xserverStart'),{display:{type:'string'},width:{type:'integer'},height:{type:'integer'},depth:{type:'integer'}});
    add('terminal_xserver_status','列出受管 X display 的状态；不返回 cookie 内容',run('xserverStatus'));
    add('terminal_xserver_stop','停止受管 X display 并立即删除其 Xauthority cookie；不传 serverId 时停止全部',run('xserverStop'),{serverId:{type:'string'}});
    ctx.slot({id:'terminal-panel',name:'设备终端工作台'});ctx.provide('terminal');
  },
  async stop() { if (sessions) await sessions.stop(); },
};
