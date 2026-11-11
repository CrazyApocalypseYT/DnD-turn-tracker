'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../public/shared/rooms');

function setup() {
  const room = g.createRoom(new Set(), 'dm-secret', 'Dungeon Master');
  g.joinRoom(room, 'p1', 'Alice');
  g.joinRoom(room, 'p2', 'Bob');
  return room;
}

const pc = (name, initiative, extra = {}) => ({ type: 'pc', name, cls: 'Wizard', level: 3, hpMax: 20, ac: 12, initiative, ...extra });

test('room codes are 5 chars and the creator is the DM', () => {
  const room = setup();
  assert.match(room.code, /^[A-Z2-9]{5}$/);
  assert.equal(room.members['dm-secret'].role, 'dm');
  assert.equal(room.members.p1.role, 'player');
});

test('players get exactly one character and one friendly NPC', () => {
  const room = setup();
  g.saveCombatant(room, 'p1', pc('Aria', 15, { stats: [{ key: 'Spell DC', value: '14' }] }));
  assert.throws(() => g.saveCombatant(room, 'p1', pc('Aria 2', 10)), /already have a character/);
  g.saveCombatant(room, 'p1', { type: 'companion', name: 'Wolf', hpMax: 11, ac: 13, initiative: 12 });
  assert.throws(() => g.saveCombatant(room, 'p1', { type: 'companion', name: 'Hawk', hpMax: 5 }), /one friendly NPC/);
  assert.throws(() => g.saveCombatant(room, 'p1', { type: 'enemy', name: 'Goblin', hpMax: 7 }), /Only the Dungeon Master/);
  const aria = room.combatants.find((c) => c.name === 'Aria');
  assert.deepEqual(aria.stats, [{ key: 'Spell DC', value: '14' }]);
  assert.equal(aria.hp, 20);
});

test('DM can add many enemies at once, numbered', () => {
  const room = setup();
  const made = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, ac: 15, initiative: 14, count: 4 });
  assert.equal(made.length, 4);
  assert.deepEqual(made.map((c) => c.name), ['Goblin 1', 'Goblin 2', 'Goblin 3', 'Goblin 4']);
  g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Ogre', hpMax: 59, initiative: 8 });
  assert.equal(room.combatants.filter((c) => c.type === 'enemy').length, 5);
});

test('players cannot edit others, DM can edit anything', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15));
  assert.throws(() => g.saveCombatant(room, 'p2', { id: aria.id, name: 'Hacked' }), /cannot edit/);
  g.saveCombatant(room, 'dm-secret', { id: aria.id, name: 'Aria the Bold', hpMax: 20, hp: 5 });
  assert.equal(aria.name, 'Aria the Bold');
  assert.equal(aria.hp, 5);
});

test('players deal damage to enemies; HP never goes below 0', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15));
  const [gob] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, initiative: 10 });
  g.changeHp(room, 'p1', { targetId: gob.id, amount: 5, mode: 'damage', attackerId: aria.id });
  assert.equal(gob.hp, 2);
  g.changeHp(room, 'p1', { targetId: gob.id, amount: 50, mode: 'damage' });
  assert.equal(gob.hp, 0);
  assert.ok(room.log.some((l) => l.text.includes('Goblin is defeated')));
  assert.ok(room.log.some((l) => l.text === 'Aria dealt 5 damage to Goblin.'), 'enemy HP hidden from players in log');
  assert.ok(room.log.some((l) => l.dm === 'Aria dealt 5 damage to Goblin (7 → 2 HP).'), 'DM sees numbers');
});

test('players cannot damage other players or heal enemies', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15));
  const [bo] = g.saveCombatant(room, 'p2', pc('Bo', 12));
  const [gob] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, hp: 3 });
  assert.throws(() => g.changeHp(room, 'p2', { targetId: aria.id, amount: 3, mode: 'damage' }), /only damage enemies/);
  assert.throws(() => g.changeHp(room, 'p2', { targetId: gob.id, amount: 3, mode: 'heal' }), /cannot heal enemies/);
  g.changeHp(room, 'p1', { targetId: aria.id, amount: 8, mode: 'damage' }); // own creature
  g.changeHp(room, 'p2', { targetId: aria.id, amount: 100, mode: 'heal' }); // cleric heals ally
  assert.equal(aria.hp, 20);
  g.changeHp(room, 'dm-secret', { targetId: bo.id, amount: 4, mode: 'damage' });
  assert.equal(bo.hp, 16);
});

test('turn order: initiative desc, skips defeated enemies and hidden creatures, counts rounds', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15));
  const [wolf] = g.saveCombatant(room, 'p1', { type: 'companion', name: 'Wolf', hpMax: 11, initiative: 3 });
  const [bo] = g.saveCombatant(room, 'p2', pc('Bo', 12));
  const [gob] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, initiative: 18 });
  g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Ambusher', hpMax: 7, initiative: 20, hidden: true });

  assert.throws(() => g.startCombat(room, 'p1'), /Only the Dungeon Master/);
  g.startCombat(room, 'dm-secret');
  assert.equal(room.combat.turnId, gob.id);
  assert.equal(room.combat.round, 1);

  // only the DM can end the goblin's turn
  assert.throws(() => g.nextTurn(room, 'p1'), /not your turn/);
  g.nextTurn(room, 'dm-secret');
  assert.equal(room.combat.turnId, aria.id);
  g.nextTurn(room, 'p1'); // Alice ends her own turn
  assert.equal(room.combat.turnId, bo.id);
  g.nextTurn(room, 'p2');
  assert.equal(room.combat.turnId, wolf.id);

  g.changeHp(room, 'p1', { targetId: gob.id, amount: 10, mode: 'damage' });
  g.nextTurn(room, 'p1'); // Wolf belongs to Alice
  assert.equal(room.combat.round, 2);
  assert.equal(room.combat.turnId, aria.id, 'dead goblin and hidden ambusher are skipped');

  g.prevTurn(room, 'dm-secret');
  assert.equal(room.combat.turnId, wolf.id);
  assert.equal(room.combat.round, 1);
});

