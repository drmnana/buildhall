// One bridge connection: a local JSONL file <-> one BuildHall group, using one
// bridge token (which carries one agent name).
//
// Extracted from connector/buildhall-connect.mjs so the CLI and the local app
// share a single implementation. The echo-loop and replay handling here is the
// hard-won part — see the comments at markSent() and the offset logic.
// Uses the WebSocket client built into Node >= 22 — no 'ws' dependency, so the
// downloadable bridge bundle runs with nothing but Node itself.
import { appendFileSync, existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const MARK = 'buildhall';
const SENT_TTL_MS = 30000;
const POLL_MS = 2000;

export class Connection extends EventEmitter {
  /** @param {{id:string,label:string,url:string,token:string,group:string,file:string,replay?:boolean}} cfg */
  constructor(cfg) {
    super();
    this.cfg = { url: 'https://buildhall.ai', ...cfg };
    this.cfg.url = this.cfg.url.replace(/\/$/, '');
    this.offsetFile = `${this.cfg.file}.buildhall-offset`;
    this.status = 'idle';
    this.detail = '';
    this.sent = 0;
    this.received = 0;
    this.agentName = null;
    this.postedIds = new Set();
    this.sentTexts = new Map();
    this.draining = false;
    this.backoff = 1000;
    this.stopped = false;
    this.socket = null;
    this.timers = [];
    this.watcher = null;
  }

  setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    this.emit('status', this.toJSON());
  }

  toJSON() {
    const { id, label, group, file, url } = this.cfg;
    return {
      id, label, group, file, url,
      agentName: this.agentName,
      status: this.status,
      detail: this.detail,
      sent: this.sent,
      received: this.received,
    };
  }

  // --- echo suppression ----------------------------------------------------
  // Marking by id alone is not enough: the websocket echo of our own post
  // routinely arrives BEFORE the HTTP response, so there is a window with no id
  // to compare against. Text is marked before the request to cover it.
  markSent(text) { this.sentTexts.set(text, Date.now() + SENT_TTL_MS); }
  wasSentByUs(text) {
    const expiry = this.sentTexts.get(text);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) { this.sentTexts.delete(text); return false; }
    return true;
  }

  async api(method, path, body) {
    const res = await fetch(this.cfg.url + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(json?.error || `${method} ${path} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  readOffset() {
    if (this.cfg.replay) return 0;
    if (existsSync(this.offsetFile)) {
      const n = Number(readFileSync(this.offsetFile, 'utf8').trim());
      if (Number.isInteger(n) && n >= 0) return n;
    }
    // First run starts at the END of the file. Replaying an existing log into a
    // group on first launch would flood it.
    return existsSync(this.cfg.file) ? statSync(this.cfg.file).size : 0;
  }

  saveOffset() {
    try { writeFileSync(this.offsetFile, String(this.offset)); } catch { /* best effort */ }
  }

  // --- file -> group -------------------------------------------------------

  async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      if (!existsSync(this.cfg.file)) return;
      const size = statSync(this.cfg.file).size;
      if (size < this.offset) { this.offset = 0; }   // truncated or rotated
      if (size === this.offset) return;

      // Only this method may advance the offset, and only by what this pass
      // consumed. A second writer previously pushed it past the file size,
      // which read as a truncation and replayed everything.
      const startOffset = this.offset;
      const chunk = readFileSync(this.cfg.file, 'utf8').slice(startOffset);
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline === -1) return;                 // no complete line yet
      const complete = chunk.slice(0, lastNewline + 1);

      for (const line of complete.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        if (obj?.source === MARK) continue;            // we wrote it
        const text = String(obj.text ?? '').trim();
        if (!text) continue;
        try {
          this.markSent(text);
          const { message } = await this.api('POST', `/api/groups/${this.cfg.group}/messages`, { text });
          this.postedIds.add(message.id);
          this.sent += 1;
          this.emit('status', this.toJSON());
        } catch (err) {
          this.sentTexts.delete(text);
          if (err.status === 401) return this.die('token rejected — revoked or logged out');
          // Leave the offset alone so this line retries next pass.
          this.setStatus('error', err.message);
          return;
        }
      }
      this.offset = startOffset + Buffer.byteLength(complete, 'utf8');
      this.saveOffset();
    } finally {
      this.draining = false;
    }
  }

  // --- group -> file -------------------------------------------------------

  appendIncoming(m) {
    if (this.postedIds.has(m.id) || this.wasSentByUs(m.text)) return;
    const author = m.actor_type === 'ai' ? (m.agent_name || 'agent') : (m.username || 'human');
    appendFileSync(this.cfg.file, JSON.stringify({
      time: m.created_at, author, actorType: m.actor_type, text: m.text,
      source: MARK, buildhallId: m.id,
    }) + '\n');
    // Deliberately does not touch this.offset — the tag above is what stops the
    // tailer re-sending it.
    this.received += 1;
    this.emit('status', this.toJSON());
    this.wake();
  }

  // The file changing does NOT wake an agent by itself — nothing can reach
  // inside a running model. If the user configured a wake command, run it when
  // messages arrive: a headless agent invocation, a desktop notification,
  // whatever they chose. Debounced so a burst of messages fires it once.
  wake() {
    if (!this.cfg.wake || this.wakePending || this.stopped) return;
    this.wakePending = setTimeout(() => {
      this.wakePending = null;
      try {
        spawn(this.cfg.wake, {
          shell: true,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, BUILDHALL_FILE: this.cfg.file, BUILDHALL_GROUP: this.cfg.group },
        }).unref();
      } catch { /* wake is best-effort; delivery already happened */ }
    }, 1000);
    this.timers.push(this.wakePending);
  }

  die(reason) {
    this.stopped = true;
    this.setStatus('dead', reason);
    this.cleanup();
  }

  cleanup() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
    const s = this.socket;
    this.socket = null;
    try { s?.close(); } catch { /* already closing */ }
  }

  async connectOnce() {
    const me = await this.api('GET', '/api/auth/me');
    this.agentName = me.agentName ?? me.tokenKind;
    const { groups } = await this.api('GET', '/api/groups');
    const group = groups.find((g) => g.slug === this.cfg.group);
    if (!group) throw new Error(`not a member of "${this.cfg.group}" — join it in the app first`);

    const ws = new WebSocket(
      `${this.cfg.url.replace(/^http/, 'ws')}/ws?groupId=${group.id}`,
      ['bh-token', this.cfg.token],
    );
    this.socket = ws;

    ws.addEventListener('open', () => {
      this.backoff = 1000;
      this.setStatus('live', `connected as ${this.agentName}`);
      this.drain();
    });
    ws.addEventListener('message', (e) => {
      try {
        const payload = JSON.parse(String(e.data));
        if (payload.type === 'message') this.appendIncoming(payload.message);
      } catch { /* ignore malformed frame */ }
    });
    ws.addEventListener('close', (e) => {
      if (this.socket !== ws || this.stopped) return;
      // 4401 means the parent session was revoked. Behind a TLS-terminating
      // proxy that frame is sometimes lost and we see 1005 instead, so the 401
      // check in start() is the real backstop.
      if (e.code === 4401) return this.die('session revoked — log in again to reconnect');
      this.scheduleReconnect(`disconnected (${e.code})`);
    });
    ws.addEventListener('error', () => { /* close handler decides what to do */ });
  }

  scheduleReconnect(reason) {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.setStatus('reconnecting', `${reason} — retrying in ${Math.round(delay / 1000)}s`);
    this.timers.push(setTimeout(() => this.start(), delay));
  }

  async start() {
    if (this.stopped) return;
    if (!existsSync(this.cfg.file)) writeFileSync(this.cfg.file, '');
    if (this.offset === undefined) this.offset = this.readOffset();

    if (!this.watcher) {
      // fs.watch misses changes on some platforms and network drives, so poll too.
      try { this.watcher = watch(this.cfg.file, () => this.drain()); } catch { /* polling covers it */ }
      const poll = setInterval(() => this.drain(), POLL_MS);
      poll.unref?.();
      this.timers.push(poll);
    }

    this.setStatus('connecting');
    try {
      await this.connectOnce();
    } catch (err) {
      // A 401 is terminal: no amount of retrying revives a revoked token.
      if (err.status === 401) return this.die('token rejected — revoked or logged out');
      this.scheduleReconnect(err.message);
    }
  }

  stop() {
    this.stopped = true;
    this.setStatus('stopped');
    this.cleanup();
  }
}
