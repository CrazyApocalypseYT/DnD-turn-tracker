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

test('players get exactly one character and up to 3 friendly NPCs', () => {
  const room = setup();
  g.saveCombatant(room, 'p1', pc('Aria', 15, { stats: [{ key: 'Spell DC', value: '14' }] }));
  assert.throws(() => g.saveCombatant(room, 'p1', pc('Aria 2', 10)), /already have a character/);
  g.saveCombatant(room, 'p1', { type: 'companion', name: 'Wolf', hpMax: 11, ac: 13, initiative: 12 });
  g.saveCombatant(room, 'p1', { type: 'companion', name: 'Hawk', hpMax: 5 });
  g.saveCombatant(room, 'p1', { type: 'companion', name: 'Imp', hpMax: 4 });
  assert.throws(() => g.saveCombatant(room, 'p1', { type: 'companion', name: 'Owl', hpMax: 1 }), /up to 3 friendly NPCs/);
  g.saveCombatant(room, 'p2', { type: 'companion', name: 'Bob\'s mule', hpMax: 11 }); // the limit is per player
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
  const [c] = g.saveCombatant(room, 'p1', { type: 'pc', name: '  <b>X</b>\u0000  ', hpMax: 5e9, hp: -5, ac: 'abc', level: 1e9, initiative: '12.5' });
  assert.equal(c.name, '<b>X</b>'); // stored as text; the client renders with textContent
  assert.equal(c.hpMax, 1000000, 'numbers are only capped at a sanity limit of 1,000,000');
  assert.equal(c.hp, 0);
  assert.equal(c.ac, 10);
  assert.equal(c.level, 1000000);
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

test('custom stats with a max become bars; text stats stay text', () => {
  const room = setup();
  const [c] = g.saveCombatant(room, 'p1', pc('Aria', 15, {
    stats: [
      { key: 'Mana', value: '12', max: '20' },
      { key: 'Movement', max: 30, refill: true },
      { key: 'Ki', value: 99, max: 5, color: 'pink' },
      { key: 'Spell DC', value: '15' },
      { key: 'Bad color', max: 3, color: '<script>' },
    ],
  }));
  assert.deepEqual(c.stats[0], { key: 'Mana', value: 12, max: 20, color: 'blue', refill: false });
  assert.deepEqual(c.stats[1], { key: 'Movement', value: 30, max: 30, color: 'yellow', refill: true });
  assert.equal(c.stats[2].value, 5, 'value is clamped to max');
  assert.equal(c.stats[2].color, 'pink');
  assert.deepEqual(c.stats[3], { key: 'Spell DC', value: '15' });
  assert.ok(g.BAR_COLORS.includes(c.stats[4].color));
});

test('bars can be adjusted by the owner or DM only, within 0..max', () => {
  const room = setup();
  const [c] = g.saveCombatant(room, 'p1', pc('Aria', 15, { stats: [{ key: 'Mana', value: 5, max: 10 }, { key: 'DC', value: '14' }] }));
  g.adjustStat(room, 'p1', { id: c.id, index: 0, delta: -3 });
  assert.equal(c.stats[0].value, 2);
  g.adjustStat(room, 'p1', { id: c.id, index: 0, delta: -50 });
  assert.equal(c.stats[0].value, 0);
  g.adjustStat(room, 'dm-secret', { id: c.id, index: 0, value: 7 });
  assert.equal(c.stats[0].value, 7);
  assert.throws(() => g.adjustStat(room, 'p2', { id: c.id, index: 0, delta: 1 }), /cannot change/);
  assert.throws(() => g.adjustStat(room, 'p1', { id: c.id, index: 1, delta: 1 }), /no longer exists/);
});

test('"refills every turn" bars fill up when that creature\'s turn starts', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15, { stats: [{ key: 'Movement', value: 30, max: 30, refill: true }, { key: 'Mana', value: 10, max: 10 }] }));
  g.saveCombatant(room, 'p2', pc('Bo', 12));
  g.startCombat(room, 'dm-secret'); // Aria's turn
  g.adjustStat(room, 'p1', { id: aria.id, index: 0, delta: -25 });
  g.adjustStat(room, 'p1', { id: aria.id, index: 1, delta: -4 });
  g.nextTurn(room, 'p1'); // Bo
  assert.equal(aria.stats[0].value, 5, 'not refilled on someone else\'s turn');
  g.nextTurn(room, 'p2'); // Aria again, round 2
  assert.equal(aria.stats[0].value, 30, 'movement refilled');
  assert.equal(aria.stats[1].value, 6, 'mana does not refill');
});

