/*
 * Networking for the tracker. Three interchangeable transports with the
 * same interface:
 *
 *   request(event, payload) -> Promise<{ ok, error?, ... }>
 *   callbacks: onState(view), onStatus({ online, text }), onReconnected()
 *
 *  - SocketNet  : talks to the optional Node.js server (npm start).
 *  - P2PHost    : THIS device hosts the room in the browser (tablet / DM phone).
 *                 Other devices connect to it directly over WebRTC (PeerJS).
 *  - P2PGuest   : a player's device connected to a P2PHost.
 *
 * The PeerJS broker is only used to find the host (handshake); game data
 * then flows directly between devices (or via a TURN relay when a direct
 * path is impossible).
 */
(function () {
  'use strict';

  const PEER_PREFIX = 'dndtt-v1-';
  const HEARTBEAT_MS = 5000;
  const DEAD_MS = 20000;
  const REQUEST_TIMEOUT_MS = 10000;
  const CONNECT_TIMEOUT_MS = 15000;
  const NETWORK_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed'];

  const config = window.DND_CONFIG || {};
  const peerOptions = () => Object.assign({ debug: 0 }, config.peer || {});
  const peerId = (code) => PEER_PREFIX + code;
  const noop = () => {};

  function friendlyError(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable') {
      return "Couldn't find a room with that code. Check the code, and make sure the hosting device has the tracker open with its screen on.";
    }
    if (type === 'browser-incompatible' || type === 'webrtc') {
      return "This browser can't make direct connections (WebRTC). Try an up-to-date Chrome, Safari or Firefox.";
    }
    if (NETWORK_ERRORS.includes(type)) return "Can't reach the connection service. Check this device's internet connection.";
    if (type === 'timeout') return "The host didn't answer. Make sure both devices are online and the host's screen is on.";
    return (err && err.message) || 'Connection failed.';
  }

  function safeSend(dc, msg) {
    try {
      if (dc && dc.open) dc.send(msg);
    } catch { /* channel closed */ }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.append(s);
    });
  }

  /* ================================================================== */
  /* Node.js server                                                      */
  /* ================================================================== */
  class SocketNet {
    constructor(cb) {
      this.kind = 'server';
      this.cb = Object.assign({ onState: noop, onStatus: noop, onReconnected: noop }, cb);
      this.socket = null;
    }

    async start() {
      if (!window.io) await loadScript('/socket.io/socket.io.js');
      const socket = window.io({ transports: ['websocket', 'polling'] });
      this.socket = socket;
      socket.on('connect', () => {
        this.cb.onStatus({ online: true, text: '' });
        this.cb.onReconnected();
      });
      socket.on('disconnect', () => this.cb.onStatus({ online: false, text: 'Reconnecting to the server…' }));
      socket.on('state', (s) => this.cb.onState(s));
    }

    request(event, payload) {
      return new Promise((resolve) => {
        this.socket.timeout(REQUEST_TIMEOUT_MS).emit(event, payload, (err, res) => {
          if (err) resolve({ ok: false, error: 'The server did not respond. Check your connection.' });
          else resolve(res || { ok: false, error: 'No response.' });
        });
      });
    }

    close() { /* the socket is shared for the whole session */ }
  }

  /* ================================================================== */
  /* This device hosts the room                                          */
  /* ================================================================== */
  class P2PHost {
    /**
     * @param cb callbacks
     * @param opts { clientId, onSave(room) }
     */
    constructor(cb, opts) {
      if (!window.Peer) throw new Error('PeerJS failed to load.');
      this.kind = 'host';
      this.cb = Object.assign({ onState: noop, onStatus: noop, onReconnected: noop }, cb);
      this.clientId = opts.clientId;
      this.onSave = opts.onSave || noop;
      this.hub = window.DndHub.createHub({ onChange: (room) => this.onSave(room) });
      this.ready = false;
      this.pendingState = null;
      this.local = this.hub.connect((st) => {
        if (this.ready) this.cb.onState(st);
        else this.pendingState = st;
      }, { canCreate: true });
      this.remotes = new Set();
      this.peer = null;
      this.code = null;
      this.closed = false;
      this.retryTimer = null;
      this.heartbeat = setInterval(() => this.checkRemotes(), HEARTBEAT_MS);
    }

    setReady() {
      this.ready = true;
      if (this.pendingState) this.cb.onState(this.pendingState);
      this.pendingState = null;
    }

    /** Create a brand-new room hosted on this device. */
    async create(name, screen) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = this.hub.handle(this.local, 'room:create', { clientId: this.clientId, name, screen });
        if (!res.ok) return res;
        this.code = res.code;
        const result = await this.listen();
        if (result === 'taken') {
          // extremely unlikely: someone else uses this code right now
          this.hub.rooms.delete(res.code);
          this.pendingState = null;
          continue;
        }
        this.setReady();
        return res; // 'open', or 'offline' (works locally and keeps retrying)
      }
      return { ok: false, error: 'Could not get a free room code. Please try again.' };
    }

    /** Re-open a room saved on this device (e.g. after reloading the page). */
    async restore(room, name) {
      this.hub.rooms.set(room.code, room);
      this.code = room.code;
      const res = this.hub.handle(this.local, 'room:join', { clientId: this.clientId, name, code: room.code });
      if (!res.ok) return res;
      this.setReady();
      this.listen().then((r) => { if (r === 'taken') this.retryListen(3000); });
      return res;
    }

    /** Register this device with the broker under the room's id. */
    listen() {
      return new Promise((resolve) => {
        if (this.closed) return resolve('closed');
        let settled = false;
        const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        this.cb.onStatus({ online: false, text: 'Opening the room for other devices…' });

        const peer = new window.Peer(peerId(this.code), peerOptions());
        this.peer = peer;
        peer.on('open', () => {
          this.cb.onStatus({ online: true, text: '' });
          done('open');
        });
        peer.on('connection', (dc) => this.accept(dc));
        peer.on('disconnected', () => {
          // lost the broker: existing players stay connected, new ones can't join
          if (this.closed || peer.destroyed || this.peer !== peer) return;
          this.cb.onStatus({ online: false, text: 'Lost the internet connection – reconnecting… (connected players keep playing)' });
          this.retryListen(2000);
        });
        peer.on('error', (err) => {
          if (this.closed || this.peer !== peer) return;
          if (err.type === 'unavailable-id') {
            peer.destroy();
            this.cb.onStatus({ online: false, text: 'Re-opening the room… (waiting for the old connection to expire)' });
            done('taken');
          } else if (NETWORK_ERRORS.includes(err.type)) {
            this.cb.onStatus({ online: false, text: 'No internet connection – other devices cannot join yet. Retrying…' });
            done('offline');
            this.retryListen(4000);
          } else if (err.type === 'browser-incompatible' || err.type === 'webrtc') {
            this.cb.onStatus({ online: false, text: friendlyError(err) });
            done('offline');
          }
          // other error types (e.g. a single failed player connection) are not fatal for the host
        });
      });
    }

    retryListen(delay) {
      if (this.closed || this.retryTimer) return;
      this.retryTimer = setTimeout(async () => {
        this.retryTimer = null;
        if (this.closed) return;
        const peer = this.peer;
        if (peer && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); return; } catch { /* fall through and re-create */ }
        }
        if (peer && !peer.destroyed && peer.open) return;
        if (peer && !peer.destroyed) peer.destroy();
        const r = await this.listen();
        if (r === 'taken') this.retryListen(3000);
      }, delay);
    }

    accept(dc) {
      const remote = { dc, conn: null, lastSeen: Date.now() };
      dc.on('open', () => {
        remote.conn = this.hub.connect((st) => safeSend(dc, { t: 'state', state: st }));
        this.remotes.add(remote);
      });
      dc.on('data', (msg) => {
        remote.lastSeen = Date.now();
        if (!remote.conn || !msg || typeof msg !== 'object') return;
        if (msg.t === 'req') {
          const res = this.hub.handle(remote.conn, String(msg.event), msg.payload);
          safeSend(dc, { t: 'res', id: msg.id, res });
        } else if (msg.t === 'ping') {
          safeSend(dc, { t: 'pong' });
        }
      });
      const drop = () => {
        this.remotes.delete(remote);
        if (remote.conn) this.hub.disconnect(remote.conn);
        remote.conn = null;
      };
      dc.on('close', drop);
      dc.on('error', drop);
    }

    /** Drop devices that stopped answering (phone locked, left Wi-Fi…). */
    checkRemotes() {
      const now = Date.now();
      for (const r of [...this.remotes]) {
        if (now - r.lastSeen > DEAD_MS) {
          try { r.dc.close(); } catch { /* ignore */ }
          this.remotes.delete(r);
          if (r.conn) this.hub.disconnect(r.conn);
        }
      }
    }

    request(event, payload) {
      return Promise.resolve(this.hub.handle(this.local, event, payload));
    }

    close() {
      this.closed = true;
      clearInterval(this.heartbeat);
      clearTimeout(this.retryTimer);
      for (const r of this.remotes) { try { r.dc.close(); } catch { /* ignore */ } }
      this.remotes.clear();
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
    }
  }

  /* ================================================================== */
  /* This device joins a room hosted on another device                   */
  /* ================================================================== */
  class P2PGuest {
    constructor(cb) {
      if (!window.Peer) throw new Error('PeerJS failed to load.');
      this.kind = 'guest';
      this.cb = Object.assign({ onState: noop, onStatus: noop, onReconnected: noop }, cb);
      this.peer = null;
      this.dc = null;
      this.code = null;
      this.pending = new Map();
      this.seq = 0;
      this.lastSeen = 0;
      this.closed = false;
      this.reconnectTimer = null;
      this.connecting = null;
      this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
      this.onVisible = () => {
        if (document.visibilityState !== 'visible' || this.closed) return;
        // phones often kill connections while the screen is off
        if (!this.dc || Date.now() - this.lastSeen > 2 * HEARTBEAT_MS) this.lost(0);
      };
      document.addEventListener('visibilitychange', this.onVisible);
    }

    ensurePeer() {
      return new Promise((resolve, reject) => {
        const p = this.peer;
        if (p && !p.destroyed && p.open) return resolve(p);
        if (p && !p.destroyed) p.destroy();
        const peer = new window.Peer(peerOptions());
        this.peer = peer;
        const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { type: 'network' })), CONNECT_TIMEOUT_MS);
        peer.on('open', () => { clearTimeout(timer); resolve(peer); });
        peer.on('error', (err) => {
          clearTimeout(timer);
          if (this.connectFail) this.connectFail(err);
          reject(err);
        });
      });
    }

    /** Open a data channel to the host. Rejects with a readable Error. */
    async connect(code) {
      this.code = code;
      try {
        const peer = await this.ensurePeer();
        await new Promise((resolve, reject) => {
          const dc = peer.connect(peerId(code), { reliable: true, serialization: 'json' });
          const timer = setTimeout(() => fail({ type: 'timeout' }), CONNECT_TIMEOUT_MS);
          const fail = (err) => {
            clearTimeout(timer);
            this.connectFail = null;
            try { dc.close(); } catch { /* ignore */ }
            reject(err);
          };
          this.connectFail = fail; // peer-unavailable is reported on the peer
          dc.on('open', () => {
            clearTimeout(timer);
            this.connectFail = null;
            this.attach(dc);
            resolve();
          });
          dc.on('error', fail);
        });
      } catch (err) {
        throw new Error(friendlyError(err));
      }
    }

    attach(dc) {
      this.dc = dc;
      this.lastSeen = Date.now();
      this.cb.onStatus({ online: true, text: '' });
      dc.on('data', (msg) => {
        if (this.dc !== dc) return;
        this.lastSeen = Date.now();
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'state') this.cb.onState(msg.state);
        else if (msg.t === 'res') {
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.res || { ok: false, error: 'No response.' }); }
        }
      });
      const onClose = () => { if (this.dc === dc) this.lost(1500); };
      dc.on('close', onClose);
      dc.on('error', onClose);
    }

    tick() {
      if (this.closed || !this.dc) return;
      if (Date.now() - this.lastSeen > DEAD_MS) return this.lost(0);
      safeSend(this.dc, { t: 'ping' });
    }

    lost(delay) {
      if (this.closed) return;
      const dc = this.dc;
      this.dc = null;
      if (dc) { try { dc.close(); } catch { /* ignore */ } }
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'Lost the connection to the host. Reconnecting…' });
        this.pending.delete(id);
      }
      this.cb.onStatus({ online: false, text: 'Reconnecting to the host… (is the host device on, with the tracker open?)' });
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null;
        if (this.closed || this.dc) return;
        try {
          await this.connect(this.code);
          this.cb.onReconnected();
        } catch {
          this.lost(3000);
        }
      }, delay);
    }

    request(event, payload) {
      return new Promise((resolve) => {
        if (!this.dc || !this.dc.open) {
          resolve({ ok: false, error: 'Not connected to the host right now. Reconnecting…' });
          return;
        }
        const id = ++this.seq;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({ ok: false, error: "The host didn't respond. Check the connection." });
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, timer });
        safeSend(this.dc, { t: 'req', id, event, payload });
      });
    }

    close() {
      this.closed = true;
      clearInterval(this.heartbeat);
      clearTimeout(this.reconnectTimer);
      document.removeEventListener('visibilitychange', this.onVisible);
      if (this.dc) { try { this.dc.close(); } catch { /* ignore */ } }
      if (this.peer && !this.peer.destroyed) this.peer.destroy();
    }
  }

  window.DndNet = { SocketNet, P2PHost, P2PGuest, mode: config.mode === 'server' ? 'server' : 'p2p' };
})();
