'use strict';

// Shared by the daemon export and the local browser file picker.
const AideTerminalRelayProfile = (() => {
  const format = 'aide-terminal-relay';
  const version = 1;
  const maxBytes = 16 * 1024;

  function field(value, limit, fallback) {
    const result = value === undefined ? fallback : value;
    if (typeof result !== 'string' || result.length > limit || /[\x00-\x1f\x7f]/.test(result)) {
      throw Error('中继配置的文本字段无效');
    }
    return result;
  }

  function int(value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) throw Error('中继配置的数字字段无效');
    return value;
  }

  function flag(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw Error('中继配置的开关字段无效');
    return value;
  }

  function host(value) {
    const name = field(value, 253);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(name)) throw Error('中继配置的主机名无效');
    return name;
  }

  function validate(input) {
    if (input?.format !== format || input.version !== version) throw Error('不支持的中继配置格式或版本');
    const {kind, target, relay} = input;
    if (!['ssh', 'telnet', 'tcp', 'udp', 'serial'].includes(kind) ||
        !target || !relay || target.kind !== kind) throw Error('中继配置的连接类型无效');
    const key = field(relay.key, 44);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || btoa(atob(key)) !== key) throw Error('中继配置的 Base64 密钥无效');
    const result = {
      format, version, kind, name: field(input.name, 80),
      logging: flag(input.logging, true), visibleToAide: flag(input.visibleToAide, true),
      relay: {host: host(relay.host), port: int(relay.port, 1, 65535), key},
      target: {kind},
    };
    if (kind === 'serial') {
      const devicePath = field(target.devicePath, 512);
      if (!devicePath || ![1, 1.5, 2].includes(target.stopBits) ||
          !['none', 'even', 'odd', 'mark', 'space'].includes(target.parity)) throw Error('中继配置的串口参数无效');
      Object.assign(result.target, {
        devicePath, baudRate: int(target.baudRate, 1, 4000000),
        dataBits: int(target.dataBits, 5, 8), stopBits: target.stopBits,
        parity: target.parity, flowControl: flag(target.flowControl, false),
      });
    } else {
      Object.assign(result.target, {host: host(target.host), port: int(target.port, 1, 65535)});
    }
    if (kind === 'ssh') {
      const username = field(target.username, 64);
      const auth = target.auth ?? 'default';
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(username) ||
          !['default', 'password', 'key'].includes(auth)) throw Error('中继配置的 SSH 参数无效');
      result.cwd = field(input.cwd, 512, '.');
      Object.assign(result.target, {
        username, auth, x11Enabled: flag(target.x11Enabled, false),
        x11Display: field(target.x11Display, 512, ''),
        x11AuthorityFile: field(target.x11AuthorityFile, 512, ''),
      });
      if (auth === 'key') {
        result.target.identitySource = field(target.identitySource, 512, '');
        result.target.identityFile = field(target.identityFile, 512);
        if (!result.target.identityFile) throw Error('中继配置缺少 SSH 私钥文件引用');
      }
    }
    if (kind === 'telnet') {
      const terminalType = field(target.terminalType, 64, 'xterm-256color');
      if (!/^[A-Za-z0-9_.+-]+$/.test(terminalType)) throw Error('中继配置的 Telnet 终端类型无效');
      Object.assign(result.target, {
        terminalType, telnetLocalEcho: flag(target.telnetLocalEcho, false),
      });
    }
    return result;
  }

  function fromRecord(record, config) {
    const {kind, name, cwd, logging, visibleToAide} = record;
    return validate({format, version, kind, name, cwd, logging, visibleToAide,
      relay: {host: config.host, port: config.port, key: config.key}, target: config.target});
  }

  function decode(text) {
    if (typeof text !== 'string' || !text.length || text.length > maxBytes) throw Error('中继配置文件为空或超过 16 KiB');
    let parsed;
    try {
      const encoded = text.trim();
      const binary = atob(encoded);
      if (btoa(binary) !== encoded) throw Error('Invalid encoding');
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    } catch (_) {
      throw Error('请选择有效的中继配置备份（.base64）');
    }
    return validate(parsed);
  }

  return {fromRecord, decode, maxBytes};
})();
if (typeof module !== 'undefined') module.exports = AideTerminalRelayProfile;