test('removing the current creature passes the turn on', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15));
  const [bo] = g.saveCombatant(room, 'p2', pc('Bo', 12));
  g.startCombat(room, 'dm-secret');
  assert.equal(room.combat.turnId, aria.id);
  g.removeCombatant(room, 'p1', aria.id);
  assert.equal(room.combat.turnId, bo.id);
});

test('views hide secrets: client ids, DM key, hidden enemies, enemy stats', () => {
  const room = setup();
  g.saveCombatant(room, 'p1', pc('Aria', 15));
  g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, ac: 15, initiative: 10, stats: [{ key: 'CR', value: '1/4' }] });
  g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Lurker', hpMax: 30, initiative: 9, hidden: true });

  const pv = g.viewFor(room, 'p1');
  const json = JSON.stringify(pv);
  assert.ok(!json.includes('dm-secret'));
  assert.ok(!json.includes(room.dmKey));
  assert.ok(!json.includes('Lurker'));
  const gob = pv.combatants.find((c) => c.name === 'Goblin');
  assert.equal(gob.hp, null);
  assert.equal(gob.ac, null);
  assert.deepEqual(gob.stats, []);
  assert.equal(gob.status, 'Unharmed');

  const dv = g.viewFor(room, 'dm-secret');
  assert.equal(dv.dmKey, room.dmKey);
  assert.equal(dv.combatants.length, 3);
  assert.equal(dv.combatants.find((c) => c.name === 'Goblin').hp, 7);

  g.updateSettings(room, 'dm-secret', { revealEnemies: true });
  assert.equal(g.viewFor(room, 'p1').combatants.find((c) => c.name === 'Goblin').ac, 15);
});

test('yourTurn is true only for the device that controls the acting creature', () => {
  const room = setup();
  g.saveCombatant(room, 'p1', pc('Aria', 15));
  g.saveCombatant(room, 'p1', { type: 'companion', name: 'Wolf', hpMax: 11, initiative: 14 });
  g.saveCombatant(room, 'p2', pc('Bo', 12));
  g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, initiative: 11 });
  g.startCombat(room, 'dm-secret');
  const who = () => ['dm-secret', 'p1', 'p2'].filter((id) => g.viewFor(room, id).yourTurn);
  assert.deepEqual(who(), ['p1']); // Aria
  g.nextTurn(room, 'p1');
  assert.deepEqual(who(), ['p1']); // Wolf (Alice's NPC)
  g.nextTurn(room, 'p1');
  assert.deepEqual(who(), ['p2']); // Bo (12)
  g.nextTurn(room, 'p2');
  assert.deepEqual(who(), ['dm-secret']); // Goblin (11)
});

test('DM key moves the DM role to a new device', () => {
  const room = setup();
  assert.throws(() => g.joinRoom(room, 'laptop', 'DM laptop', 'WRONG1'), /Wrong DM key/);
  g.joinRoom(room, 'laptop', 'DM laptop', room.dmKey.toLowerCase());
  assert.equal(room.members.laptop.role, 'dm');
  assert.equal(room.members['dm-secret'].role, 'player');
});

test('inputs are clamped and sanitized', () => {
  const room = setup();
  const [c] = g.saveCombatant(room, 'p1', { type: 'pc', name: '  <b>X</b>\u0000  ', hpMax: 999999, hp: -5, ac: 'abc', level: 99, initiative: '12.5' });
  assert.equal(c.name, '<b>X</b>'); // stored as text; the client renders with textContent
  assert.equal(c.hpMax, 9999);
  assert.equal(c.hp, 0);
  assert.equal(c.ac, 10);
  assert.equal(c.level, 30);
  assert.equal(c.initiative, 12.5);
});

test('a tablet can host as a table screen; the DM joins with the DM key', () => {
  const room = g.createRoom(new Set(), 'tablet', 'Table', { screen: true });
  assert.equal(room.members.tablet.role, 'screen');
  assert.equal(g.viewFor(room, 'tablet').dmKey, room.dmKey, 'the screen can show the DM key');
  assert.throws(() => g.saveCombatant(room, 'tablet', pc('X', 1)), /only displays/);
  g.joinRoom(room, 'p1', 'Alice');
  assert.equal(g.viewFor(room, 'p1').dmKey, undefined);
  assert.throws(() => g.startCombat(room, 'p1'), /Only the Dungeon Master/);
  g.joinRoom(room, 'gm-phone', 'Gina', room.dmKey);
  assert.equal(room.members['gm-phone'].role, 'dm');
  assert.equal(room.members.tablet.role, 'screen');
  const [gob] = g.saveCombatant(room, 'gm-phone', { type: 'enemy', name: 'Goblin', hpMax: 7 });
  assert.throws(() => g.changeHp(room, 'tablet', { targetId: gob.id, amount: 1, mode: 'damage' }), /only displays/);
  g.saveCombatant(room, 'p1', pc('Aria', 15));
  g.startCombat(room, 'gm-phone');
  assert.equal(g.viewFor(room, 'tablet').yourTurn, false);
  assert.deepEqual(g.viewFor(room, 'tablet').members.map((m) => m.role), ['dm', 'screen', 'player']);
});
