'use strict';
(() => {
  const state = document.getElementById('viewer-state');
  document.getElementById('viewer-close').onclick = () => window.close();
  try {
    const path = location.pathname.replace(/\/window$/, '/websockify');
    if (path === location.pathname) throw Error('图形窗口地址无效');
    const disconnect = AideTerminalViewer.connect(path, {
      screen: document.getElementById('viewer-screen'),
      state,
      copy: document.getElementById('viewer-copy'),
    });
    window.addEventListener('pagehide', disconnect, {once:true});
  } catch (error) {
    state.textContent = error.message;
  }
})();