test('a device can join an existing room as a table display, without seeing the DM key', () => {
  const room = setup();
  g.joinRoom(room, 'tab', 'Tablet', undefined, { screen: true });
  assert.equal(room.members.tab.role, 'screen');
  assert.equal(g.viewFor(room, 'tab').dmKey, undefined, 'only the display that created the room may show the DM key');
  assert.throws(() => g.saveCombatant(room, 'tab', pc('X', 1)), /only displays/);
  g.joinRoom(room, 'p1', 'Alice', undefined, { screen: true });
  assert.equal(room.members.p1.role, 'player', 'existing members keep their role');
});

test('no practical limits: high levels, huge monster HP/AC, many custom stats', () => {
  const room = setup();
  const [hero] = g.saveCombatant(room, 'p1', pc('Epic', 10, { level: 45 }));
  assert.equal(hero.level, 45);
  const stats = Array.from({ length: 60 }, (_, i) => ({ key: `Stat ${i}`, value: String(i) }));
  stats.push({ key: 'Legendary HP pool', value: 250000, max: 250000 });
  const [tarrasque] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Tarrasque+', hpMax: 120000, ac: 65, initiative: 30, stats });
  assert.equal(tarrasque.hpMax, 120000);
  assert.equal(tarrasque.ac, 65);
  assert.equal(tarrasque.stats.length, 61);
  assert.equal(tarrasque.stats[60].max, 250000);
  g.changeHp(room, 'p1', { targetId: tarrasque.id, amount: 50000, mode: 'damage' });
  assert.equal(tarrasque.hp, 70000);
});

test('conditions: official presets, custom ones, durations that wear off', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15, { stats: [{ key: 'Movement', max: 30 }] }));
  const [bo] = g.saveCombatant(room, 'p2', pc('Bo', 12));
  const [gob] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, initiative: 5 });

  const poisoned = g.addCondition(room, 'dm-secret', { id: aria.id, condition: { preset: 'poisoned' } });
  assert.equal(poisoned.emoji, '🤢');
  assert.equal(poisoned.kind, 'debuff');
  assert.deepEqual([poisoned.color, poisoned.bar], ['purple', 'hp']);

  // a player blesses an ally for 2 rounds and restrains an enemy
  const bless = g.addCondition(room, 'p2', { id: aria.id, condition: { preset: 'blessed', rounds: 2 } });
  g.addCondition(room, 'p2', { id: gob.id, condition: { preset: 'restrained' } });
  // custom buff that recolors one named bar
  const custom = g.addCondition(room, 'p1', { id: aria.id, condition: { name: 'Wind walk', emoji: '🌪️', kind: 'buff', color: 'cyan', bar: 'stat:Movement', rounds: '' } });
  assert.deepEqual([custom.bar, custom.rounds], ['stat:Movement', null]);
  assert.throws(() => g.addCondition(room, 'p1', { id: aria.id, condition: { name: '' } }), /name/);
  assert.throws(() => g.addCondition(room, 'p1', { id: aria.id, condition: { preset: 'nope' } }), /Unknown/);

  // exhaustion stacks 1..6
  const ex = g.addCondition(room, 'dm-secret', { id: bo.id, condition: { preset: 'exhaustion' } });
  g.addCondition(room, 'dm-secret', { id: bo.id, condition: { preset: 'exhaustion' } });
  assert.equal(ex.level, 2);
  g.conditionLevel(room, 'dm-secret', { id: bo.id, condId: ex.id, delta: -1 });
  assert.equal(ex.level, 1);

  // durations tick down when the creature's turn ends
  g.startCombat(room, 'dm-secret'); // Aria
  g.nextTurn(room, 'p1'); // end of Aria's turn: bless 2 -> 1
  assert.equal(aria.conditions.find((k) => k.key === 'blessed').rounds, 1);
  g.nextTurn(room, 'p2'); // Bo -> Goblin
  g.nextTurn(room, 'dm-secret'); // Goblin -> Aria (round 2)
  g.nextTurn(room, 'p1'); // end of Aria's turn: bless wears off
  assert.equal(aria.conditions.some((k) => k.id === bless.id), false);
  assert.ok(room.log.some((l) => l.text === '✨ Blessed wore off Aria.'));
  assert.ok(aria.conditions.some((k) => k.id === poisoned.id), 'conditions without a duration stay');
});

