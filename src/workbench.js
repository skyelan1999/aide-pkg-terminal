'use strict';
(() => {
  const $ = id => document.getElementById(id), bridge = AideWorkbenchClient.create('terminal');
  const panes = new Map(), pendingInput = new Map();
  let sessionFilter = 'all', workspaceMode = 'local';
  let sessions = [], selected = null, polling = false, paused = true, connected = false, stopped = false, exportId = 0, relayConnecting = false, sessionReconnecting = false, sessionCopyCapable=false, copying=false;
  let relayExportSession = null;
  let outputPush = false, outputWatch = null, outputFallbackId = null, nextOutputSubscription = 0;
  let pollTimer = null, pollRequested = false, interactiveUntil = 0, emptyPolls = 0, inputReadback = false, inputReadbackFast = false;
  function schedulePoll(delay = 0) {
    clearTimeout(pollTimer);pollTimer=null;
    if(paused||stopped)return;
    if(polling){pollRequested=true;return;}
    pollTimer=setTimeout(()=>{pollTimer=null;poll();},delay);
  }
  const labels = {saved:'未连接',waiting:'等待中继部署',starting:'启动中',running:'运行中',exited:'已结束',interrupted:'后台已重启',error:'连接异常'};
  const communication=rec=>['tcp','tcp-server','udp','serial'].includes(rec?.kind);
  const endpoint=rec=>rec?.kind==='serial'?rec.devicePath:['telnet','tcp','tcp-server','udp'].includes(rec?.kind)?(rec.host||'127.0.0.1')+':'+rec.port+(rec.kind==='udp'?' · RX :'+rec.bindPort:''):rec?.kind!=='local'?rec.username+'@'+rec.host+':'+rec.port:'本地 · '+rec.cwd;
  const kinds={telnet:'Telnet / NVT',local:'本地 Shell / PTY',workspace:'SSH 工作区 / Shell',ssh:'SSH / OpenSSH',tcp:'TCP 客户端','tcp-server':'TCP 本地监听',udp:'UDP 数据报',serial:'串口 / UART'};
  const current = () => sessions.find(s => s.id === selected);
  const message = text => { $('notice').hidden = false; $('notice').querySelector('span').textContent = text; };
  // Keep the host single-flight contract. Inputs may pass queued background work,
  // but a bounded burst lets a waiting poll/export make progress as well.
  const requests = {input: [], normal: []};
  let dispatching = false, inputBurst = 0;
  function enqueue(tool, args={}, skipReadbackWait=false) {
    return new Promise((resolve,reject)=>{
      requests[tool==='input'?'input':'normal'].push({tool,args,skipReadbackWait,resolve,reject});
      if(!dispatching){dispatching=true;queueMicrotask(dispatch);}
    });
  }
  function enqueueViewer(args={}) {
    return new Promise((resolve,reject)=>{
      // A popup needs the user's live browser activation. Start immediately
      // when idle and pass queued background polls without breaking single-flight.
      requests.normal.unshift({tool:'__viewer',args,resolve,reject});
      if(!dispatching){dispatching=true;void dispatch();}
    });
  }
  async function dispatch() {
    try {
      while(requests.input.length||requests.normal.length) {
        const urgent=requests.input.length&&(!requests.normal.length||inputBurst<8);
        const job=requests[urgent?'input':'normal'].shift();
        inputBurst=urgent?inputBurst+1:0;
        try {
          if(stopped)throw Error('工作台已关闭');
          if(!connected)throw Error('当前 Aide 尚未建立所需的常驻工作台通信，请更新 Aide 后重新打开');
          // Resolve the offset at dispatch, after earlier queued polls finish.
          // Older daemons remain compatible until they advertise readback.
          let args=job.args;
          if(job.tool==='input'&&inputReadback&&panes.has(args.id)){
            args={...args,offset:panes.get(args.id).offset};
            if(inputReadbackFast){
              if(job.skipReadbackWait || watchingOutput(args.id))args.waitForOutput=false;
              else if(sessions.find(s=>s.id===args.id)?.relayEnabled)args.waitForOutput=true;
            }
          }
          let reply;
          if(job.tool==='__viewer') reply=await (sharedWindow ? bridge.openWindow(args) : bridge.viewer(args));
          else if(job.tool==='__outputStart'){
            const watch=outputWatch;
            if(!watch || watch.subscription!==args.subscription || paused){job.resolve(null);continue;}
            watch.offset=panes.get(args.id).offset;
            reply=await bridge.startTerminalOutput({...args,offset:watch.offset});
          } else if(job.tool==='__outputStop') reply=await bridge.stopTerminalOutput(args);
          else reply=await bridge.call('terminal_session_'+job.tool,args);
          if(reply.status!=='result')throw Error('操作未完成，请检查 Aide 中的待审批提案');
          const result=reply.result;
          job.resolve(job.tool==='input'&&result?.output?.reset?{...result,requestedOutputOffset:args.offset}:result);
        } catch(error) {job.reject(error);}
        // Buffered keys enqueue from the just-settled input's promise.
        // Let that continuation run before an already queued poll takes the bridge.
        await Promise.resolve();
      }
    } finally {dispatching=false;inputBurst=0;}
  }
  function fail(error) { message(error.message || String(error)); }
  function confirmAction(text){return new Promise(resolve=>{const dialog=$('confirm-dialog');$('confirm-message').textContent=text;dialog.onclose=()=>resolve(false);$('confirm-cancel').onclick=()=>dialog.close();$('confirm-accept').onclick=()=>{resolve(true);dialog.close();};dialog.showModal();$('confirm-cancel').focus();});}
  function bytes(base64) { return Uint8Array.from(atob(base64), c => c.charCodeAt(0)); }
  function terminal(id) {
    if (panes.has(id)) return panes.get(id);
    const element = document.createElement('div');element.className='terminal-pane';element.hidden=true;const gutter=document.createElement('div');gutter.className='terminal-gutter';gutter.setAttribute('aria-hidden','true');const view=document.createElement('div');view.className='terminal-view';element.append(gutter,view);$('terminal').append(element);
    const term = new Terminal({cursorBlink:true,fontSize:13,fontFamily:'"Cascadia Code","SFMono-Regular",Consolas,monospace',scrollback:10000,
      allowProposedApi:false,screenReaderMode:true,theme:{background:'#0b1018',foreground:'#d5e3ef',cursor:'#6fe0ba',selectionBackground:'#2c5062',black:'#152130',brightBlack:'#61768f',red:'#f18b9a',green:'#85d7af',yellow:'#e5cb8b',blue:'#7bb8f5',magenta:'#c6a1f0',cyan:'#79d7dc',white:'#dde5ef'}});
    const fit = new FitAddon.FitAddon(), search = new SearchAddon.SearchAddon();term.loadAddon(fit);term.loadAddon(search);term.open(view);
    // Escape sequence responses are sent only while this session is selected and running.
    term.onData(data => {
      if (paused || selected !== id || sessions.find(s=>s.id===id)?.status !== 'running'||communication(sessions.find(s=>s.id===id))) return;
      let pending = pendingInput.get(id);
      if (!pending) { pending={text:'',scheduled:false,sending:false,lastKeyAt:0,skipReadbackWait:false};pendingInput.set(id,pending); }
      const now=Date.now();
      interactiveUntil=now+450;emptyPolls=0;
      pending.skipReadbackWait ||= pending.sending || now-pending.lastKeyAt<120;
      pending.lastKeyAt=now;
      pending.text += data;
      if (pending.text.length > 65536) { pending.text='';paused=true;stopOutputWatch();message('输入过多，已暂停发送；请检查设备后重新连接工作台');return; }
      if (!pending.sending && !pending.scheduled) {
        pending.scheduled=true;
        queueMicrotask(()=>flushInput(id));
      }
    });
    // Do not let a terminal silently request browser clipboard access (OSC 52).
    term.parser.registerOscHandler(52,()=>true);
    const state={term,fit,search,element,gutter,offset:0,cols:0,rows:0,timestamps:new Map(),pendingTimestamp:null};
    term.onLineFeed(()=>{const active=term.buffer.active,row=active.baseY+active.cursorY;state.timestamps.set(row,state.pendingTimestamp||new Date());while(state.timestamps.size>12000)state.timestamps.delete(state.timestamps.keys().next().value);});
    term.onScroll(viewportY=>scheduleGutter(id,viewportY));term.element?.querySelector('.xterm-viewport')?.addEventListener('scroll',()=>scheduleGutter(id),{passive:true});term.onWriteParsed(()=>scheduleGutter(id));panes.set(id,state);applyDisplayPrefs(id,state);return state;
  }
  async function flushInput(id) {
    const pending=pendingInput.get(id);if(!pending)return;
    pending.scheduled=false;if(pending.sending||paused||stopped)return;
    pending.sending=true;
    try {
      while(pending.text&&!paused&&!stopped&&pendingInput.get(id)===pending){
        const input=pending.text,skipReadbackWait=pending.skipReadbackWait;
        pending.text='';pending.skipReadbackWait=false;
        for(let start=0;start<input.length;) {
          if(paused||stopped||pendingInput.get(id)!==pending)break;
          let end=Math.min(start+4096,input.length);
          if(end<input.length&&(input.charCodeAt(end-1)>=0xd800&&input.charCodeAt(end-1)<=0xdbff||
              sessions.find(s=>s.id===id)?.kind==='telnet'&&input[end-1]==='\r'&&input[end]==='\n'))end--;
          const result=await enqueue('input',{id,data:input.slice(start,end)},skipReadbackWait);start=end;
          if(result.output)acceptOutput(id,result.output,result.requestedOutputOffset);
          // Push covers the remaining echo. Legacy hosts fetch it after the
          // final write without interleaving a poll ahead of buffered keys.
          if(start===input.length&&!pending.text&&!watchingOutput(id))schedulePoll(result.output?.data&&!result.output.more?16:0);
        }
      }
    } catch(error) { paused=true;stopOutputWatch();for(const p of pendingInput.values())p.text='';message('输入结果待核实，不会自动重发。'+error.message); }
    finally {pending.sending=false;}
  }
  function scheduleGutter(id, viewport) {
    const pane=panes.get(id);if(!pane)return;
    pane.gutterViewport=viewport;
    if(pane.gutterFrame)return;
    pane.gutterFrame=requestAnimationFrame(()=>{pane.gutterFrame=null;renderGutter(id,pane.gutterViewport);});
  }
  function acceptOutput(id, output, requested) {
    const pane=panes.get(id);if(!pane||output.id!==id)return;
    // A poll that was in flight before a push may ask for an expired offset.
    // Only reset the canvas if its response still indicates a real gap.
    const reset=output.reset&&!(Number.isSafeInteger(requested)&&requested!==pane.offset&&output.start<=pane.offset);
    if(!reset&&(output.offset<=pane.offset||output.start>pane.offset))return;
    if(reset){pane.term.reset();pane.timestamps.clear();pane.term.writeln('\x1b[33m[恢复保留的输出尾部；完整记录请查看磁盘日志]\x1b[0m');}
    let data=bytes(output.data||'');
    if(!reset&&Number.isInteger(output.start)&&output.start<pane.offset)data=data.subarray(pane.offset-output.start);
    if(data.length){pane.pendingTimestamp=new Date();const active=pane.term.buffer.active;pane.timestamps.set(active.baseY+active.cursorY,pane.pendingTimestamp);pane.term.write(data,()=>scheduleGutter(id));emptyPolls=0;interactiveUntil=Math.max(interactiveUntil,Date.now()+220);}
    pane.offset=output.offset;
  }
  function watchingOutput(id) {
    return outputWatch?.ready===true && outputWatch.id===id;
  }
  function stopOutputWatch(notifyHost=true) {
    const watch=outputWatch;
    outputWatch=null;
    if(notifyHost && watch && watch.offset!==null && !stopped && connected){
      void enqueue('__outputStop',{subscription:watch.subscription}).catch(()=>{});
    }
  }
  function outputWatchFailed(watch, notifyHost) {
    if(outputWatch!==watch)return;
    outputFallbackId=watch.id;
    stopOutputWatch(notifyHost);
    schedulePoll();
  }
  function syncOutputWatch() {
    if(!outputPush)return;
    const rec=current();
    if(paused||stopped||rec?.status!=='running'||rec.kind!=='ssh'||!rec.relayEnabled){
      stopOutputWatch();
      if(rec?.status!=='running')outputFallbackId=null;
      return;
    }
    if(outputWatch?.id===rec.id || outputFallbackId===rec.id)return;
    stopOutputWatch();
    const watch={id:rec.id,subscription:++nextOutputSubscription,offset:null,ready:false};
    outputWatch=watch;
    void enqueue('__outputStart',{id:watch.id,subscription:watch.subscription}).then(()=>{
      if(outputWatch!==watch)return;
      watch.ready=true;
      schedulePoll(1500);
    }).catch(()=>outputWatchFailed(watch,true));
  }
  function receiveOutputEvent(event) {
    const watch=outputWatch;
    if(event.protocol!==1||paused||stopped||!watch||watch.offset===null||
        event.subscription!==watch.subscription||watch.id!==selected)return;
    if(event.event==='terminal.output.end'||event.event==='terminal.output.closed'){
      outputWatchFailed(watch,false);
      return;
    }
    if(event.event!=='terminal.output')return;
    const output=event.output;
    if(!output||output.id!==watch.id||typeof output.data!=='string'||
        !Number.isSafeInteger(output.start)||!Number.isSafeInteger(output.offset)||
        output.start<0||output.offset<output.start||(!output.reset&&output.start!==watch.offset)){
      outputWatchFailed(watch,true);
      return;
    }
    const requested=watch.offset;
    watch.offset=output.offset;
    acceptOutput(watch.id,output,requested);
  }
  const displayPrefs = new Map();
  function prefsFor(id){const rec=sessions.find(s=>s.id===id);if(rec?.displaySettingsVersion===1){const prefs={lineNumbers:rec.displayLineNumbers===true,timestamps:rec.displayTimestamps===true};displayPrefs.set(id,prefs);return prefs;}if(!displayPrefs.has(id)){let prefs={lineNumbers:false,timestamps:false};try{const saved=JSON.parse(localStorage.getItem('aide.terminal.display.'+id)||'null');if(saved&&typeof saved==='object')prefs={lineNumbers:saved.lineNumbers===true,timestamps:saved.timestamps===true};}catch(_){}displayPrefs.set(id,prefs);}return displayPrefs.get(id);}
  function applyDisplayPrefs(id,pane=panes.get(id)){if(!pane)return;const prefs=prefsFor(id),enabled=prefs.lineNumbers||prefs.timestamps,width=(prefs.lineNumbers?38:0)+(prefs.timestamps?72:0);pane.element.classList.toggle('has-gutter',enabled);pane.element.style.setProperty('--gutter-width',width+'px');pane.gutter.style.width=enabled?width+'px':'0px';pane.displaySignature=prefs.lineNumbers+':'+prefs.timestamps;if(id===selected){$('show-line-numbers').checked=prefs.lineNumbers;$('show-timestamps').checked=prefs.timestamps;}renderGutter(id);}
  function renderGutter(id,viewportOverride){const pane=panes.get(id);if(!pane||pane.element.hidden)return;const prefs=prefsFor(id),enabled=prefs.lineNumbers||prefs.timestamps;if(!enabled){pane.gutter.replaceChildren();return;}const rows=pane.term.buffer.active,viewport=Number.isInteger(viewportOverride)?viewportOverride:rows.viewportY,labels=[];const rowNodes=pane.term.element?.querySelectorAll('.xterm-rows > div')||[];const paneRect=pane.element.getBoundingClientRect();for(let i=0;i<rowNodes.length;i++){const row=viewport+i,node=rowNodes[i],rect=node.getBoundingClientRect(),label=document.createElement('div');label.className='terminal-gutter-label';label.style.top=(rect.top-paneRect.top)+'px';if(prefs.lineNumbers){const number=document.createElement('span');number.textContent=String(row+1);label.append(number);}if(prefs.timestamps){const time=document.createElement('span');time.className='gutter-time';const stamp=pane.timestamps.get(row);time.textContent=stamp?stamp.toLocaleTimeString('zh-CN',{hour12:false}):'';label.append(time);}labels.push(label);}pane.gutter.replaceChildren(...labels);}
  function render() {
    $('session-count').textContent=sessions.length+' / 32';
    $('sessions').replaceChildren();$('tabs').replaceChildren();
    const query=$('session-search').value.trim().toLocaleLowerCase();
    let visible=0;
    const groups=new Map();
    for(const rec of sessions) {
      const matches=(!query||[rec.name,rec.host,rec.username,rec.cwd].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)) && (sessionFilter==='all'||(sessionFilter==='running'?rec.status==='running':sessionFilter==='communication'?(communication(rec)||rec.kind==='telnet'):['ssh','workspace'].includes(rec.kind)));
      const button=document.createElement('button');button.type='button';button.className='session'+(rec.id===selected?' active':'');button.dataset.sessionId=rec.id;button.dataset.state=rec.status;
      const icon=document.createElement('span');icon.className='icon';icon.textContent=rec.kind!=='local'?'↗':'›_';
      button.setAttribute('aria-pressed',String(rec.id===selected));button.title=rec.name+' · '+(labels[rec.status]||rec.status);
      const body=document.createElement('span');body.className='session-body';
      const name=document.createElement('strong'),detail=document.createElement('small');
      name.textContent=rec.name;detail.textContent=(rec.relayEnabled?'[中继] ':'')+endpoint(rec);body.append(name,detail);const dot=document.createElement('i');dot.className='dot'+(rec.status==='running'?' live':'');dot.setAttribute('aria-label',labels[rec.status]||rec.status);const stateLabel=document.createElement('span');stateLabel.className='session-state';stateLabel.textContent=labels[rec.status]||rec.status;button.append(icon,body,stateLabel);button.onclick=()=>select(rec.id);if(matches){const group=rec.status==='saved'?'待连接会话':rec.status==='waiting'?'待部署中继':['running','starting'].includes(rec.status)?(rec.kind==='workspace'?'SSH 工作区':rec.kind==='ssh'?'SSH 设备':rec.kind==='telnet'?'Telnet 设备':communication(rec)?'通信设备':'本地环境'):'历史会话';if(!groups.has(group))groups.set(group,[]);groups.get(group).push(button);visible++;}
      const tab=document.createElement('button'),tabDot=dot.cloneNode(),tabName=document.createElement('span');tabName.className='tab-name';tabName.textContent=rec.name;tab.append(tabDot,tabName);tab.title=button.title;tab.className=rec.id===selected?'active':'';tab.setAttribute('aria-current',String(rec.id===selected));tab.onclick=()=>select(rec.id);if(['running','starting'].includes(rec.status)||rec.id===selected)$('tabs').append(tab);
    }
    for(const title of groups.keys()){const rows=groups.get(title);if(!rows)continue;const heading=document.createElement('p');heading.className='session-group';const label=document.createElement('span'),count=document.createElement('span');label.textContent=title;count.textContent=String(rows.length);heading.append(label,count);$('sessions').append(heading,...rows);}
    if(!visible){const empty=document.createElement('p');empty.className='list-empty';empty.textContent=sessions.length?'没有匹配的会话':'暂无会话，添加一个连接开始调试';$('sessions').append(empty);}
    for(const button of document.querySelectorAll('[data-filter]'))button.setAttribute('aria-pressed',String(button.dataset.filter===sessionFilter));
    const rec=current(), running=rec?.status==='running';
    $('running-count').textContent=!connected?'后台未连接':paused?'后台通信已暂停':sessions.filter(s=>s.status==='running').length+' 个运行中';
    $('backend-dot').classList.toggle('live',connected&&!paused);
    $('connection-name').textContent=rec?.name||'开始新的连接';
    $('connection-kind').textContent=rec?rec.kind.toUpperCase():'TERMINAL';
    $('detail-state').textContent=rec?(labels[rec.status]||rec.status):'尚未连接';
    $('detail-state').style.color=running?'var(--positive)':'var(--muted)';
    $('detail-kind').textContent=rec?(kinds[rec.kind]||rec.kind)+(rec.x11Unavailable?' / X11 不可用':rec.x11Trusted?' / X11 · OpenGL':rec.x11Enabled?' / X11 已请求':'')+(rec.copiedFrom?' / 副本':'')+(rec.relayEnabled?' · 中继模式':''):'—';
    $('session-visible').disabled=!rec||paused;$('session-visible').checked=!!rec&&rec.visibleToAide!==false;
    $('relay-export-status').hidden = !rec || relayExportSession !== rec.id;
    $('relay-actions').hidden=!rec?.relayEnabled;$('relay-online').textContent=rec?.relayEnabled?'中继 '+(rec.relayOnline==='online'?'在线':rec.relayOnline==='offline'?'离线':'状态未知')+' · '+rec.relayEndpoint:'';for(const id of ['relay-probe','relay-script','relay-export','relay-connect'])$(id).disabled=!rec||paused||(id==='relay-connect'&&(running||relayConnecting));
    $('detail-endpoint').textContent=rec?endpoint(rec):'—';
    $('detail-cwd').textContent=rec?.cwd||'—';
    const created=rec?.createdAt?new Date(rec.createdAt):null;
    $('detail-created').textContent=created&&!Number.isNaN(created.getTime())?created.toLocaleString('zh-CN',{hour12:false}):'—';
    $('detail-logging').textContent=rec?(rec.logging?(running?'● 记录中':'已启用'):'已暂停'):'未开启';
    $('detail-logging').style.color=rec?.logging?'var(--positive)':'var(--muted)';
    $('output-mode').textContent=rec?(running?'实时输出':'保留的会话输出'):'等待连接';$('display-settings').disabled=!rec;
    const graphical=!!rec&&rec.kind==='ssh'&&rec.x11Enabled;
    $('graphical').hidden=!graphical;
    $('graphical').disabled=!connected||paused||openingGraphical||!rec?.x11ViewerPort;
    $('graphical').title=rec?.x11ViewerPort?'打开此会话的图形窗口':rec?.x11Unavailable||'图形服务尚未启动';
    if (graphicalView && !viewerSession(graphicalView.id, graphicalView.port)) closeGraphical();
    $('capture-toggle').hidden=rec?.kind!=='ssh'||typeof rec.x11CaptureReady!=='boolean';
    $('capture-toggle').disabled=!connected||paused;
    $('capture-toggle').dataset.recording=String(rec?.x11Recording===true);
    $('capture-toggle').textContent=rec?.x11Recording?'正在录制 · 管理':'截图与录制';
    const captureCount=sessions.filter(session=>session.x11Recording===true).length;
    if(captureCount) $('running-count').textContent+=' · '+captureCount+' 个正在录制';
    $('empty').hidden=!!rec;
    for(const id of ['new-top','new-empty','new-session'])$(id).disabled=!connected;
    for(const id of ['find','logs','logging'])$(id).disabled=!rec;
    $('copy-session').disabled=!rec||!connected||paused||copying||!sessionCopyCapable||rec.copyable===false;
    $('copy-session').title=sessionCopyCapable?'仅复制配置 or open an independent connection':'请更新配套 Aide 宿主后使用会话复制';
    $('reconnect-session').disabled=!rec||!connected||paused||running||rec.status==='starting'||sessionReconnecting||relayConnecting||rec.reconnectable===false;
    $('reconnect-session').textContent=sessionReconnecting?'正在连接…':'重新连接';
    $('reconnect-session').title=rec?.reconnectable===false?'TCP 接入连接需由设备重新接入对应监听':'沿用原配置重新连接，保留历史日志';
    $('interrupt').disabled=!running;$('close-session').disabled=!running;$('delete-session').disabled=!rec||running||rec.status==='starting';
    $('connection').textContent=rec?endpoint(rec):'Shell / SSH / TCP / UDP / 串口';
    $('communication-send').hidden=!communication(rec);$('send-packet').disabled=!running||paused||rec?.kind==='tcp-server';$('interrupt').disabled=!running||communication(rec);
    $('logging').textContent='日志：'+(rec?.logging?'开':'关');$('logging').dataset.enabled=String(!!rec?.logging);$('logging').setAttribute('aria-pressed',String(!!rec?.logging));
    $('status').textContent=rec?(labels[rec.status]||rec.status)+' · '+rec.name:'就绪 · 创建本地或 SSH 会话';
    $('log-status').textContent=rec?.logError || (!rec?'日志保存在当前工作区':rec.logging?(running?'● 正在记录输出':'● 日志已启用'):'输出日志已暂停');
    $('log-status').style.color=rec?.logError?'var(--danger)':'';
    let displayChanged=false;for(const [id,pane] of panes){const prefs=prefsFor(id),signature=prefs.lineNumbers+':'+prefs.timestamps;if(pane.displaySignature!==signature){applyDisplayPrefs(id,pane);if(id===selected)displayChanged=true;}pane.element.hidden=id!==selected;pane.term.options.disableStdin=paused||sessions.find(s=>s.id===id)?.status!=='running';}if(displayChanged)requestAnimationFrame(fitSelected);
  }
  let graphicalView = null, openingGraphical = false, graphicalRequest = 0, viewerWindow = false, sharedWindow = false;
  const viewerSession = (id,port) => sessions.some(row=>row.id===id&&row.status==='running'&&row.x11ViewerPort===port);
  function closeGraphical() {
    graphicalRequest++;
    graphicalView?.disconnect();
    graphicalView = null;
    const pane=$('graphical-pane');
    pane.hidden=true;
    pane.parentElement.classList.remove('graphical-visible');
  }
  async function openGraphical(event) {
    if(!event.isTrusted||openingGraphical)return;
    const rec = current();
    if (!rec || rec.kind !== 'ssh' || !rec.x11Enabled) return message('当前会话未启用 X11 图形转发');
    if (!rec.x11ViewerPort) return message('图形窗口服务尚未就绪');
    const request=++graphicalRequest,port=rec.x11ViewerPort;
    let openingPane=false;
    openingGraphical=true;
    $('graphical').disabled=true;
    try {
      const args = sharedWindow ? {view:'graphics',viewerPort:port} : (viewerWindow ? {port,openInWindow:true} : {port});
      const granted = await enqueueViewer(args);
      if(request!==graphicalRequest||!viewerSession(rec.id,port))return;
      if(granted?.protocol!==1||(sharedWindow&&typeof granted.windowOpened!=='boolean'))throw Error('图形窗口响应无效');
      closeGraphical();
      if(granted.windowOpened===true)return;
      const pane=$('graphical-pane');
      openingPane=true;
      pane.hidden=false;
      pane.parentElement.classList.add('graphical-visible');
      $('graphical-title').textContent=rec.name;
      $('graphical-title').title=rec.name;
      const disconnect=AideTerminalViewer.connect(sharedWindow?granted.fallbackUrl:granted.url,{
        screen:$('graphical-screen'),state:$('graphical-state'),copy:$('graphical-copy'),
      });
      graphicalView={id:rec.id,port,disconnect};
    } catch (error) {
      if(openingPane)closeGraphical();
      if(openingPane||request===graphicalRequest)fail(error);
    } finally {
      openingGraphical=false;
      render();
    }
  }
  function select(id) {
    if(id!==selected)outputFallbackId=null;
    selected=id;terminal(id);syncOutputWatch();render();document.body.classList.remove('sidebar-open');$('sidebar-toggle').setAttribute('aria-expanded','false');
    requestAnimationFrame(()=>{fitSelected();panes.get(id)?.term.focus();});
    if(!paused)poll();
  }
  let resizeTimer;
  function fitSelected() {
    const rec=current(),pane=panes.get(selected);if(!pane||!rec)return;
    $('tabs').querySelector('.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
    pane.fit.fit();renderGutter(selected);$('dimensions').textContent=pane.term.cols+' × '+pane.term.rows;
    const cols=Math.max(20,Math.min(400,pane.term.cols)),rows=Math.max(5,Math.min(200,pane.term.rows));
    if(cols===pane.cols&&rows===pane.rows)return;
    pane.cols=cols;pane.rows=rows;clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{if(!paused&&rec.status==='running')enqueue('resize',{id:rec.id,cols,rows}).catch(fail);},180);
  }
  async function poll() {
    if(paused||stopped)return;
    if(polling){pollRequested=true;return;}
    clearTimeout(pollTimer);pollTimer=null;
    polling=true;
    let more=false;
    const id=selected,pane=panes.get(id),offset=pane?.offset||0;
    try {
      // Keep session state fresh without competing with the output stream.
      const result=await enqueue('poll',id&&!watchingOutput(id)?{id,offset}:{});
      const signature=JSON.stringify(sessions);sessions=result.sessions;inputReadback=result.capabilities?.inputReadback===true;inputReadbackFast=result.capabilities?.inputReadbackFast===true;sessionCopyCapable=result.capabilities?.sessionCopy===true;workspaceMode=result.workspace?.mode||'local';$('storage-path').textContent=result.storage||'.aide/terminal-workbench';$('kind').options[0].textContent=workspaceMode==='ssh'?'工作区 Shell · 已连接 SSH 主机':'工作区 Shell · Aide 本地环境';
      if(result.output&&pane) {
        acceptOutput(id,result.output,offset);more=!!result.output.more;
        emptyPolls=result.output.data?0:Math.min(emptyPolls+1,4);
      }
      if(!selected&&sessions.length){select(sessions[0].id);}else if(signature!==JSON.stringify(sessions))render();
      const captureRecord=sessions.find(session=>session.id===captureSession);
      if(captureRecord){
        updateCaptureButtons();
        if(!captureBusy&&Boolean(captureRecord.x11Recording)!==captureActive)void runCapture('list');
      }
      syncOutputWatch();
    } catch(error) { paused=true;stopOutputWatch();render();message('后台通信已暂停，已有会话可能仍在运行。'+error.message+'；请检查后重新打开工作台。'); }
    finally {
      polling=false;const immediate=pollRequested||more;pollRequested=false;
      const interactiveDelay=emptyPolls===0?16:Math.min(40,8*2**(emptyPolls-1));
      schedulePoll(watchingOutput(selected)?1500:document.hidden?1000:immediate?0:Date.now()<interactiveUntil?interactiveDelay:current()?.status==='running'?180:650);
    }
  }
  $('reconnect').onclick=async()=>{paused=false;outputFallbackId=null;$('notice').hidden=true;await poll();render();};
  bridge.onEvent(event=>{
    if(event.event==='scope.revoked'){paused=true;stopOutputWatch(false);render();message('工作台授权已失效，请重新打开。');}
    else receiveOutputEvent(event);
  });
  function openCreate(){syncRelay();if($('kind').value==='serial')refreshSerial();$('create-error').textContent='';$('create-dialog').showModal();$('create-form').elements.name.focus();}
  for(const id of ['new-session','new-top','new-empty'])$(id).onclick=openCreate;
  $('cancel-create').onclick=()=>$('create-dialog').close();
  let relayImportGeneration = 0, relayProfileLoaded = false;
  $('create-dialog').addEventListener('close', () => {
    relayImportGeneration++;
    relayProfileLoaded = false;
    $('create-form').elements.relayKey.value = '';
    $('relay-import-file').value = '';
    $('relay-import-status').hidden = true;
  });
  $('relay-import').onclick = () => $('relay-import-file').click();
  $('relay-import-file').onchange = async event => {
    const generation = ++relayImportGeneration;
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const pending = () => generation === relayImportGeneration && $('create-dialog').open && !paused;
    try {
      if (!file.size || file.size > AideTerminalRelayProfile.maxBytes) throw Error('中继配置文件为空或超过 16 KiB');
      const profile = AideTerminalRelayProfile.decode(await file.text());
      if (!pending()) return;
      const form = $('create-form'), fields = form.elements, target = profile.target;
      const set = (name, value) => { fields[name].value = String(value); };
      relayProfileLoaded = true;
      $('relay-enabled').checked = true;
      $('kind').value = profile.kind;
      $('kind').onchange();
      set('name', profile.name);
      set('cwd', profile.cwd || '.');
      set('relayHost', profile.relay.host);
      set('relayPort', profile.relay.port);
      set('relayKey', profile.relay.key);
      fields.logging.checked = profile.logging;
      fields.visibleToAide.checked = profile.visibleToAide;
      if (profile.kind === 'serial') {
        for (const name of ['devicePath', 'baudRate', 'dataBits', 'stopBits', 'parity']) set(name, target[name]);
        fields.flowControl.checked = target.flowControl;
      } else if (profile.kind === 'ssh') {
        for (const name of ['host', 'port', 'username', 'auth', 'x11Display', 'x11AuthorityFile']) set(name, target[name]);
        $('auth').onchange();
        set('identityFile', target.identityFile || '');
        const source = $('identity-source');
        const sourceId = target.identitySource || '';
        if (![...source.options].some(option => option.value === sourceId)) {
          const option = document.createElement('option');
          option.value = sourceId;
          option.textContent = '备份引用来源 · ' + sourceId;
          source.append(option);
        }
        source.value = sourceId;
        fields.x11Enabled.checked = target.x11Enabled;
        $('x11-enabled').onchange();
      } else {
        set('networkHost', target.host);
        set('networkPort', target.port);
        if (profile.kind === 'telnet') {
          set('terminalType', target.terminalType);
          fields.telnetLocalEcho.checked = target.telnetLocalEcho;
        }
      }
      $('create-error').textContent = '';
      $('relay-import-status').textContent = '中继配置已加载。保存后选择“连接中继”，可继续使用已部署的脚本。';
      $('relay-import-status').hidden = false;
    } catch (error) {
      if (pending()) $('create-error').textContent = error.message;
    }
  };
  $('auth').onchange=()=>{$('identity-fields').hidden=$('auth').value!=='key';};
  let keySource='', keyDirectory='.', keyPickerTarget='create';
  async function loadKeys(source='',directory='.') {
    $('key-error').textContent='';$('key-files').replaceChildren();$('key-up').disabled=true;
    try {const result=await enqueue('files',{identitySource:source,path:directory});keySource=result.source;keyDirectory=result.path;
      for(const id of ['key-source','identity-source','set-identity-source']){const select=$(id), previous=select.value;select.replaceChildren();for(const source of result.sources){const option=document.createElement('option');option.value=source.id;option.textContent=source.name;select.append(option);}select.value=id==='key-source'?keySource:previous;}
      $('key-path').textContent=keyDirectory;$('key-up').disabled=keyDirectory==='.';
      for(const file of result.entries){const button=document.createElement('button');button.type='button';button.textContent=(file.dir?'▸ ':'')+file.name;button.onclick=()=>{if(file.dir){loadKeys(keySource,file.path);return;}if(keyPickerTarget==='settings'){$('set-identity-file').value=file.path;$('set-identity-source').value=keySource;}else{$('create-form').elements.identityFile.value=file.path;$('identity-source').value=keySource;}$('identity-dialog').close();};$('key-files').append(button);}
      if(!result.entries.length)$('key-files').textContent='此目录为空';
    }catch(error){$('key-error').textContent=error.message;}
  }
  $('browse-identity').onclick=()=>{keyPickerTarget='create';$('identity-dialog').showModal();loadKeys($('identity-source').value,'.');};
  $('key-source').onchange=()=>loadKeys($('key-source').value,'.');
  $('key-up').onclick=()=>loadKeys(keySource,keyDirectory.includes('/')?keyDirectory.slice(0,keyDirectory.lastIndexOf('/')):'.');
  $('key-cancel').onclick=()=>$('identity-dialog').close();
  let serialRefresh=0;
  function syncSerialSelection(){const serial=$('kind').value==='serial';if(serial&&$('relay-enabled').checked)$('serial-port-select').value='__manual__';const manual=$('serial-port-select').value==='__manual__';$('serial-port-select').required=serial;if(serial&&$('relay-enabled').checked)$('serial-port-select').value='__manual__';$('serial-manual-field').hidden=!manual;$('create-form').elements.devicePath.disabled=!serial||!manual;$('create-form').elements.devicePath.required=serial&&manual;if(serial&&$('relay-enabled').checked)$('serial-port-select').disabled=true;}
  $('serial-port-select').onchange=syncSerialSelection;
  async function refreshSerial(){if($('relay-enabled').checked){$('serial-status').textContent='请填写中继设备侧的串口路径，如 COM3 或 /dev/ttyUSB0';return;}const request=++serialRefresh,select=$('serial-port-select'),previous=select.value;select.disabled=true;$('refresh-serial').disabled=true;$('serial-status').textContent='正在读取可用串口…';
    try{const result=await enqueue('comm',{action:'serial_list'});if(request!==serialRefresh)return;select.replaceChildren();for(const [value,label] of [['','请选择串口'],...result.ports.map(port=>[port.path,[port.path,port.manufacturer,port.serialNumber].filter(Boolean).join(' · ')]),['__manual__','手动输入设备路径…']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}select.value=[...select.options].some(option=>option.value===previous)?previous:'';$('serial-status').textContent=result.error||result.warning||(result.ports.length?'发现 '+result.ports.length+' 个串口，请选择设备':'未发现可用串口；请检查设备映射，也可手动输入路径');}
    catch(error){$('serial-status').textContent='无法读取串口列表：'+error.message;}
    finally{if(request===serialRefresh){select.disabled=false;$('refresh-serial').disabled=false;syncSerialSelection();}}
  }
  $('kind').onchange=()=>{const kind=$('kind').value,ssh=kind==='ssh';$('ssh-fields').hidden=!ssh;$('network-fields').hidden=!['telnet','tcp','tcp-server','udp'].includes(kind);$('serial-fields').hidden=kind!=='serial';$('udp-bind-field').hidden=kind!=='udp';for(const name of ['host','username'])$('create-form').elements[name].required=ssh;$('create-form').elements.networkHost.disabled=kind==='tcp-server';$('telnet-fields').hidden=kind!=='telnet';$('x11-fields').hidden=!ssh;$('create-form').elements.x11Enabled.disabled=!ssh;syncRelay();syncSerialSelection();if(kind==='telnet'&&Number($('create-form').elements.networkPort.value)===0)$('create-form').elements.networkPort.value='23';if(kind==='serial')refreshSerial();};
  const directHints={network:$('network-hint').textContent,serial:$('serial-hint').textContent,ssh:$('ssh-hint').textContent};
  function syncRelay(){const allowed=['ssh','telnet','tcp','udp','serial'].includes($('kind').value);$('relay-enabled').disabled=!allowed;if(!allowed)$('relay-enabled').checked=false;const enabled=$('relay-enabled').checked;$('relay-fields').hidden=!enabled;$('cwd-field').hidden=enabled;$('udp-bind-field').hidden=enabled||$('kind').value!=='udp';$('network-hint').textContent=enabled?'目标主机和端口由中继电脑访问；本端到中继通过加密 TCP 连接。':directHints.network;$('serial-hint').textContent=enabled?'填写中继电脑上的串口路径；设备侧脚本需要 pyserial，本端无需映射该设备。':directHints.serial;$('ssh-hint').textContent=enabled?'目标由中继访问；SSH 主机指纹核验、密码和私钥认证仍在本端完成，凭据不写入部署脚本。':directHints.ssh;for(const name of ['relayHost','relayPort','relayKey']){$('create-form').elements[name].disabled=!enabled;$('create-form').elements[name].required=enabled&&name!=='relayKey';}$('create-submit').textContent=enabled?(relayProfileLoaded?'保存中继会话':'保存并部署中继'):'创建并连接';syncSerialSelection();}
  $('relay-enabled').onchange=()=>{syncRelay();if($('kind').value==='serial')refreshSerial();};
  $('refresh-serial').onclick=refreshSerial;
  $('send-format').onchange=()=>{$('send-ending').disabled=$('send-format').value==='hex';};
  // AIDE 的 Workbench iframe 以 allow-scripts allow-downloads 沙箱加载，没有
  // allow-forms，原生 form 提交事件不会触发（issue #35）。发送改由按钮 click
  // 显式驱动；submit 处理器保留，作为非沙箱环境与键盘路径的兼容入口。
  let sendingPacket = false;
  async function sendPacket() {
    if (sendingPacket) return;
    const rec = current(); if (!rec || !communication(rec)) return;
    let data = $('send-data').value;
    const format = $('send-format').value;
    if (format === 'utf8') data += ({lf:'\n',crlf:'\r\n',cr:'\r'}[$('send-ending').value] || '');
    sendingPacket = true; $('send-packet').disabled = true;
    try { await enqueue('input', {id:rec.id, data, format}); }
    catch (error) { message('发送结果待核实，不会自动重发。' + error.message); }
    finally { sendingPacket = false; render(); }
  }
  $('send-packet').onclick = event => { event.preventDefault(); void sendPacket(); };
  $('communication-send').onsubmit = event => { event.preventDefault(); void sendPacket(); };
  $('create-submit').onclick=async event=>{
    event.preventDefault();const form=$('create-form');if($('kind').value==='serial'&&!$('relay-enabled').checked&&$('serial-port-select').disabled){$('create-error').textContent='请等待串口列表读取完成';return;}if(!form.reportValidity())return;const values=new FormData(form),args={kind:values.get('kind'),name:values.get('name'),cwd:values.get('cwd')||'.',logging:form.elements.logging.checked,visibleToAide:form.elements.visibleToAide.checked};
    if(args.kind==='ssh')Object.assign(args,{host:values.get('host'),port:Number(values.get('port')),username:values.get('username'),auth:values.get('auth'),identityFile:values.get('auth')==='key'?values.get('identityFile')||undefined:undefined,identitySource:values.get('auth')==='key'?values.get('identitySource')||'':undefined});
    if(args.kind==='ssh'&&form.elements.x11Enabled.checked)Object.assign(args,{x11Enabled:true,x11Display:values.get('x11Display')||undefined,x11AuthorityFile:values.get('x11AuthorityFile')||undefined});
    if(args.kind==='ssh'&&args.auth==='key'&&!args.identityFile){$('create-error').textContent='请选择私钥文件';return;}
    if(args.kind==='telnet'){args.terminalType=values.get('terminalType');args.telnetLocalEcho=form.elements.telnetLocalEcho.checked;}
    if(['telnet','tcp','tcp-server','udp'].includes(args.kind))Object.assign(args,{host:args.kind==='tcp-server'?'127.0.0.1':values.get('networkHost'),port:Number(values.get('networkPort')),bindPort:Number(values.get('bindPort'))});
    if(args.kind==='serial')Object.assign(args,{devicePath:$('serial-port-select').value==='__manual__'?values.get('devicePath'):$('serial-port-select').value,baudRate:Number(values.get('baudRate')),dataBits:Number(values.get('dataBits')),stopBits:Number(values.get('stopBits')),parity:values.get('parity'),flowControl:form.elements.flowControl.checked});
    if($('relay-enabled').checked)args.relay={enabled:true,host:values.get('relayHost'),port:Number(values.get('relayPort')),key:values.get('relayKey')||undefined};
    $('create-submit').disabled=true;$('create-error').textContent='';
    try {const result=await enqueue('create',args);sessions.push(result.session);form.elements.relayKey.value='';$('create-dialog').close();paused=false;select(result.session.id);}
    catch(error){$('create-error').textContent=error.message;}
    finally{$('create-submit').disabled=false;}
  };
  $('create-form').onkeydown=event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'&&event.target.type!=='checkbox'){event.preventDefault();$('create-submit').click();}};
  $('interrupt').onclick=()=>{if(selected)enqueue('input',{id:selected,data:'\x03'}).catch(fail);};
  $('reconnect-session').onclick=async()=>{
    const rec=current();if(!rec||sessionReconnecting||rec.status==='running'||rec.status==='starting'||rec.reconnectable===false)return;
    sessionReconnecting=true;pendingInput.delete(rec.id);render();
    try{const result=await enqueue('relay_connect',{id:rec.id});Object.assign(rec,result.session);select(rec.id);schedulePoll();}
    catch(error){message('重新连接失败：'+error.message);await poll();}
    finally{sessionReconnecting=false;render();}
  };
  $('close-session').onclick=async()=>{
    const rec=current();if(!rec||!(await confirmAction('结束“'+rec.name+'”的连接？正在运行的设备命令可能中断，日志会保留。')))return;
    try{pendingInput.delete(rec.id);await enqueue('close',{id:rec.id});await poll();}catch(error){fail(error);}
  };
  $('delete-session').onclick=async()=>{
    const rec=current();if(!rec||!(await confirmAction('永久删除“'+rec.name+'”的会话记录、日志和采集文件？')))return;
    try{await enqueue('delete',{id:rec.id});panes.get(rec.id)?.term.dispose();panes.get(rec.id)?.element.remove();panes.delete(rec.id);displayPrefs.delete(rec.id);try{localStorage.removeItem('aide.terminal.display.'+rec.id);}catch(_){}sessions=sessions.filter(s=>s.id!==rec.id);selected=null;if(sessions.length)select(sessions[0].id);else render();}
    catch(error){fail(error);}
  };
  $('session-visible').onchange=async()=>{const rec=current();if(!rec)return;try{const result=await enqueue('visibility',{id:rec.id,visible:$('session-visible').checked});Object.assign(rec,result.session);render();}catch(error){render();fail(error);}};
  $('x11-enabled').onchange=()=>{$('x11-settings').hidden=true;};
  let copySource=null;
  $('copy-session').onclick=()=>{const rec=current();if(!rec||!sessionCopyCapable||rec.copyable===false)return;copySource=rec.id;$('copy-source').textContent='源会话：'+rec.name+' / '+endpoint(rec)+(rec.relayEnabled?' / 已部署中继':'');$('copy-name').value=(rec.name.slice(0,70)+' 副本');$('copy-error').textContent='';$('copy-connect').disabled=rec.copyConnectable===false;$('copy-exclusive').hidden=rec.copyConnectable!==false;$('copy-independent-ssh').hidden=rec.kind!=='workspace';$('copy-dialog').showModal();};
  $('copy-cancel').onclick=()=>$('copy-dialog').close();
  async function copySession(connect){if(copying||!copySource)return;const name=$('copy-name').value.trim();if(!name){$('copy-error').textContent='请填写新会话名称';return;}copying=true;for(const id of ['copy-settings','copy-connect','copy-independent-ssh'])$(id).disabled=true;
    try{const result=await enqueue('create',{copyFrom:copySource,name,connect});sessions.push(result.session);$('copy-dialog').close();paused=false;select(result.session.id);message(connect?'已创建独立连接；请在新终端中完成认证。':'已复制配置。点击“重新连接”启动这个独立会话。');}
    catch(error){$('copy-error').textContent=error.message;await poll();}
    finally{copying=false;$('copy-settings').disabled=false;$('copy-connect').disabled=sessions.find(s=>s.id===copySource)?.copyConnectable===false;$('copy-independent-ssh').disabled=false;render();}
  }
  $('copy-settings').onclick=()=>copySession(false);$('copy-connect').onclick=()=>copySession(true);
  $('copy-independent-ssh').onclick=()=>{const rec=sessions.find(s=>s.id===copySource);if(!rec||rec.kind!=='workspace')return;$('copy-dialog').close();$('kind').value='ssh';$('relay-enabled').checked=false;$('kind').onchange();const f=$('create-form');f.elements.name.value=rec.name.slice(0,65)+' SSH';f.elements.host.value=rec.host||'';f.elements.port.value=String(rec.port||22);f.elements.username.value=rec.username||'';$('auth').value='password';$('auth').onchange();f.elements.identityFile.value='';f.elements.x11Enabled.checked=true;$('x11-enabled').onchange();openCreate();message('独立 SSH 需要重新认证，不复用工作区 master 或复制其凭据；已默认启用 Aide 内置图形窗口。');};
  $('relay-probe').onclick=async()=>{const rec=current();if(!rec?.relayEnabled)return;$('relay-probe').disabled=true;try{const result=await enqueue('relay_status',{id:rec.id});Object.assign(rec,result.session);render();}catch(error){fail(error);}finally{$('relay-probe').disabled=false;}};
  $('relay-connect').onclick=async()=>{const rec=current();if(!rec?.relayEnabled||relayConnecting)return;relayConnecting=true;$('relay-connect').disabled=true;try{const result=await enqueue('relay_connect',{id:rec.id,identityFile:rec.identityFile,identitySource:rec.identitySource});Object.assign(rec,result.session);select(rec.id);}catch(error){message('中继连接失败：'+error.message);}finally{relayConnecting=false;render();}};
  async function exportRelay(format) {
    const rec = current();
    if (!rec?.relayEnabled || paused) return;
    try {
      const result = await enqueue('relay_script', {id: rec.id, ...(format ? {format} : {})});
      if (paused || current()?.id !== rec.id) return;
      const output = bytes(result.data);
      window.parent.postMessage({type: 'aide.workbench.export', protocol: 1, pluginId: 'terminal',
        requestId: 'export_' + (++exportId), name: result.name, bytes: output.buffer}, '*', [output.buffer]);
      relayExportSession = format === 'profile' ? rec.id : null;
      const status = $('relay-export-status');
      status.textContent = '请在 Aide 顶部保存。备份含中继密钥，请私下保管。';
      status.hidden = relayExportSession === null;
    } catch (error) {
      fail(error);
    }
  }
  $('relay-script').onclick = () => exportRelay();
  $('relay-export').onclick = () => exportRelay('profile');
  setInterval(()=>{if(current()?.relayEnabled&&!sessionReconnecting&&!relayConnecting&&!sessions.some(rec=>rec.status==='running')&&!paused&&!$('relay-probe').disabled)$('relay-probe').click();},15000);
  function endpointParts(value) {
    const text=String(value||''), index=text.lastIndexOf(':');
    if(index<=0)return {host:'',port:17780};
    const port=Number(text.slice(index+1));
    return {host:text.slice(0,index),port:Number.isInteger(port)&&port>0?port:17780};
  }
  function settingsShow(rec) {
    const kind=rec.kind, incoming=kind==='tcp'&&rec.connectionRole!=='client';
    const show=(id,visible)=>$(id).hidden=!visible;
    show('set-network',['ssh','telnet','tcp','udp','tcp-server'].includes(kind)&&!incoming);
    show('set-ssh',kind==='ssh');show('set-telnet',kind==='telnet');show('set-udp',kind==='udp');show('set-serial',kind==='serial');
    show('set-cwd',['local','workspace','ssh'].includes(kind));
    show('set-relay',['ssh','telnet','tcp','udp','serial'].includes(kind)&&!incoming);
    $('set-host-label').hidden=kind==='tcp-server';$('set-port-text').textContent=kind==='tcp-server'?'监听端口':'端口';
  }
  function openSettings() {
    const rec=current();if(!rec)return;
    settingsShow(rec);$('set-error').textContent='';
    const value=(id,v)=>$(id).value=v===undefined||v===null?'':String(v);
    value('set-name',rec.name);$('set-visible').checked=rec.visibleToAide!==false;$('set-logging').checked=rec.logging!==false;
    applyDisplayPrefs(rec.id);
    value('set-host',rec.host);value('set-port',rec.port);value('set-username',rec.username);$('set-auth').value=rec.auth||'default';
    value('set-identity-source',rec.identitySource);value('set-identity-file',rec.identityFile);$('set-identity').hidden=$('set-auth').value!=='key';
    $('set-x11').checked=!!rec.x11Enabled;$('set-x11-fields').hidden=!rec.x11Enabled;value('set-x11-display',rec.x11ConfiguredDisplay??rec.x11Display);value('set-x11-authority',rec.x11AuthorityFile);
    value('set-terminal-type',rec.terminalType||'xterm-256color');$('set-telnet-echo').checked=!!rec.telnetLocalEcho;
    value('set-bind-port',rec.bindPort||0);$('set-multicast').checked=!!rec.multicast;
    value('set-device-path',rec.devicePath);value('set-baud',rec.baudRate||115200);$('set-data-bits').value=String(rec.dataBits||8);$('set-stop-bits').value=String(rec.stopBits||1);$('set-parity').value=rec.parity||'none';$('set-flow').checked=!!rec.flowControl;
    value('set-cwd-input',rec.cwd||'.');
    const relay=endpointParts(rec.relayEndpoint);$('set-relay-enabled').checked=!!rec.relayEnabled;value('set-relay-host',relay.host);value('set-relay-port',relay.port);value('set-relay-key','');$('set-relay-fields').hidden=!rec.relayEnabled;
    $('settings-dialog').showModal();
    if(rec.kind==='ssh')loadKeys(rec.identitySource||'', '.').then(()=>{$('set-identity-source').value=rec.identitySource||'';}).catch(()=>{});
  }
  async function saveSettings(reconnect) {
    const rec=current();if(!rec)return;
    const args={id:rec.id},errors=[];
    const textChange=(id,key)=>{const v=$(id).value.trim();if(v!==String(rec[key]||''))args[key]=v;};
    const boolChange=(id,key)=>{if($(id).checked!==!!rec[key])args[key]=$(id).checked;};
    const numChange=(id,key)=>{const n=Number($(id).value);if(n!==Number(rec[key]||0))args[key]=n;};
    const name=$('set-name').value.trim();if(!name)errors.push('会话名称不能为空');else if(name!==rec.name)args.name=name;
    boolChange('set-visible','visibleToAide');boolChange('set-logging','logging');
    const lineNumbers=$('show-line-numbers').checked,timestamps=$('show-timestamps').checked,prefs=prefsFor(rec.id);
    if(lineNumbers!==prefs.lineNumbers||timestamps!==prefs.timestamps){args.displayLineNumbers=lineNumbers;args.displayTimestamps=timestamps;}
    if(!$('set-network').hidden){if(!$('set-host-label').hidden)textChange('set-host','host');numChange('set-port','port');}
    if(rec.kind==='ssh'){
      textChange('set-username','username');const auth=$('set-auth').value;if(auth!==(rec.auth||'default'))args.auth=auth;
      if(auth==='key'){textChange('set-identity-source','identitySource');textChange('set-identity-file','identityFile');if(!$('set-identity-file').value.trim())errors.push('私钥认证需要填写私钥文件');}
      if($('set-x11').checked!==!!rec.x11Enabled)args.x11Enabled=$('set-x11').checked;
      if($('set-x11').checked){const display=$('set-x11-display').value.trim(),authority=$('set-x11-authority').value.trim();if(display!==String(rec.x11ConfiguredDisplay??rec.x11Display??''))args.x11Display=display;if(authority!==String(rec.x11AuthorityFile||''))args.x11AuthorityFile=authority;}
    }
    if(rec.kind==='telnet'){textChange('set-terminal-type','terminalType');boolChange('set-telnet-echo','telnetLocalEcho');}
    if(rec.kind==='udp'){numChange('set-bind-port','bindPort');boolChange('set-multicast','multicast');}
    if(rec.kind==='serial'){textChange('set-device-path','devicePath');numChange('set-baud','baudRate');const bits=Number($('set-data-bits').value),stop=Number($('set-stop-bits').value),parity=$('set-parity').value;if(bits!==Number(rec.dataBits||8))args.dataBits=bits;if(stop!==Number(rec.stopBits||1))args.stopBits=stop;if(parity!==(rec.parity||'none'))args.parity=parity;boolChange('set-flow','flowControl');}
    if(!$('set-cwd').hidden)textChange('set-cwd-input','cwd');
    if(!$('set-relay').hidden){
      const enabled=$('set-relay-enabled').checked,old=endpointParts(rec.relayEndpoint),host=$('set-relay-host').value.trim(),port=Number($('set-relay-port').value||17780),key=$('set-relay-key').value.trim();
      const changed=enabled!==!!rec.relayEnabled||(enabled&&(host!==old.host||port!==old.port||key));
      if(changed){if(enabled&&!host)errors.push('启用中继需要填写中继地址');args.relay={enabled};if(enabled){args.relay.host=host;args.relay.port=port;if(key)args.relay.key=key;}}
    }
    if(errors.length){$('set-error').textContent=errors[0];return;}
    if(Object.keys(args).length===1){$('settings-dialog').close();message('没有需要保存的改动');return;}
    const save=$('settings-save'),again=$('settings-reconnect');save.disabled=true;again.disabled=true;$('set-error').textContent='';
    try {
      const result=await enqueue('configure',args);Object.assign(rec,result.session);
      if(args.displayLineNumbers!==undefined){prefs.lineNumbers=args.displayLineNumbers;prefs.timestamps=args.displayTimestamps;applyDisplayPrefs(rec.id);fitSelected();try{localStorage.setItem('aide.terminal.display.'+rec.id,JSON.stringify(prefs));}catch(_){ }}
      $('settings-dialog').close();
      if(reconnect){await enqueue('relay_connect',{id:rec.id});message('设置已保存，正在重新连接…');}
      else message(result.requiresReconnect?'设置已保存；重新连接后生效':'设置已保存');
      render();
    } catch(error) {if($('settings-dialog').open)$('set-error').textContent=error.message;else fail(error);}
    finally {save.disabled=false;again.disabled=false;}
  }
  $('display-settings').onclick=openSettings;
  $('settings-cancel').onclick=()=>$('settings-dialog').close();
  $('settings-form').onsubmit=event=>{event.preventDefault();saveSettings(false);};
  $('settings-save').onclick=()=>saveSettings(false);
  $('settings-reconnect').onclick=()=>saveSettings(true);
  $('set-auth').onchange=()=>{$('set-identity').hidden=$('set-auth').value!=='key';};
  $('set-x11').onchange=()=>{$('set-x11-fields').hidden=!$('set-x11').checked;};
  $('set-relay-enabled').onchange=()=>{$('set-relay-fields').hidden=!$('set-relay-enabled').checked;};
  $('set-browse-identity').onclick=()=>{keyPickerTarget='settings';$('identity-dialog').showModal();loadKeys($('set-identity-source').value,'.');};
  $('logging').onclick=async()=>{const rec=current();if(!rec)return;try{const result=await enqueue('logging',{id:rec.id,enabled:!rec.logging});Object.assign(rec,result.session);render();}catch(error){fail(error);}};
  $('find').onclick=()=>{$('search-bar').hidden=false;$('search-input').focus();fitSelected();};
  $('search-close').onclick=()=>{$('search-bar').hidden=true;panes.get(selected)?.search.clearDecorations();fitSelected();};
  const find=forward=>{const pane=panes.get(selected);if(pane)pane.search[forward?'findNext':'findPrevious']($('search-input').value,{incremental:false});};
  $('search-input').oninput=()=>find(true);$('search-next').onclick=()=>find(true);$('search-prev').onclick=()=>find(false);
  $('search-input').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();find(!event.shiftKey);}};
  $('logs').onclick=async()=>{
    const rec=current();if(!rec)return;const id=rec.id;
    $('logs-dialog').showModal();$('log-files').textContent='正在读取…';$('log-progress').textContent='';
    try {
      const result=await enqueue('logs',{id});$('log-files').replaceChildren();
      if(!result.files.length)$('log-files').textContent='暂无日志。只有开启日志后接收到的终端输出会保存。';
      for(const file of result.files) {
        const row=document.createElement('div');row.className='log-file';
        const label=document.createElement('span');label.textContent=(file.index?'历史分卷 '+file.index:'当前日志')+' · '+(file.bytes/1024).toFixed(1)+' KiB';
        const button=document.createElement('button');button.textContent='准备下载';
        button.onclick=async()=>{
          for(const b of $('log-files').querySelectorAll('button'))b.disabled=true;
          const chunks=[];let offset=0,identity,target=file.bytes;
          try {
            do {const page=await enqueue('logs',{id,index:file.index,offset,identity});identity=page.identity;
              const chunk=bytes(page.data).subarray(0,Math.max(0,target-offset));chunks.push(chunk);
              if(!chunk.length&&offset<target)throw Error('日志文件已变化，请重新打开日志列表');
              offset+=chunk.length;$('log-progress').textContent='准备日志 '+Math.min(100,Math.round(offset/Math.max(1,target)*100))+'%';
            }while(offset<target);
            const output=new Uint8Array(offset);let position=0;for(const chunk of chunks){output.set(chunk,position);position+=chunk.length;}
            if(!output.length)throw Error('日志文件为空');
            window.parent.postMessage({type:'aide.workbench.export',protocol:1,pluginId:'terminal',requestId:'export_'+(++exportId),name:'terminal-'+id+(file.index?'-'+file.index:'')+'.log',bytes:output.buffer},'*',[output.buffer]);
            $('log-progress').textContent='已准备。请点击 Aide 顶部“保存文件”完成下载。';
          }catch(error){$('log-progress').textContent=error.message;}
          finally{for(const b of $('log-files').querySelectorAll('button'))b.disabled=false;}
        };row.append(label,button);$('log-files').append(row);
      }
    }catch(error){$('log-files').textContent=error.message;}
  };
  $('close-logs').onclick=()=>$('logs-dialog').close();
  let captureSession=null, captureActive=false, captureBusy=false, captureExportRequest=null;
  const captureLimit=16*1024*1024;
  const captureNote=text=>{$('capture-status').textContent=text;};
  const captureCall=(action,args={})=>enqueue('comm',{action:'session_capture',arguments:{id:captureSession,action,...args}});
  function updateCaptureButtons() {
    const rec=sessions.find(session=>session.id===captureSession);
    const ready=rec?.x11CaptureReady===true&&!paused&&!captureBusy;
    $('capture-shot').disabled=!ready;
    $('capture-duration').disabled=!ready||captureActive;
    $('capture-start').disabled=!ready||captureActive;
    $('capture-stop').disabled=paused||captureBusy||!captureActive;
    $('capture-close').disabled=captureBusy;
    for(const button of $('capture-files').querySelectorAll('button'))button.disabled=paused||captureBusy;
  }
  async function saveCapture(file,event) {
    if(!event.isTrusted||captureBusy||paused)return;
    captureBusy=true;
    captureExportRequest=null;
    updateCaptureButtons();
    try {
      const output=new Uint8Array(file.bytes);
      for(let offset=0;offset<output.length;){
        const part=await captureCall('read',{captureId:file.id,offset});
        const chunk=bytes(part.data);
        if(part.name!==file.name||part.bytes!==output.length||part.offset!==offset||
          part.nextOffset!==offset+chunk.length||!chunk.length||chunk.length>256*1024||
          part.nextOffset>output.length)throw Error('采集文件已变化，请重新打开列表');
        output.set(chunk,offset);
        offset=part.nextOffset;
        captureNote('准备下载 '+Math.round(offset/output.length*100)+'%');
      }
      captureExportRequest='export_'+(++exportId);
      window.parent.postMessage({type:'aide.workbench.export',protocol:1,pluginId:'terminal',
        requestId:captureExportRequest,name:file.name,bytes:output.buffer},'*',[output.buffer]);
      captureNote('已准备。请点击 Aide 顶部“保存文件”。');
    } catch(error) {captureNote(error.message);}
    finally {captureBusy=false;updateCaptureButtons();}
  }
  function updateCaptureFiles(files) {
    const list=$('capture-files');
    list.replaceChildren();
    for(const file of files.slice(0,12)){
      if(!/^[a-f0-9]{24}$/.test(file?.id)||!['image/png','video/webm'].includes(file.mime)||
        !Number.isInteger(file.bytes)||file.bytes<1||file.bytes>captureLimit||typeof file.name!=='string')continue;
      const row=document.createElement('div');row.className='log-file';
      const label=document.createElement('span');label.textContent=file.name+' · '+(file.bytes/1024).toFixed(1)+' KiB';
      const button=document.createElement('button');button.type='button';button.textContent='准备下载';
      button.addEventListener('click',event=>void saveCapture(file,event));
      row.append(label,button);list.append(row);
    }
    if(!list.children.length)list.textContent='暂无采集文件';
  }
  async function runCapture(action,args={}) {
    if(!captureSession||captureBusy||paused)return;
    captureBusy=true;
    updateCaptureButtons();
    try {
      const result=await captureCall(action,args);
      if(typeof result?.active!=='boolean'||!Array.isArray(result.captures))throw Error('采集响应无效');
      const finished=captureActive&&!result.active;
      captureActive=result.active;
      updateCaptureFiles(result.captures);
      const text=captureActive?'正在录制 WebM。关闭图形窗口后仍会继续。':
        (action==='screenshot'?'PNG 截图已生成。':action==='stop'||finished?'录制已结束。':'');
      captureNote(result.error||text);
    } catch(error) {captureNote(error.message);}
    finally {captureBusy=false;updateCaptureButtons();}
  }
  $('capture-toggle').onclick=event=>{
    if(!event.isTrusted||paused||captureBusy)return;
    const rec=current();
    if(rec?.kind!=='ssh')return;
    captureSession=rec.id;
    captureActive=rec.x11Recording===true;
    captureExportRequest=null;
    $('capture-session').textContent=rec.name;
    $('capture-files').replaceChildren();
    captureNote('正在读取采集文件…');
    $('capture-dialog').showModal();
    void runCapture('list');
  };
  $('capture-shot').onclick=event=>{if(event.isTrusted)void runCapture('screenshot');};
  $('capture-start').onclick=event=>{
    if(!event.isTrusted)return;
    const seconds=$('capture-duration').valueAsNumber;
    if(!Number.isInteger(seconds)||seconds<1||seconds>120){captureNote('请输入 1–120 秒之间的整数。');return;}
    void runCapture('start',{seconds});
  };
  $('capture-stop').onclick=event=>{if(event.isTrusted)void runCapture('stop');};
  $('capture-close').onclick=()=>$('capture-dialog').close();
  $('capture-dialog').oncancel=event=>{if(captureBusy)event.preventDefault();};
  $('capture-dialog').onclose=()=>{captureSession=null;captureActive=false;captureExportRequest=null;};
  $('session-search').oninput=render;
  for(const button of document.querySelectorAll('[data-filter]'))button.onclick=()=>{sessionFilter=button.dataset.filter;render();};
  $('sidebar-toggle').setAttribute('aria-expanded','false');
  $('sidebar-toggle').onclick=()=>{const open=document.body.classList.toggle('sidebar-open');$('sidebar-toggle').setAttribute('aria-expanded',String(open));if(open)$('session-search').focus();};
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){document.body.classList.remove('sidebar-open');$('sidebar-toggle').setAttribute('aria-expanded','false');if(!$('search-bar').hidden)$('search-close').click();}});
  new ResizeObserver(fitSelected).observe($('terminal-area'));
  window.addEventListener('message',event=>{
    if(event.source!==window.parent)return;
    const m=event.data;
    if(m?.type==='aide.workbench.export.status'&&m.pluginId==='terminal'&&m.status==='error'){
      if(captureExportRequest&&m.requestId===captureExportRequest)captureNote(m.error);
      else $('log-progress').textContent=m.error;
    }
    if(m?.type==='aide.workbench.theme'&&m.protocol===1){
      // Terminal stays dark for device color fidelity; surrounding chrome follows host theme.
      const colors=m.colors||{};
      for(const key of ['bg','panel','text','muted','line'])if(typeof colors[key]==='string'&&CSS.supports('color',colors[key]))document.documentElement.style.setProperty('--'+key,colors[key]);
      document.documentElement.style.colorScheme=m.theme==='light'?'light':'dark';document.documentElement.dataset.theme=m.theme;
    }
  });
  window.parent.postMessage({type:'aide.workbench.theme.ready',protocol:1},'*');
  $('graphical').onclick=openGraphical;
  $('graphical-close').onclick=closeGraphical;
  window.addEventListener('pagehide',()=>{closeGraphical();stopped=true;stopOutputWatch(false);clearTimeout(pollTimer);bridge.close();pendingInput.clear();});
  render();bridge.connect().then(info=>{
    if(!['bridge.renew','daemon.detach'].every(x=>info.capabilities?.includes(x)))throw Error('请先更新 Aide：此工作台需要支持通信续期和常驻会话分离的宿主版本。');
    viewerWindow=info.capabilities.includes('viewer.window');
    sharedWindow=info.capabilities.includes('window.open');
    outputPush=info.capabilities.includes('terminal.output');
    connected=true;paused=false;render();return poll();
  }).catch(error=>{paused=true;render();fail(error);});
})();
