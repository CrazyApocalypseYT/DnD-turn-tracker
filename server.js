'use strict';

/**
 * Optional Node.js server. The app also works without it: a tablet or phone
 * can host a room directly in the browser (see public/net.js). Running this
 * server instead keeps rooms on a computer/cloud host and avoids WebRTC.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createHub } = require('./public/shared/hub');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'rooms.json');
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_DAYS || 14) * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Room storage (in memory, saved to a JSON file so restarts are safe) */
/* ------------------------------------------------------------------ */

const rooms = new Map();
const hub = createHub({ rooms, onChange: () => scheduleSave() });

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const room of raw) if (room && room.code) rooms.set(room.code, room);
    console.log(`Loaded ${rooms.size} room(s) from ${DATA_FILE}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not load saved rooms:', err.message);
  }
}

function writeRooms() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...rooms.values()]));
  fs.renameSync(tmp, DATA_FILE);
}

let saveTimer = null;
function scheduleSave() {
  if (process.env.NO_PERSIST || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeRooms(); } catch (err) { console.warn('Could not save rooms:', err.message); }
  }, 1000);
}

function cleanupRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.updatedAt < cutoff && hub.onlineCount(code) === 0) rooms.delete(code);
  }
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/* HTTP + Socket.IO                                                    */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
// Tell the browser app to use this server instead of hosting rooms itself.
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store');
  res.send("window.DND_CONFIG = Object.assign(window.DND_CONFIG || {}, { mode: 'server' });\n");
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 20000,
  pingTimeout: 20000,
});

const EVENTS = [
  'room:create', 'room:join', 'room:leave',
  'combatant:save', 'combatant:remove', 'hp:change',
  'combat:start', 'combat:end', 'turn:next', 'turn:prev', 'turn:set', 'settings:update',
];

io.on('connection', (socket) => {
  const conn = hub.connect((state) => socket.emit('state', state), { canCreate: true });
  for (const event of EVENTS) {
    socket.on(event, (payload, ack) => {
      const reply = hub.handle(conn, event, payload);
      if (typeof ack === 'function') ack(reply);
    });
  }
  socket.on('disconnect', () => hub.disconnect(conn));
});

if (require.main === module) {
  loadRooms();
  setInterval(cleanupRooms, 60 * 60 * 1000).unref();
  server.listen(PORT, () => console.log(`D&D turn tracker running on http://localhost:${PORT}`));
  const shutdown = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      try { writeRooms(); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { app, server, io, rooms, hub };