test('conditions: removal permissions and secret conditions', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', pc('Aria', 15));
  const [gob] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7 });
  const dmPoison = g.addCondition(room, 'dm-secret', { id: aria.id, condition: { preset: 'poisoned' } });
  const bobsRestrain = g.addCondition(room, 'p2', { id: gob.id, condition: { preset: 'restrained' } });
  const curse = g.addCondition(room, 'dm-secret', { id: aria.id, condition: { preset: 'cursed', secret: true } });
  const playerSecret = g.addCondition(room, 'p1', { id: aria.id, condition: { name: 'Sneaky', secret: true } });
  assert.equal(playerSecret.secret, false, 'only the DM can make secret conditions');

  // players don't see secret conditions
  const view = g.viewFor(room, 'p1').combatants.find((c) => c.name === 'Aria');
  assert.ok(!view.conditions.some((k) => k.id === curse.id));
  assert.ok(g.viewFor(room, 'dm-secret').combatants.find((c) => c.name === 'Aria').conditions.some((k) => k.id === curse.id));
  assert.ok(!room.log.some((l) => l.text.includes('Cursed')), 'secret condition not in the public log');

  // Alice can end the DM's poison on her own character, but not Bob's restrain on the goblin
  g.removeCondition(room, 'p1', { id: aria.id, condId: dmPoison.id });
  assert.throws(() => g.removeCondition(room, 'p1', { id: gob.id, condId: bobsRestrain.id }), /Only the DM or whoever added it/);
  g.removeCondition(room, 'p2', { id: gob.id, condId: bobsRestrain.id });
  assert.throws(() => g.removeCondition(room, 'p1', { id: aria.id, condId: curse.id }), /Only the DM/);
  g.removeCondition(room, 'dm-secret', { id: aria.id, condId: curse.id });
});

