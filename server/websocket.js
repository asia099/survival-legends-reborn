// Minimal RFC 6455 WebSocket server so the game runs with zero npm dependencies.
// Supports text/binary messages, fragmentation, ping/pong and close handshakes.
// API mirrors the subset of the `ws` package that the server uses.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFERED = 2 * 1024 * 1024; // drop clients that cannot keep up

export const OPEN = 1, CLOSING = 2, CLOSED = 3;

export class WebSocketServer extends EventEmitter {
  constructor({ server, path = '/', maxPayload = 64 * 1024 }) {
    super();
    this.clients = new Set();
    this.maxPayload = maxPayload;
    server.on('upgrade', (req, socket, head) => {
      let pathname = '/';
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* bad url */ }
      const key = req.headers['sec-websocket-key'];
      if (pathname !== path || String(req.headers.upgrade).toLowerCase() !== 'websocket'
          || !key || req.headers['sec-websocket-version'] !== '13') {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        return;
      }
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.setNoDelay(true);
      const ws = new WebSocketConnection(socket, this.maxPayload, head);
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      this.emit('connection', ws, req);
    });
  }

  close() {
    for (const c of this.clients) c.terminate();
    this.clients.clear();
  }
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, maxPayload, head) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = OPEN;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragments = null;
    this.fragOpcode = 0;
    this.fragLen = 0;
    socket.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.parse();
    });
    socket.on('close', () => this.finish(1006, ''));
    socket.on('end', () => this.finish(1006, ''));
    socket.on('error', (e) => this.emit('error', e));
    // Let the 'connection' handler attach listeners before any buffered frames are processed.
    if (this.buf.length) setImmediate(() => this.parse());
  }

  parse() {
    while (this.readyState !== CLOSED) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      if (buf[0] & 0x70) return this.fail(1002); // reserved bits (no extensions negotiated)
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this.fail(1009);
        len = buf.readUInt32BE(6); off = 10;
      }
      if (!masked) return this.fail(1002); // clients must mask frames
      if (len > this.maxPayload) return this.fail(1009);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i & 3];
      this.buf = buf.subarray(off + len);
      this.handleFrame(fin, op, payload);
    }
  }

  handleFrame(fin, op, payload) {
    switch (op) {
      case 0x8: { // close
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (this.readyState === OPEN) {
          this.readyState = CLOSING;
          this.write(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        }
        this.socket.end();
        this.finish(code, reason);
        return;
      }
      case 0x9: this.write(0xa, payload); return; // ping -> pong
      case 0xa: return;                           // pong
      case 0x1: case 0x2:
        if (this.fragments) return this.fail(1002);
        if (fin) { this.emit('message', payload, op === 0x2); return; }
        this.fragments = [payload]; this.fragOpcode = op; this.fragLen = payload.length;
        return;
      case 0x0:
        if (!this.fragments) return this.fail(1002);
        this.fragLen += payload.length;
        if (this.fragLen > this.maxPayload) return this.fail(1009);
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments);
          const binary = this.fragOpcode === 0x2;
          this.fragments = null;
          this.emit('message', msg, binary);
        }
        return;
      default:
        this.fail(1002);
    }
  }

  write(op, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    this.socket.write(Buffer.concat([header, payload]));
    if (this.socket.writableLength > MAX_BUFFERED) this.terminate();
  }

  send(data) {
    if (this.readyState !== OPEN) return;
    const binary = Buffer.isBuffer(data);
    this.write(binary ? 0x2 : 0x1, binary ? data : Buffer.from(String(data), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.write(0x8, p);
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), 1000);
    t.unref?.();
  }

  fail(code) {
    this.close(code, 'protocol error');
    this.finish(code, 'protocol error');
  }

  terminate() {
    this.socket.destroy();
    this.finish(1006, '');
  }

  finish(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close', code, reason);
  }
}
