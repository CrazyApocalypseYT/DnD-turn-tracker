'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./src/rooms');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_DAYS || 14) * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Room storage (in memory, saved to a JSON file so restarts are safe) */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const rooms = new Map();

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const room of raw) if (room && room.code) rooms.set(room.code, room);
    console.log(`Loaded ${rooms.size} room(s) from ${DATA_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not load saved rooms:', err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (process.env.NO_PERSIST) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...rooms.values()]));
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      console.warn('Could not save rooms:', err.message);
    }
  }, 1000);
}

function cleanupRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff && onlineInRoom(code) === 0) rooms.delete(code);
  }
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/* Presence: how many sockets each client has open in each room        */
/* ------------------------------------------------------------------ */

const presence = new Map(); // `${code}|${clientId}` -> count

function presenceKey(code, clientId) {
  return `${code}|${clientId}`;
}
function addPresence(code, clientId) {
  const k = presenceKey(code, clientId);
  presence.set(k, (presence.get(k) || 0) + 1);
}
function removePresence(code, clientId) {
  const k = presenceKey(code, clientId);
  const n = (presence.get(k) || 0) - 1;
  if (n <= 0) presence.delete(k);
  else presence.set(k, n);
}
function onlineInRoom(code) {
  let n = 0;
  for (const k of presence.keys()) if (k.startsWith(`${code}|`)) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* HTTP + Socket.IO                                                    */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 20000,
  pingTimeout: 20000,
});

async function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  const isOnline = (cid) => presence.has(presenceKey(code, cid));
  const sockets = await io.in(code).fetchSockets();
  for (const s of sockets) {
    const view = game.viewFor(room, s.data.clientId, isOnline);
    if (view) s.emit('state', view);
  }
}

function attach(socket, room, clientId) {
  // leave a previous room, if any
  if (socket.data.code && socket.data.code !== room.code) {
    const prev = socket.data.code;
    socket.leave(prev);
    removePresence(prev, socket.data.clientId);
    broadcast(prev);
  }
  if (socket.data.code !== room.code) addPresence(room.code, clientId);
  socket.data.code = room.code;
  socket.data.clientId = clientId;
  socket.join(room.code);
}

io.on('connection', (socket) => {
  /**
   * Wrap a handler so errors are reported back via the ack callback,
   * and state is re-broadcast after every successful change.
   */
  const on = (event, handler, { needsRoom = true } = {}) => {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        let room = null;
        if (needsRoom) {
          room = rooms.get(socket.data.code);
          if (!room) throw new game.GameError('Room not found. Please re-join.');
        }
        const result = await handler(payload || {}, room);
        reply({ ok: true, ...(result || {}) });
        const code = (result && result.code) || (room && room.code);
        if (code) {
          scheduleSave();
          await broadcast(code);
        }
      } catch (err) {
        if (!(err instanceof game.GameError)) console.error(`Error in ${event}:`, err);
        reply({ ok: false, error: err instanceof game.GameError ? err.message : 'Something went wrong.' });
      }
    });
  };

  on(
    'room:create',
    ({ clientId, name }) => {
      const cid = String(clientId || '').slice(0, 64);
      const room = game.createRoom(new Set(rooms.keys()), cid, name);
      rooms.set(room.code, room);
      attach(socket, room, cid);
      return { code: room.code };
    },
    { needsRoom: false },
  );

  on(
    'room:join',
    ({ clientId, name, code, dmKey }) => {
      const cid = String(clientId || '').slice(0, 64);
      const room = rooms.get(game.normalizeCode(code));
      if (!room) throw new game.GameError('No room with that code. Check the code and try again.');
      game.joinRoom(room, cid, name, dmKey);
      attach(socket, room, cid);
      return { code: room.code };
    },
    { needsRoom: false },
  );

  on('room:leave', (_p, room) => {
    socket.leave(room.code);
    removePresence(room.code, socket.data.clientId);
    socket.data.code = null;
    return { code: room.code };
  });

  const cid = () => socket.data.clientId;
  on('combatant:save', ({ combatant }, room) => {
    const saved = game.saveCombatant(room, cid(), combatant);
    return { ids: saved.map((c) => c.id) };
  });
  on('combatant:remove', ({ id }, room) => game.removeCombatant(room, cid(), id));
  on('hp:change', (p, room) => {
    game.changeHp(room, cid(), p);
  });
  on('combat:start', (_p, room) => game.startCombat(room, cid()));
  on('combat:end', (_p, room) => game.endCombat(room, cid()));
  on('turn:next', (_p, room) => game.nextTurn(room, cid()));
  on('turn:prev', (_p, room) => game.prevTurn(room, cid()));
  on('turn:set', ({ id }, room) => game.setTurn(room, cid(), id));
  on('settings:update', (p, room) => game.updateSettings(room, cid(), p));

  socket.on('disconnect', () => {
    const { code, clientId } = socket.data;
    if (code) {
      removePresence(code, clientId);
      broadcast(code);
    }
  });
});

if (require.main === module) {
  loadRooms();
  setInterval(cleanupRooms, 60 * 60 * 1000).unref();
  server.listen(PORT, () => console.log(`D&D turn tracker running on http://localhost:${PORT}`));
  const shutdown = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify([...rooms.values()]));
      } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app, server, io, rooms };
