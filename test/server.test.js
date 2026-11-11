'use strict';

process.env.NO_PERSIST = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { server, io } = require('../server');

let url;

test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  io.close();
  await new Promise((r) => server.close(r));
});

function client() {
  const s = ioc(url, { transports: ['websocket'], forceNew: true });
  s.latest = null;
  s.on('state', (st) => { s.latest = st; });
  s.call = (ev, payload) => new Promise((res) => s.emit(ev, payload, res));
  s.waitFor = (pred, ms = 2000) =>
    new Promise((resolve, reject) => {
      if (s.latest && pred(s.latest)) return resolve(s.latest);
      const t = setTimeout(() => { s.off('state', h); reject(new Error('timeout waiting for state')); }, ms);
      const h = (st) => { if (pred(st)) { clearTimeout(t); s.off('state', h); resolve(st); } };
      s.on('state', h);
    });
  return s;
}

test('three devices share one room and only the acting device gets yourTurn', async () => {
  const dm = client();
  const alice = client();
  const bob = client();
  try {
    const created = await dm.call('room:create', { clientId: 'dm-1', name: 'Gina' });
    assert.ok(created.ok, created.error);
    const code = created.code;

    assert.equal((await alice.call('room:join', { clientId: 'a-1', name: 'Alice', code: code.toLowerCase() })).ok, true);
    assert.equal((await bob.call('room:join', { clientId: 'b-1', name: 'Bob', code })).ok, true);
    const bad = await bob.call('room:join', { clientId: 'b-1', name: 'Bob', code: 'ZZZZZ' });
    assert.equal(bad.ok, false);

    await alice.call('combatant:save', { combatant: { type: 'pc', name: 'Aria', cls: 'Rogue', level: 4, hpMax: 27, ac: 15, initiative: 19 } });
    await alice.call('combatant:save', { combatant: { type: 'companion', name: 'Pip', hpMax: 6, ac: 12, initiative: 2 } });
    await bob.call('combatant:save', { combatant: { type: 'pc', name: 'Bram', cls: 'Fighter', level: 4, hpMax: 40, ac: 18, initiative: 9 } });
    const gobs = await dm.call('combatant:save', { combatant: { type: 'enemy', name: 'Goblin', hpMax: 7, ac: 15, initiative: 12, count: 2 } });
    assert.equal(gobs.ids.length, 2);

    const denied = await bob.call('combatant:save', { combatant: { type: 'enemy', name: 'x', hpMax: 1 } });
    assert.equal(denied.ok, false);

    assert.ok((await dm.call('combat:start')).ok);
    await alice.waitFor((s) => s.yourTurn === true);
    await bob.waitFor((s) => s.combat.active && s.yourTurn === false);
    assert.equal(dm.latest.yourTurn, false);

    // Bob cannot end Alice's turn
    assert.equal((await bob.call('turn:next')).ok, false);

    // Alice hits Goblin 1 for 4 and ends her turn -> goblins (DM's device)
    const g1 = gobs.ids[0];
    assert.ok((await alice.call('hp:change', { targetId: g1, amount: 4, mode: 'damage' })).ok);
    await alice.call('turn:next');
    const dmState = await dm.waitFor((s) => s.yourTurn === true);
    assert.equal(dmState.combatants.find((c) => c.id === g1).hp, 3);
    const aliceView = await alice.waitFor((s) => s.yourTurn === false);
    assert.equal(aliceView.combatants.find((c) => c.id === g1).hp, null, 'players do not see enemy HP by default');
    assert.equal(aliceView.combatants.find((c) => c.id === g1).status, 'Bloodied');

    // online presence
    assert.equal(dmState.members.filter((m) => m.online).length, 3);
    bob.disconnect();
    await dm.waitFor((s) => s.members.find((m) => m.name === 'Bob').online === false);
  } finally {
    dm.disconnect();
    alice.disconnect();
    bob.disconnect();
  }
});
