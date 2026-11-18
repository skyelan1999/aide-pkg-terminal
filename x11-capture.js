'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');

const ARTIFACT = /^[a-f0-9]{24}$/;
const VIDEO_LIMIT = 15 << 20;
const PNG_LIMIT = 2 << 20;
const CHUNK = 256 << 10;
const MAX_RECORDINGS = 2;
const extractFrames = promisify(execFile);
const FRAME_BYTES_LIMIT = 900 * 1024;
const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

class X11Capture {
  constructor() {
    this.jobs = new Map();
    this.errors = new Map();
    this.frameReaders = 0;
  }

  active(session) {
    return this.jobs.get(session)?.kind === 'webm';
  }

  artifact(dir, session, id, kind) {
    const file = path.join(dir, `${session}-${id}.${kind}`);
    const stat = fs.lstatSync(file, {throwIfNoEntry:false});
    if (!stat?.isFile() || stat.size < 1 || stat.size > (kind === 'webm' ? VIDEO_LIMIT : PNG_LIMIT)) return null;
    return {file, id, name:`terminal-${session.slice(0,8)}-${id}.${kind}`,
      mime:kind === 'webm' ? 'video/webm' : 'image/png', bytes:stat.size, createdAt:stat.mtime.toISOString()};
  }

  list(dir, session, kind) {
    const results = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(session + '-')) continue;
      const match = /^([a-f0-9]{24})\.(png|webm)$/.exec(name.slice(session.length + 1));
      if (!match || (kind && match[2] !== kind)) continue;
      const found = this.artifact(dir, session, match[1], match[2]);
      if (found) {
        const {file, ...metadata} = found;
        results.push(metadata);
      }
    }
    return {active:this.active(session), captures:results.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20),
      error:this.errors.get(session)};
  }

  async frames(dir, session, id, count, startMs, endMs) {
    if (id === undefined) id = this.list(dir, session, 'webm').captures[0]?.id;
    if (typeof id !== 'string' || !ARTIFACT.test(id)) throw Error('请提供有效的录像编号或先完成一段 X11 录像');
    const capture = this.artifact(dir, session, id, 'webm');
    if (!capture) throw Error('当前会话没有该录像');
    if (this.frameReaders >= 2) throw Error('同时最多分析两段 X11 录像');
    this.frameReaders++;
    try {
      const {stdout} = await extractFrames('python3',
        [path.join(__dirname,'x11-frames.py'),capture.file,String(count),String(startMs),String(endMs)],
        {timeout:15000, maxBuffer:5 << 20});
      const {durationMs, frames} = JSON.parse(stdout);
      if (!Number.isInteger(durationMs) || durationMs < 1 ||
          !Array.isArray(frames) || !frames.length || frames.length > count) throw Error();
      let last = -1;
      const metadata = [], images = [];
      for (const {timeMs, width, height, dataBase64} of frames) {
        if (!Number.isInteger(timeMs) || timeMs <= last || timeMs >= durationMs || timeMs < startMs ||
            (endMs !== -1 && timeMs > endMs) || typeof dataBase64 !== 'string') throw Error();
        const png = Buffer.from(dataBase64,'base64');
        if (png.length < 24 || png.length > FRAME_BYTES_LIMIT ||
            !png.subarray(0,16).equals(PNG_HEADER) ||
            png.readUInt32BE(16)!==width || png.readUInt32BE(20)!==height ||
            width < 1 || height < 1 || width*height > 4_000_000) throw Error();
        const sha256 = crypto.createHash('sha256').update(png).digest('hex');
        metadata.push({index:metadata.length + 1,timeMs,width,height,bytes:png.length,sha256});
        images.push({mediaType:'image/png',dataBase64:png.toString('base64'),sha256});
        last=timeMs;
      }
      return {protocol:'plugin-tool-images-v1',source:{sessionId:session,captureId:id,durationMs},
        frames:metadata,images};
    } catch (error) {
      if (error.stderr?.trim() === 'no-frames') throw Error('该时间范围内没有录像画面');
      throw Error('无法从该 X11 录像中读取关键帧');
    } finally {
      this.frameReaders--;
    }
  }

  read(dir, session, id, offset=0) {
    if (typeof id !== 'string' || !ARTIFACT.test(id)) throw Error('采集文件编号无效');
    const found = this.artifact(dir, session, id, 'png') || this.artifact(dir, session, id, 'webm');
    if (!found || !Number.isSafeInteger(offset) || offset < 0 || offset >= found.bytes) throw Error('采集文件或读取位置无效');
    const fd = fs.openSync(found.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== found.bytes) throw Error('采集文件已变化');
      const buffer = Buffer.alloc(Math.min(CHUNK, found.bytes - offset));
      const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (length !== buffer.length) throw Error('采集文件已变化');
      return {offset, nextOffset:offset + length, bytes:found.bytes, name:found.name, data:buffer.toString('base64')};
    } finally { fs.closeSync(fd); }
  }

  start(dir, session, display, authority, kind, seconds) {
    if (this.jobs.has(session)) throw Error('当前会话已有采集任务');
    if (this.jobs.size >= MAX_RECORDINGS) throw Error('同时最多运行两项画面采集');
    const id = crypto.randomBytes(12).toString('hex');
    const file = path.join(dir, `${session}-${id}.${kind}`);
    const temp = file + '.partial';
    fs.closeSync(fs.openSync(temp, 'wx', 0o600));
    this.errors.delete(session);

    let child;
    try {
      child = spawn('python3', [path.join(__dirname,'x11-capture.py'), kind, temp, String(seconds)], {
        env:{...process.env, DISPLAY:display, XAUTHORITY:authority}, stdio:['ignore','pipe','ignore'],
      });
    } catch (error) {
      fs.unlinkSync(temp);
      throw error;
    }
    const job = {kind, child, cancelled:false, stopping:false};
    this.jobs.set(session, job);
    let resolveReady;
    job.ready = new Promise(resolve=>{resolveReady=resolve;});
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 4096) {child.kill('SIGKILL');return;}
      output += chunk;
      if (kind === 'webm' && output.startsWith('ready\n')) resolveReady(true);
    });
    const timeout = setTimeout(()=>{
      job.cancelled = true;
      child.kill('SIGKILL');
    }, (kind === 'webm' ? seconds + 8 : 10) * 1000);
    timeout.unref();
    job.done = new Promise(resolve=>{
      child.on('error', ()=>{});
      child.once('close', code=>{
        clearTimeout(timeout);
        clearTimeout(job.stopTimer);
        try {
          if (code !== 0 || job.cancelled) throw Error('X11 采集失败，请检查图形会话和宿主运行环境');
          const result = JSON.parse(output.trimEnd().split('\n').at(-1));
          const length = fs.statSync(temp).size;
          if (!Number.isInteger(result.width) || !Number.isInteger(result.height) ||
              length < 1 || length > (kind === 'webm' ? VIDEO_LIMIT : PNG_LIMIT)) throw Error('X11 采集结果无效');
          // Publish only after the PNG or the WebM header and duration have been finalized.
          fs.renameSync(temp, file);
          const {file:verifiedPath, ...capture} = this.artifact(dir, session, id, kind);
          resolve({capture:{...capture, ...result}, file:verifiedPath});
        } catch (error) {
          const message = error.code ? '无法保存 X11 采集结果' : error.message;
          this.errors.set(session, message);
          resolve({error:message});
        } finally {
          this.jobs.delete(session);
          resolveReady(false);
          try { fs.rmSync(temp,{force:true}); } catch (_) { /* Retryable private cleanup. */ }
        }
      });
    });
    return job;
  }

  async stop(session, recordingOnly=false) {
    const job = this.jobs.get(session);
    if (!job || (recordingOnly && job.kind !== 'webm')) return {};
    if (!job.stopping) {
      job.stopping = true;
      job.cancelled = job.kind === 'png';
      job.child.kill('SIGTERM');
      job.stopTimer = setTimeout(()=>job.child.kill('SIGKILL'),3500);
      job.stopTimer.unref();
    }
    return job.done;
  }

  async stopAll() {
    await Promise.all([...this.jobs.keys()].map(id=>this.stop(id)));
  }

  clear(dir, session) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(session + '-') && /^[a-f0-9]{24}\.(?:png|webm)(?:\.partial)?$/.test(name.slice(session.length + 1))) {
        fs.unlinkSync(path.join(dir,name));
      }
    }
    this.errors.delete(session);
  }
}

module.exports = X11Capture;
