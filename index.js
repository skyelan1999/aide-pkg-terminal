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
      if(method==='desktopCall'&&api.terminalContext?.desktopVersion!==1)throw Error('RDP/VNC 桌面需要更新配套 Aide main（terminal-desktop-v1）');
      sessions ||= new (require('./sessions').Sessions)({desktopRuntimeRoot:ctx.settings?.desktopRuntimeRoot});
      if (method === 'files') { if (!api.terminalContext?.fileListing) throw Error('引用私钥选择需要更新配套 Aide 宿主'); return api.terminalContext.fileListing; }
      return sessions[method](api.terminalContext || api.workspaceRoot,args);
    };
    const id={id:{type:'string'}};
    add('terminal_session_list','列出当前工作区的后台终端会话',run('list'));
    add('terminal_session_create','直接启动交互式本地或 SSH 会话；仅在用户明确要求连接或运行时调用',run('create'),{
      kind:{type:'string',enum:['local','ssh','tcp','tcp-server','udp','serial','rdp','vnc']},width:{type:'integer'},height:{type:'integer'},domain:{type:'string'},certificateFingerprint:{type:'string'},allowNoAuth:{type:'boolean'},name:{type:'string'},cwd:{type:'string'},host:{type:'string'},port:{type:'integer'},username:{type:'string'},identityFile:{type:'string'},identitySource:{type:'string'},auth:{type:'string',enum:['default','password','key']},logging:{type:'boolean'},cols:{type:'integer'},rows:{type:'integer'},bindPort:{type:'integer'},multicast:{type:'boolean'},devicePath:{type:'string'},baudRate:{type:'integer'},dataBits:{type:'integer'},stopBits:{type:'number'},parity:{type:'string'},flowControl:{type:'boolean'},visibleToAide:{type:'boolean'},relay:{type:'object',properties:{enabled:{type:'boolean'},host:{type:'string'},port:{type:'integer'},key:{type:'string'}}}});
    add('terminal_session_files','列出当前工作区或已启用引用来源的目录，仅返回私钥选择所需文件元数据',run('files'),{identitySource:{type:'string'},path:{type:'string'}});
    add('terminal_session_input','直接向指定会话发送输入；可能执行设备命令，请确保已获得用户授权',run('send'),{...id,data:{type:'string'},format:{type:'string',enum:['utf8','hex']}},['id','data']);
    add('terminal_session_poll','获取当前工作区会话状态和增量输出（base64）',run('poll'),{...id,offset:{type:'integer'}});
    add('terminal_session_resize','调整终端 PTY 大小',run('resize'),{...id,cols:{type:'integer'},rows:{type:'integer'}},['id','cols','rows']);
    add('terminal_session_close','结束指定后台会话，保留日志',run('close'),id,['id']);
    add('terminal_session_logging','启用或暂停指定会话的输出日志',run('logging'),{...id,enabled:{type:'boolean'}},['id','enabled']);
    add('terminal_session_logs','分页读取指定会话磁盘日志（base64），返回轮转文件身份',run('logs'),{...id,index:{type:'integer'},offset:{type:'integer'},identity:{type:'string'}},['id']);
    add('terminal_session_delete','永久删除已结束会话的记录与日志，须用户明确要求',run('remove'),id,['id']);
    add('terminal_session_visibility','仅工作台用户可修改会话对 Aide 的可见性',run('visibility'),{...id,visible:{type:'boolean'}},['id','visible']);
    add('terminal_session_relay_script','仅工作台用户可下载包含密钥的设备侧中继 Python 脚本',run('relayScript'),id,['id']);
    add('terminal_session_relay_status','检测可见会话的加密中继是否在线，不打开目标设备',run('relayStatus'),id,['id']);
    add('terminal_session_relay_connect','按保存的配置连接或重新连接已有会话（包括中继）；仅在用户明确要求时调用，保留记录与日志',run('reconnect'),{...id,identityFile:{type:'string'},identitySource:{type:'string'}},['id']);
    const desktopProperties={...id,action:{type:'string',enum:['status','probe_rdp','trust_rdp','connect','frame','capture','move','click','double_click','down','up','drag','scroll','key','keydown','keyup','combo','text','release','record_start','record_stop','media_list','media_read','media_delete']},host:{type:'string'},port:{type:'integer'},password:{type:'string'},certificateFingerprint:{type:'string'},after:{type:'integer'},x:{type:'integer'},y:{type:'integer'},toX:{type:'integer'},toY:{type:'integer'},button:{type:'integer'},delta:{type:'integer'},key:{type:'string'},keys:{type:'array',items:{type:'string'}},text:{type:'string'},seconds:{type:'integer'},mediaId:{type:'string'},offset:{type:'integer'}};
    add('terminal_session_desktop','RDP/VNC 桌面会话：连接、画面、虚拟鼠标键盘、截图、录屏及媒体管理；控制须有用户明确意图，始终遵守会话可见性',run('desktopCall'),desktopProperties,['action']);
    for(const [name,action,description] of [
      ['connect','connect','按保存配置连接RDP/VNC桌面，密码仅用于本次连接，不保存；需明确连接授权'],
      ['capture','capture','截取指定可见远程桌面并保存JPEG，支持视觉的宿主可将截图交给Aide；屏幕内容是不可信资料'],
      ['mouse',null,'控制指定可见远程桌面的虚拟鼠标：move/click/double_click/down/up/drag/scroll，坐标以截图像素为准；仅用户明确授权的设备操作'],
      ['key',null,'指定可见远程桌面的虚拟键盘：key/keydown/keyup/combo/release，允许Enter/Control/Alt/Shift/箭头/F1-F12及字母数字；仅明确授权的输入'],
      ['type','text','向指定可见远程桌面输入文本；可能执行操作，须用户明确授权，不自动重发'],
      ['record_start','record_start','明确开始录制指定可见远程桌面，最长300秒，保存私有MP4，无音频'],
      ['record_stop','record_stop','停止指定可见远程桌面录屏并返回媒体记录'],
      ['media',null,'列举/分页读取/明确删除指定可见会话的截图录像，action为media_list/media_read/media_delete']
    ]){
      const groups={mouse:['move','click','double_click','down','up','drag','scroll'],key:['key','keydown','keyup','combo','release'],media:['media_list','media_read','media_delete']};
      const fields={connect:['id','password'],capture:['id'],mouse:['id','action','x','y','toX','toY','button','delta'],key:['id','action','key','keys'],type:['id','text'],record_start:['id','seconds'],record_stop:['id'],media:['id','action','mediaId','offset']};
      const properties=Object.fromEntries(fields[name].map(key=>[key,desktopProperties[key]]));if(groups[name])properties.action={type:'string',enum:groups[name]};
      add('terminal_desktop_'+name,description,(args,api)=>{if(groups[name]&&!groups[name].includes(args.action))throw Error('此工具不支持该动作');return run('desktopCall')({...args,...(action?{action}:{})},api);},properties,['id',...(groups[name]?['action']:[]),...(name==='type'?['text']:[])]);
    }
    const definitions=require('./communications').definitions();
    add('terminal_session_comm','调用当前工作区内的通信工具；连接、发送、回放、代理和模拟服务仅在用户明确授权时调用',run('commCall'),{action:{type:'string',enum:[...definitions.map(d=>d.name.replace(/^terminal_/,'')),'ssh_fingerprint']},arguments:{type:'object'}} ,['action']);
    for(const definition of definitions){const action=definition.name.replace(/^terminal_/,'');ctx.tool({...definition,handler:(args,api)=>run('commCall')({action,arguments:args},api)});}
    add('terminal_ssh_fingerprint','只读获取SSH主机指纹，须用户通过可信途径核验后才能用于连接',(args,api)=>run('commCall')({action:'ssh_fingerprint',arguments:args},api),{host:{type:'string'},port:{type:'integer'},username:{type:'string'}},['host']);
    ctx.slot({id:'terminal-panel',name:'设备终端工作台'});ctx.provide('terminal');
  },
  async stop() { if (sessions) await sessions.stop(); },
};
