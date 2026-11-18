'use strict';
(() => {
  function socketURL(path) {
    if (typeof path !== 'string' || !/^\/plugin-viewer\/[a-f0-9]{64}\/websockify$/.test(path)) {
      throw Error('图形窗口地址无效');
    }
    const url = new URL(path, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    const area = document.createElement('textarea');
    area.value = text;
    area.readOnly = true;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) {}
    area.remove();
    return copied;
  }

  function connect(path, {screen, state, copy, clearOnDisconnect=false}) {
    const url = socketURL(path);
    if (typeof AideTerminalRFB !== 'function') throw Error('图形组件未加载，请重新打开工作台');
    let clipboard = '', connected = true;
    state.textContent = '正在连接图形窗口';
    copy.hidden = true;
    const client = new AideTerminalRFB(screen, url, {credentials: {password: ''}});
    client.clipViewport = false;
    client.scaleViewport = true;
    client.focusOnClick = true;
    const clear = () => {
      connected = false;
      clipboard = '';
      copy.hidden = true;
      copy.onclick = null;
      screen.onpaste = null;
    };
    client.addEventListener('connect', () => {
      if (connected) state.textContent = '图形已连接';
    });
    client.addEventListener('disconnect', event => {
      if (!connected) return;
      clear();
      if (clearOnDisconnect) screen.replaceChildren();
      state.textContent = event.detail?.clean === false ? '图形窗口连接中断' : '图形窗口已断开';
    });
    client.addEventListener('clipboard', event => {
      if (!connected || typeof event.detail?.text !== 'string') return;
      clipboard = event.detail.text;
      copy.hidden = !clipboard;
    });
    copy.onclick = async () => {
      if (!clipboard || !connected) return;
      const copied = await writeClipboard(clipboard);
      if (connected) state.textContent = copied ? '已复制远程剪贴板' : '浏览器未允许复制';
    };
    screen.onpaste = event => {
      const text = event.clipboardData?.getData('text');
      if (text && connected) { client.clipboardPasteFrom(text); event.preventDefault(); }
    };
    return () => {
      if (connected) {
        clear();
        client.disconnect();
      }
      screen.replaceChildren();
    };
  }

  window.AideTerminalViewer = {connect};
})();