test('bosses, summons that die/flee/stay with their leader, and acting right after the leader', () => {
  const room = setup();
  g.saveCombatant(room, 'p1', pc('Aria', 15));
  const [lich] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Lich', hpMax: 135, initiative: 18, boss: true });
  assert.equal(lich.boss, true);
  const skels = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Skeleton', hpMax: 13, initiative: 3, count: 2, leader: lich.id, onLeaderDeath: 'dies', followLeader: true });
  const [ghoul] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Ghoul', hpMax: 22, initiative: 10, leader: lich.id, onLeaderDeath: 'flees' });
  const [knight] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Death knight', hpMax: 180, initiative: 12, leader: lich.id, onLeaderDeath: 'stays' });
  const [bone] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Bone imp', hpMax: 5, initiative: 1, leader: skels[0].id });

  // followers act right after the Lich, before Aria
  assert.deepEqual(g.sortedCombatants(room).map((c) => c.name), ['Lich', 'Skeleton 1', 'Skeleton 2', 'Aria', 'Death knight', 'Ghoul', 'Bone imp']);
  assert.equal(g.viewFor(room, 'p1').combatants.find((c) => c.name === 'Skeleton 1').initiative, 18);
  assert.equal(g.viewFor(room, 'p1').combatants.find((c) => c.name === 'Skeleton 1').leaderName, 'Lich');

  // no loops
  assert.throws(() => g.saveCombatant(room, 'dm-secret', { id: lich.id, name: 'Lich', hpMax: 135, leader: skels[0].id }), /itself or its own summons/);

  g.startCombat(room, 'dm-secret');
  g.changeHp(room, 'p1', { targetId: lich.id, amount: 200, mode: 'damage' });
  assert.equal(lich.hp, 0);
  assert.equal(skels[0].hp, 0, 'summons die with their leader');
  assert.equal(skels[1].hp, 0);
  assert.equal(bone.hp, 0, 'and so do their own summons');
  assert.ok(!room.combatants.includes(ghoul), 'the ghoul fled');
  assert.equal(knight.hp, 180, 'the death knight keeps fighting');
  assert.ok(room.log.some((l) => l.text === '💀 Skeleton 1 perishes with Lich!'));
  assert.ok(room.log.some((l) => l.text === '🏃 Ghoul flees as Lich falls!'));
});

test('removing a leader just unlinks its summons; lair actions act on 20 and lose ties', () => {
  const room = setup();
  const [lich] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Lich', hpMax: 135, initiative: 20 });
  const [sk] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Skeleton', hpMax: 13, leader: lich.id, followLeader: true });
  const [lair] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Lair actions', initiative: 20, lair: true });
  g.saveCombatant(room, 'p1', pc('Aria', 20));
  assert.equal(g.sortedCombatants(room).at(-1).id, lair.id, 'lair loses the tie at 20');
  assert.throws(() => g.changeHp(room, 'dm-secret', { targetId: lair.id, amount: 5, mode: 'damage' }), /no HP/);
  g.removeCombatant(room, 'dm-secret', lich.id);
  assert.equal(sk.leader, null);
  assert.equal(sk.hp, 13);
});

test('initiative is entered as a roll; the total adds the bonus and orders the fight', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', { type: 'pc', name: 'Aria', hpMax: 20, initBonus: 3 });
  assert.equal(aria.initiative, null, 'no initiative until rolled');
  g.setInitiative(room, 'p1', { rolls: [{ id: aria.id, roll: 14 }] });
  assert.deepEqual([aria.initRoll, aria.initiative], [14, 17]);
  g.saveCombatant(room, 'p1', { id: aria.id, name: 'Aria', hpMax: 20, initBonus: 5 });
  assert.equal(aria.initiative, 19, 'changing the bonus updates the total');
  assert.throws(() => g.setInitiative(room, 'p2', { rolls: [{ id: aria.id, roll: 3 }] }), /own creatures/);
  assert.throws(() => g.setInitiative(room, 'p1', { rolls: [{ id: aria.id, roll: 'x' }] }), /Enter a number/);
  const [bo] = g.saveCombatant(room, 'p2', { type: 'pc', name: 'Bo', hpMax: 20 });
  assert.equal(g.sortedCombatants(room).at(-1).id, bo.id, 'unrolled creatures go last');
  assert.equal(g.viewFor(room, 'p2').combatants.find((c) => c.name === 'Bo').initiative, null);
});

