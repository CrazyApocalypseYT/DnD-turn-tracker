/**
 * The "server" part of the tracker: receives requests from connected
 * devices, applies them with the game rules (rooms.js) and pushes each
 * device the view it is allowed to see.
 *
 * Transport-agnostic: the Node server plugs Socket.IO sockets into it, and
 * a tablet/phone hosting a room in the browser plugs in WebRTC connections.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rooms'));
  else root.DndHub = factory(root.DndRooms);
})(typeof self !== 'undefined' ? self : this, function (game) {
  'use strict';

  const NO_ROOM_EVENTS = new Set(['room:create', 'room:join']);

  /**
   * @param {object} [opts]
   * @param {Map<string, object>} [opts.rooms]   rooms by code
   * @param {(room: object) => void} [opts.onChange]  called after every change (persistence)
   */
  function createHub(opts = {}) {
    const rooms = opts.rooms || new Map();
    const onChange = opts.onChange || (() => {});
    /** connections: { clientId, code, send(state), canCreate } */
    const conns = new Set();

    function onlineSet(code) {
      const set = new Set();
      for (const c of conns) if (c.code === code && c.clientId) set.add(c.clientId);
      return set;
    }

    function broadcast(code) {
      const room = rooms.get(code);
      if (!room) return;
      const online = onlineSet(code);
      const isOnline = (cid) => online.has(cid);
      for (const c of conns) {
        if (c.code !== code) continue;
        const view = game.viewFor(room, c.clientId, isOnline);
        if (view) {
          try { c.send(view); } catch { /* connection went away */ }
        }
      }
    }

    function attach(conn, room, clientId) {
      const prev = conn.code;
      conn.code = room.code;
      conn.clientId = clientId;
      if (prev && prev !== room.code) broadcast(prev);
    }

    const handlers = {
      'room:create'(conn, { clientId, name, screen }) {
        if (!conn.canCreate) throw new game.GameError('Rooms can only be created on the hosting device.');
        const cid = String(clientId || '').slice(0, 64);
        const room = game.createRoom(new Set(rooms.keys()), cid, name, { screen: Boolean(screen) });
        rooms.set(room.code, room);
        attach(conn, room, cid);
        return { code: room.code };
      },
      'room:join'(conn, { clientId, name, code, dmKey, screen }) {
        const cid = String(clientId || '').slice(0, 64);
        const room = rooms.get(game.normalizeCode(code));
        if (!room) throw new game.GameError('No room with that code. Check the code and try again.');
        game.joinRoom(room, cid, name, dmKey, { screen: Boolean(screen) });
        attach(conn, room, cid);
        return { code: room.code };
      },
      'room:leave'(conn, _p, room) {
        conn.code = null;
        return { code: room.code };
      },
      'combatant:save'(conn, { combatant }, room) {
        const saved = game.saveCombatant(room, conn.clientId, combatant);
        return { ids: saved.map((c) => c.id) };
      },
      'combatant:remove': (conn, { id }, room) => game.removeCombatant(room, conn.clientId, id),
      'hp:change'(conn, p, room) {
        game.changeHp(room, conn.clientId, p);
      },
      'combat:start': (conn, _p, room) => game.startCombat(room, conn.clientId),
      'combat:end': (conn, _p, room) => game.endCombat(room, conn.clientId),
      'turn:next': (conn, _p, room) => game.nextTurn(room, conn.clientId),
      'turn:prev': (conn, _p, room) => game.prevTurn(room, conn.clientId),
      'turn:set': (conn, { id }, room) => game.setTurn(room, conn.clientId, id),
      'settings:update': (conn, p, room) => game.updateSettings(room, conn.clientId, p),
      'stat:adjust'(conn, p, room) {
        game.adjustStat(room, conn.clientId, p);
      },
    };

    /**
     * Handle one request. Returns the reply ({ ok: true, ... } or
     * { ok: false, error }) synchronously; the resulting state is pushed to
     * every device right after, so the reply always arrives first.
     */
    function handle(conn, event, payload) {
      try {
        const handler = Object.prototype.hasOwnProperty.call(handlers, event) ? handlers[event] : null;
        if (!handler) throw new game.GameError('Unknown action.');
        let room = null;
        if (!NO_ROOM_EVENTS.has(event)) {
          room = rooms.get(conn.code);
          if (!room) throw new game.GameError('Room not found. Please re-join.');
        }
        const result = handler(conn, payload && typeof payload === 'object' ? payload : {}, room) || {};
        const code = result.code || (room && room.code);
        if (code) {
          Promise.resolve().then(() => {
            const changed = rooms.get(code);
            if (changed) onChange(changed);
            broadcast(code);
          });
        }
        return { ok: true, ...result };
      } catch (err) {
        if (!(err instanceof game.GameError)) console.error(`Error in ${event}:`, err);
        return { ok: false, error: err instanceof game.GameError ? err.message : 'Something went wrong.' };
      }
    }

    function connect(send, { canCreate = false } = {}) {
      const conn = { clientId: null, code: null, send, canCreate };
      conns.add(conn);
      return conn;
    }

    function disconnect(conn) {
      if (!conns.delete(conn)) return;
      if (conn.code) broadcast(conn.code);
    }

    function onlineCount(code) {
      return onlineSet(code).size;
    }

    return { rooms, handle, connect, disconnect, broadcast, onlineCount };
  }

  return { createHub };
});
