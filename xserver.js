'use strict';
/* 受管 X display 生命周期（issue #40 第一阶段）。
 *
 * 只负责在 Aide 运行环境内拉起/回收一个本地 Xvfb display，并为它生成
 * 每 display 唯一的 MIT-MAGIC-COOKIE-1 Xauthority：
 *   - Xvfb 只使用 Unix socket（-nolisten tcp），不监听任何 TCP 端口；
 *   - cookie 文件放在 0700 私有临时目录，stop 时删除；
 *   - 不安装、不修改系统 X Server，不读取用户 ~/.Xauthority。
 *
 * 同一受管 display 可选附带图形窗口通道：openbox（窗口管理）+ x11vnc（只绑
 * 127.0.0.1）+ websockify（只绑 127.0.0.1）。Workbench 通过宿主的
 * /plugin-viewer 一次性票据连入，插件本身不暴露任何非回环端口。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const MAX_SERVERS = 16;
const DISPLAY_MIN = 90;
const DISPLAY_MAX = 129;
const WIDTH = [640, 7680], HEIGHT = [480, 4320], DEPTHS = [16, 24];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function waitPort(port, timeout = 6000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(Error('窗口服务 ' + port + ' 未就绪'));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function usableBinary(bin, args, env) {
  const probe = spawnSync(bin, args, { encoding: 'utf8', timeout: 3000, env, maxBuffer: 8192 });
  return !probe.error || probe.error.code !== 'ENOENT';
}

function integer(value, fallback, min, max, label) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Error(label + ' 必须为 ' + min + '–' + max + ' 的整数');
  return n;
}

function findXauth(env) {
  if (env.TERMINAL_XAUTH_BIN) return env.TERMINAL_XAUTH_BIN;
  const locations = [...(env.PATH || '').split(path.delimiter), ...(process.platform === 'darwin' ? ['/opt/X11/bin'] : [])];
  return locations.map(p => path.join(p, 'xauth')).find(p => {
    try { return path.isAbsolute(p) && fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
  });
}

class XServers {
  constructor(options = {}) {
    this.servers = new Map();
    this.seq = 0;
    this.env = options.env || process.env;
    this.bin = options.bin || this.env.TERMINAL_XVFB_BIN || 'Xvfb';
    this.x11vnc = options.x11vnc || this.env.TERMINAL_X11VNC_BIN || 'x11vnc';
    this.websockify = options.websockify || this.env.TERMINAL_WEBSOCKIFY_BIN || 'websockify';
    this.openbox = options.openbox || this.env.TERMINAL_OPENBOX_BIN || 'openbox';
    this.spawnImpl = options.spawnImpl || spawn;
    this.xauth = options.xauth || findXauth(this.env);
  }

  list() {
    return [...this.servers.values()].map(server => this.public(server));
  }

  public(server) {
    return { serverId: server.id, display: server.display, width: server.width, height: server.height, depth: server.depth, status: server.status, startedAt: server.startedAt, pid: server.process?.pid || null, viewer: server.viewer ? { status: server.viewer.status, wsPort: server.viewer.wsPort || null } : null };
  }

  authorityFile(serverId) {
    const server = this.servers.get(String(serverId));
    return server?.cookieFile && fs.existsSync(server.cookieFile) ? server.cookieFile : null;
  }

  usage() { return this.servers.size; }

  freeDisplay(requested) {
    const start = requested || DISPLAY_MIN;
    for (let n = start; n <= DISPLAY_MAX; n++) {
      if ([...this.servers.values()].some(s => s.display === ':' + n)) continue;
      // 已存在的 /tmp/.X11-unix/X<n> 说明该 display 已被其他进程占用。
      if (fs.existsSync(path.join(os.tmpdir(), '.X11-unix', 'X' + n))) continue;
      return ':' + n;
    }
    throw Error('no free X display in :' + DISPLAY_MIN + '–:' + DISPLAY_MAX);
  }

  async start(args = {}) {
    if (this.servers.size >= MAX_SERVERS) throw Error('受管 X display 最多 ' + MAX_SERVERS + ' 个');
    const width = integer(args.width, 1280, WIDTH[0], WIDTH[1], 'width');
    const height = integer(args.height, 800, HEIGHT[0], HEIGHT[1], 'height');
    const depth = integer(args.depth, 24, 16, 24, 'depth');
    if (!DEPTHS.includes(depth)) throw Error('depth 仅支持 16 或 24');
    let requested;
    if (args.display !== undefined) {
      const match = /^:(\d{2,3})$/.exec(String(args.display));
      if (!match) throw Error('display 必须是 :90–:129 形式');
      requested = Number(match[1]);
      if (requested < DISPLAY_MIN || requested > DISPLAY_MAX) throw Error('display 必须是 :90–:129 形式');
    }
    if (!this.xauth) throw Error('受管 X display 需要 Xauthority 工具（xauth）；请确认运行环境已安装');
    const display = this.freeDisplay(requested);
    const id = 'x-' + (++this.seq);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-terminal-x11-'));
    fs.chmodSync(dir, 0o700);
    const cookieFile = path.join(dir, 'Xauthority');
    const cookie = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(cookieFile, '', { mode: 0o600 });
    const add = spawnSync(this.xauth, ['-f', cookieFile, 'add', display, 'MIT-MAGIC-COOKIE-1', cookie], { encoding: 'utf8', timeout: 3000, maxBuffer: 8192 });
    if (add.error || add.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); throw Error('写入 Xauthority 失败: ' + (add.error?.message || add.stderr || 'xauth 退出码 ' + add.status)); }
    fs.chmodSync(cookieFile, 0o600);
    let child;
    try {
      // -nolisten tcp：仅 Unix socket，避免在运行时暴露可远程连接的 display。
      child = this.spawnImpl(this.bin, ['-auth', cookieFile, '-nolisten', 'tcp', '-screen', '0', `${width}x${height}x${depth}`, display], { stdio: 'ignore', env: this.env });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw Error('无法启动 Xvfb: ' + error.message);
    }
    const server = { id, display, width, height, depth, dir, cookieFile, process: child, status: 'starting', startedAt: new Date().toISOString(), stderr: '' };
    this.servers.set(id, server);
    const settle = (status, message) => { if (server.status === 'starting') { server.status = status; if (message) server.error = String(message).slice(0, 256); } };
    child.once('error', (error) => { settle('error', error?.message); this.cleanup(server); });
    child.once('exit', (code, signal) => { if (server.status === 'running' || server.status === 'starting') { server.status = 'exited'; server.exitCode = code; server.exitSignal = signal; } this.cleanup(server); });
    await new Promise(resolve => setTimeout(resolve, 300));
    if (server.status === 'starting') server.status = 'running';
    if (server.status === 'error') throw Error(server.error || 'Xvfb 启动失败');
    if (args.viewer !== false) await this.attachViewer(server);
    return this.public(server);
  }

  async attachViewer(server) {
    if (!usableBinary(this.x11vnc, ['-version'], this.env)) {
      server.viewer = { status: 'unavailable', reason: 'x11vnc 未安装' };
      return;
    }
    if (!usableBinary(this.websockify, ['--help'], this.env)) {
      server.viewer = { status: 'unavailable', reason: 'websockify 未安装' };
      return;
    }
    const env = { ...this.env, DISPLAY: server.display, XAUTHORITY: server.cookieFile };
    server.viewer = { status: 'starting', processes: [] };
    try {
      // openbox 只影响窗口外观；缺失时不阻断画面。
      if (usableBinary(this.openbox, ['--version'], env)) {
        const wm = this.spawnImpl(this.openbox, [], { stdio: 'ignore', env });
        server.viewer.processes.push(wm);
        wm.once('error', () => {});
      }
      const vncPort = await freePort();
      const wsPort = await freePort();
      const vnc = this.spawnImpl(this.x11vnc, ['-display', server.display, '-auth', server.cookieFile, '-localhost', '-nopw', '-rfbport', String(vncPort), '-forever', '-shared', '-quiet', '-noxdamage'], { stdio: 'ignore', env });
      server.viewer.processes.push(vnc);
      vnc.once('error', error => { if (server.viewer) server.viewer.error = String(error.message).slice(0, 160); });
      await waitPort(vncPort);
      const ws = this.spawnImpl(this.websockify, ['127.0.0.1:' + wsPort, '127.0.0.1:' + vncPort], { stdio: 'ignore', env });
      server.viewer.processes.push(ws);
      ws.once('error', error => { if (server.viewer) server.viewer.error = String(error.message).slice(0, 160); });
      await waitPort(wsPort);
      server.viewer.status = 'running';
      server.viewer.vncPort = vncPort;
      server.viewer.wsPort = wsPort;
    } catch (error) {
      server.viewer.status = 'error';
      server.viewer.reason = String(error.message).slice(0, 160);
      for (const child of server.viewer.processes) { try { child.kill('SIGTERM'); } catch (_) {} }
    }
  }

  cleanup(server) {
    if (server.viewer?.processes) {
      for (const child of server.viewer.processes) {
        try { child.kill('SIGTERM'); } catch (_) {}
      }
      server.viewer.processes = [];
    }
    try { fs.rmSync(server.dir, { recursive: true, force: true }); } catch (_) {}
    server.cookieFile = null;
  }

  async stop(serverId) {
    const ids = serverId ? [String(serverId)] : [...this.servers.keys()];
    const stopped = [];
    for (const id of ids) {
      const server = this.servers.get(id);
      if (!server) throw Error('X display 不存在: ' + id);
      if (server.process && !server.process.killed) {
        try { server.process.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { server.process.kill('SIGKILL'); } catch (_) {} }, 500).unref?.();
      }
      server.status = 'stopped';
      this.cleanup(server);
      this.servers.delete(id);
      stopped.push(server.display);
    }
    return { ok: true, stopped };
  }

  async stopAll() { for (const id of [...this.servers.keys()]) { try { await this.stop(id); } catch (_) {} } }
}

module.exports = { XServers, findXauth, MAX_SERVERS };