test('starting combat runs an initiative round: DM first, then players in join order, then last order', () => {
  const room = setup(); // join order: Alice (p1), Bob (p2)
  const [aria] = g.saveCombatant(room, 'p1', { type: 'pc', name: 'Aria', hpMax: 20, initBonus: 2 });
  const [wolf] = g.saveCombatant(room, 'p1', { type: 'companion', name: 'Wolf', hpMax: 11 });
  const [bo] = g.saveCombatant(room, 'p2', { type: 'pc', name: 'Bo', hpMax: 20 });
  const gobs = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Goblin', hpMax: 7, initBonus: 2, count: 2 });
  const [lich] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Lich', hpMax: 99 });
  g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Skeleton', hpMax: 13, leader: lich.id, followLeader: true });
  const [lair] = g.saveCombatant(room, 'dm-secret', { type: 'enemy', name: 'Lair actions', initiative: 20, lair: true });

  g.startCombat(room, 'dm-secret', { roll: true });
  const roller = () => g.viewFor(room, 'p1').combat.rollers.map((r) => r.name);
  assert.equal(room.combat.active, false);
  assert.deepEqual(roller(), ['Dungeon Master', 'Alice', 'Bob']);
  assert.equal(g.viewFor(room, 'dm-secret').yourRoll, true);
  assert.equal(g.viewFor(room, 'p1').yourRoll, false);
  assert.throws(() => g.nextTurn(room, 'dm-secret'), /Combat has not started/);

  // the DM rolls for the goblins and the lich (not the follower, not the lair)
  g.setInitiative(room, 'dm-secret', { rolls: [{ id: gobs[0].id, roll: 10 }, { id: gobs[1].id, roll: 5 }] });
  assert.deepEqual(roller(), ['Dungeon Master', 'Alice', 'Bob'], 'still the DM: the lich has no roll yet');
  g.setInitiative(room, 'dm-secret', { rolls: [{ id: lich.id, roll: 16 }] });
  assert.deepEqual(roller(), ['Alice', 'Bob']);
  assert.equal(g.viewFor(room, 'p1').yourRoll, true);
  g.setInitiative(room, 'p1', { rolls: [{ id: aria.id, roll: 12 }, { id: wolf.id, roll: 3 }] });
  g.setInitiative(room, 'p2', { rolls: [{ id: bo.id, roll: 18 }] });

  assert.equal(room.combat.active, true, 'combat starts when everyone has rolled');
  assert.deepEqual(g.sortedCombatants(room).map((c) => `${c.name} ${g.viewFor(room, 'dm-secret').combatants.find((v) => v.id === c.id).initiative}`),
    ['Lair actions 20', 'Bo 18', 'Lich 16', 'Skeleton 16', 'Aria 14', 'Goblin 1 12', 'Goblin 2 7', 'Wolf 3']);
  assert.equal(room.combat.turnId, lair.id);

  // next combat: players go in last combat's order (Bob acted before Alice)
  g.endCombat(room, 'dm-secret');
  g.startCombat(room, 'dm-secret', { roll: true });
  assert.deepEqual(roller(), ['Dungeon Master', 'Bob', 'Alice']);
  assert.equal(aria.initiative, null, 'rolls reset for the new combat');
  // the DM can roll automatically for someone who is away
  g.skipRoller(room, 'dm-secret');
  assert.deepEqual(roller(), ['Bob', 'Alice']);
  assert.ok(gobs.every((x) => x.initRoll >= 1 && x.initRoll <= 20));
  assert.throws(() => g.skipRoller(room, 'p1'), /Only the Dungeon Master/);
});

test('map: DM or table display set a link and draw; players only look', () => {
  const room = setup();
  g.joinRoom(room, 'tab', 'Table', undefined, { screen: true });
  assert.throws(() => g.setMap(room, 'p1', { url: 'https://example.com/map.png' }), /Only the DM/);
  assert.throws(() => g.setMap(room, 'dm-secret', { url: 'javascript:alert(1)' }), /http/);
  g.setMap(room, 'dm-secret', { url: 'https://example.com/maps/cave.PNG?x=1' });
  assert.equal(room.map.kind, 'image', 'image links are detected');
  g.setMap(room, 'dm-secret', { url: 'https://example.com/board' });
  assert.equal(room.map.kind, 'page');
  g.addStroke(room, 'dm-secret', { color: 'yellow', width: 3, points: [[0.1, 0.2], [2, -1], ['x', 1], [0.33333, 0.5]] });
  assert.deepEqual(room.map.strokes[0].points, [[0.1, 0.2], [1, 0], [0.3333, 0.5]]);
  g.addStroke(room, 'tab', { color: 'nope', points: [[0.5, 0.5]] });
  assert.equal(room.map.strokes[1].color, 'red');
  assert.throws(() => g.addStroke(room, 'p1', { points: [[0, 0]] }), /Only the DM/);
  assert.equal(g.viewFor(room, 'p1').map.strokes.length, 2);
  assert.equal(g.viewFor(room, 'p1').canMap, false);
  g.undoStroke(room, 'dm-secret');
  assert.equal(room.map.strokes.length, 1);
  g.clearStrokes(room, 'tab');
  assert.equal(room.map.strokes.length, 0);
  for (let i = 0; i < 230; i++) g.addStroke(room, 'dm-secret', { points: [[0, 0], [1, 1]] });
  assert.equal(room.map.strokes.length, 200, 'oldest strokes are dropped past the limit');
});

test('friendly NPCs can wait in reserve: no turns, no initiative roll, until they join the battle', () => {
  const room = setup();
  const [aria] = g.saveCombatant(room, 'p1', { type: 'pc', name: 'Aria', hpMax: 20, initiative: 15 });
  const [wolf] = g.saveCombatant(room, 'p1', { type: 'companion', name: 'Wolf', hpMax: 11, initiative: 18, reserve: true });
  const [bo] = g.saveCombatant(room, 'p2', { type: 'pc', name: 'Bo', hpMax: 20, initiative: 10 });
  assert.equal(wolf.reserve, true);
  assert.throws(() => g.setReserve(room, 'p1', { id: aria.id, reserve: true }), /Only friendly NPCs/);
  assert.throws(() => g.setReserve(room, 'p2', { id: wolf.id, reserve: false }), /owner or the DM/);
  assert.equal(g.viewFor(room, 'p2').combatants.find((c) => c.name === 'Wolf').reserve, true, 'everyone sees it is in reserve');

  // turns skip the reserve
  g.startCombat(room, 'dm-secret');
  assert.equal(room.combat.turnId, aria.id, 'the wolf (18) waits in reserve');
  g.nextTurn(room, 'p1');
  assert.equal(room.combat.turnId, bo.id);
  // the wolf joins mid-fight: it gets turns again (it already has initiative 18)
  g.setReserve(room, 'p1', { id: wolf.id, reserve: false });
  g.nextTurn(room, 'p2');
  assert.equal(room.combat.turnId, wolf.id, 'new round: wolf (18) acts first');
  // sent back to reserve on its own turn: the turn passes on
  g.setReserve(room, 'dm-secret', { id: wolf.id, reserve: true });
  assert.equal(room.combat.turnId, aria.id);
  assert.ok(room.log.some((l) => l.text === '⚔️ Wolf joins the battle!'));

  // initiative round: reserve NPCs are not asked to roll
  g.endCombat(room, 'dm-secret');
  g.startCombat(room, 'dm-secret', { roll: true });
  g.setInitiative(room, 'p1', { rolls: [{ id: aria.id, roll: 12 }] });
  assert.deepEqual(g.viewFor(room, 'p1').combat.rollers.map((r) => r.name), ['Bob'], 'Alice is done without rolling for the wolf');
  // joining during the initiative round puts the owner back in the queue
  g.setReserve(room, 'p1', { id: wolf.id, reserve: false });
  assert.deepEqual(g.viewFor(room, 'p1').combat.rollers.map((r) => r.name), ['Bob', 'Alice']);
});

test('map: the line being drawn is shared live, then replaced by the finished stroke', () => {
  const room = setup();
  g.setMap(room, 'dm-secret', { url: 'https://example.com/map.png' });
  assert.throws(() => g.setDraft(room, 'p1', { points: [[0, 0]] }), /Only the DM/);
  g.setDraft(room, 'dm-secret', { color: 'cyan', points: [[0.1, 0.1], [0.2, 0.2]] });
  assert.deepEqual(g.viewFor(room, 'p1').map.draft, { color: 'cyan', width: 2, points: [[0.1, 0.1], [0.2, 0.2]] });
  g.addStroke(room, 'dm-secret', { color: 'cyan', points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]] });
  assert.equal(g.viewFor(room, 'p1').map.draft, null, 'finished stroke replaces the draft');
  assert.equal(room.map.strokes.length, 1);
  assert.ok(!room.log.some((l) => /draft/i.test(l.text)), 'drafts are not logged');
  g.setDraft(room, 'dm-secret', { points: [[0.5, 0.5]] });
  g.setDraft(room, 'dm-secret', { points: null });
  assert.equal(room.map.draft, null);
});

test('map image upload in chunks through the hub; every device can download it; it stays out of the room view', async () => {
  const { createHub } = require('../public/shared/hub');
  const hub = createHub();
  const sent = { dm: [], p1: [] };
  const dm = hub.connect((st) => sent.dm.push(st), { canCreate: true });
  const p1 = hub.connect((st) => sent.p1.push(st));
  const { code } = hub.handle(dm, 'room:create', { clientId: 'dm-c', name: 'Gina' });
  hub.handle(p1, 'room:join', { clientId: 'p1-c', name: 'Alice', code });

  const image = `data:image/jpeg;base64,${'A'.repeat(120000)}`;
  const size = g.MAP_IMAGE.chunk;
  const parts = [];
  for (let i = 0; i < image.length; i += size) parts.push(image.slice(i, i + size));
  assert.equal(parts.length, 3);
  assert.equal(hub.handle(p1, 'map:upload', { id: 'img1', index: 0, total: 3, data: parts[0] }).ok, false, 'players cannot upload maps');
  await new Promise((r) => setImmediate(r));
  const before = sent.dm.length;
  assert.deepEqual(hub.handle(dm, 'map:upload', { id: 'img1', index: 2, total: 3, data: parts[2] }), { ok: true, received: 1 });
  hub.handle(dm, 'map:upload', { id: 'img1', index: 0, total: 3, data: parts[0] });
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.dm.length, before, 'partial uploads do not spam the other devices');
  assert.deepEqual(hub.handle(dm, 'map:upload', { id: 'img1', index: 1, total: 3, data: parts[1] }), { ok: true, done: true });
  await new Promise((r) => setImmediate(r));
  const view = sent.p1.at(-1);
  assert.deepEqual([view.map.kind, view.map.imageId, view.map.url], ['upload', 'img1', '']);
  assert.ok(!JSON.stringify(view).includes('AAAAAAAAAA'), 'the picture is not inside the room view');

  // a player downloads it chunk by chunk
  let got = '';
  let total = 1;
  for (let i = 0; i < total; i++) {
    const r = hub.handle(p1, 'map:image', { id: 'img1', index: i });
    assert.equal(r.ok, true);
    total = r.total;
    got += r.data;
  }
  assert.equal(got, image);
  // the pen works on uploaded maps
  assert.equal(hub.handle(dm, 'map:stroke', { points: [[0.1, 0.1], [0.5, 0.5]] }).ok, true);
  // a link replaces the uploaded image
  hub.handle(dm, 'map:set', { url: 'https://example.com/map.png' });
  assert.equal(hub.handle(p1, 'map:image', { id: 'img1', index: 0 }).ok, false);
  // bad data is refused
  const bad = hub.handle(dm, 'map:upload', { id: 'x', index: 0, total: 1, data: 'data:text/html;base64,PHNjcmlwdD4=' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a supported image/);
});
