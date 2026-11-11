/* D&D Turn Tracker – browser client */
(() => {
  'use strict';

  /* ------------------------------------------------------------ */
  /* tiny helpers                                                  */
  /* ------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);

  /** DOM builder. Text is always set via textContent (no HTML injection). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const store = {
    get(k, d = null) {
      try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
    },
    del(k) {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    },
  };

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  let clientId = store.get('dnd.clientId');
  if (!clientId) { clientId = uuid(); store.set('dnd.clientId', clientId); }

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ------------------------------------------------------------ */
  /* sound + green flash                                           */
  /* ------------------------------------------------------------ */
  let audioCtx = null;
  let soundOn = store.get('dnd.sound', true);

  function unlockAudio() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch { /* no audio */ }
  }
  // Browsers only allow sound after the user has interacted with the page.
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, unlockAudio, { passive: true }));

  function chime() {
    if (!soundOn || !audioCtx) return;
    const now = audioCtx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const t = now + i * 0.13;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  }

  function turnAlert() {
    chime();
    const f = $('#flash');
    f.classList.remove('go');
    void f.offsetWidth; // restart animation
    f.classList.add('go');
    if (navigator.vibrate) navigator.vibrate([250, 120, 250]);
  }

  function updateSoundButton() {
    $('#btn-sound').textContent = soundOn ? '🔊' : '🔇';
    $('#btn-sound').title = soundOn ? 'Sound on (click to mute)' : 'Sound off (click to unmute)';
  }

  // keep the phone screen awake while in a room, so players see the green screen
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && state) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* not allowed / unsupported */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  /* ------------------------------------------------------------ */
  /* socket                                                        */
  /* ------------------------------------------------------------ */
  const socket = io({ transports: ['websocket', 'polling'] });
  let state = null;
  let session = store.get('dnd.session'); // { code, name }
  let lastAlertSeq = null;
  let promptedForPc = false;

  function emit(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload, (err, res) => {
        if (err) resolve({ ok: false, error: 'The server did not respond. Check your connection.' });
        else resolve(res || { ok: false, error: 'No response.' });
      });
    });
  }

  async function act(event, payload) {
    const res = await emit(event, payload);
    if (!res.ok) toast(res.error || 'Error', true);
    return res;
  }

  socket.on('connect', async () => {
    $('#conn').classList.remove('off');
    if (session && session.code) {
      const res = await emit('room:join', { clientId, name: session.name, code: session.code });
      if (!res.ok) {
        leaveLocal();
        showLobbyError(res.error);
      }
    }
  });
  socket.on('disconnect', () => $('#conn').classList.add('off'));
  socket.on('state', (s) => {
    state = s;
    render();
  });

  /* ------------------------------------------------------------ */
  /* lobby                                                         */
  /* ------------------------------------------------------------ */
  const params = new URLSearchParams(location.search);
  $('#lobby-name').value = store.get('dnd.name', '');
  if (params.get('room')) $('#lobby-code').value = params.get('room').toUpperCase();

  function showLobbyError(msg) {
    $('#lobby-error').textContent = msg || '';
  }

  function lobbyName() {
    const name = $('#lobby-name').value.trim();
    if (!name) {
      showLobbyError('Please enter your name first.');
      $('#lobby-name').focus();
      return null;
    }
    store.set('dnd.name', name);
    return name;
  }

  function enterRoom(code, name) {
    session = { code, name };
    store.set('dnd.session', session);
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
    showLobbyError('');
    keepAwake();
  }

  $('#btn-create').addEventListener('click', async () => {
    const name = lobbyName();
    if (!name) return;
    const res = await emit('room:create', { clientId, name });
    if (!res.ok) return showLobbyError(res.error);
    enterRoom(res.code, name);
  });

  async function join() {
    const name = lobbyName();
    if (!name) return;
    const code = $('#lobby-code').value.trim().toUpperCase();
    if (!code) {
      showLobbyError('Enter the room code your DM gave you.');
      return $('#lobby-code').focus();
    }
    const dmKey = $('#lobby-dmkey').value.trim();
    const res = await emit('room:join', { clientId, name, code, dmKey: dmKey || undefined });
    if (!res.ok) return showLobbyError(res.error);
    enterRoom(res.code, name);
  }
  $('#btn-join').addEventListener('click', join);
  $('#lobby-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  function leaveLocal() {
    session = null;
    state = null;
    store.del('dnd.session');
    document.body.classList.remove('your-turn');
    document.title = 'D&D Turn Tracker';
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  $('#btn-leave').addEventListener('click', async () => {
    if (!confirm('Leave this room? You can come back later with the same code.')) return;
    await emit('room:leave', {});
    leaveLocal();
  });

  $('#btn-copy').addEventListener('click', async () => {
    if (!state) return;
    const link = `${location.origin}${location.pathname}?room=${state.code}`;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'Join my D&D table', text: `Room code: ${state.code}`, url: link });
      } else {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied!');
      }
    } catch {
      toast(`Room code: ${state.code}`);
    }
  });

  $('#btn-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    store.set('dnd.sound', soundOn);
    updateSoundButton();
    if (soundOn) { unlockAudio(); chime(); }
  });
  $('#btn-test').addEventListener('click', () => { unlockAudio(); turnAlert(); });
  updateSoundButton();

  /* ------------------------------------------------------------ */
  /* turn controls                                                 */
  /* ------------------------------------------------------------ */
  $('#btn-next').addEventListener('click', () => act('turn:next'));
  $('#btn-prev').addEventListener('click', () => act('turn:prev'));
  $('#btn-start').addEventListener('click', () => act('combat:start'));
  $('#btn-end').addEventListener('click', () => {
    if (confirm('End combat? The turn order will reset.')) act('combat:end');
  });
  $('#btn-add-enemy').addEventListener('click', () => openEditor('enemy'));
  $('#set-reveal').addEventListener('change', (e) => act('settings:update', { revealEnemies: e.target.checked }));

  /* ------------------------------------------------------------ */
  /* rendering                                                     */
  /* ------------------------------------------------------------ */
  const isDm = () => state && state.you.role === 'dm';
  const byId = (id) => state && state.combatants.find((c) => c.id === id);
  const fmtInit = (n) => String(n);

  function render() {
    if (!state) return;
    $('#lobby').hidden = true;
    $('#game').hidden = false;

    const dm = isDm();
    $('#room-code').textContent = state.code;
    const rb = $('#role-badge');
    rb.textContent = dm ? '👑 Dungeon Master' : `Player · ${state.you.name}`;
    rb.className = `badge ${dm ? 'dm' : 'player'}`;
    $('#conn').classList.toggle('off', !socket.connected);

    renderTurn();
    renderOrder();
    renderPlayerPanel();
    renderDamage();
    renderDmPanel();
    renderMembers();
    renderLog();

    if (!dm && !promptedForPc && !state.combatants.some((c) => c.mine && c.type === 'pc')) {
      promptedForPc = true;
      openEditor('pc');
    }
  }

  function renderTurn() {
    const dm = isDm();
    const { combat } = state;
    const cur = combat.turnId ? byId(combat.turnId) : null;

    document.body.classList.toggle('your-turn', state.yourTurn);
    document.title = state.yourTurn ? '🟢 YOUR TURN – D&D Turn Tracker' : 'D&D Turn Tracker';

    // alert only on this device, once per turn change
    if (state.yourTurn && combat.seq !== lastAlertSeq) {
      lastAlertSeq = combat.seq;
      turnAlert();
    }
    if (!state.yourTurn) lastAlertSeq = null;

    if (!combat.active) {
      $('#turn-round').textContent = 'Out of combat';
      $('#turn-name').textContent = dm ? 'Add enemies, then start combat.' : 'Waiting for the DM to start combat…';
    } else {
      $('#turn-round').textContent = `Round ${combat.round}`;
      if (cur) {
        let who = cur.name;
        if (cur.type === 'enemy') { if (dm) who += ' (enemy)'; } else if (cur.ownerName !== cur.name) who += ` (${cur.ownerName})`;
        $('#turn-name').textContent = who;
      } else {
        $('#turn-name').textContent = 'No one can act.';
      }
    }

    $('#btn-start').hidden = !dm || combat.active;
    $('#btn-end').hidden = !dm || !combat.active;
    $('#btn-prev').hidden = !dm || !combat.active;
    $('#btn-next').hidden = !combat.active || !(dm || state.yourTurn);
    $('#btn-next').textContent = state.yourTurn ? 'End my turn ▶' : 'Next turn ▶';
  }

  function hpClass(pct) {
    return pct <= 25 ? 'low' : pct <= 50 ? 'mid' : '';
  }

  function hpRow(c) {
    const pct = Math.max(0, Math.min(100, c.hpPct));
    const text = c.hp === null ? c.status : `${c.hp} / ${c.hpMax}`;
    return h('div', { class: 'c-hp' },
      h('div', { class: `hpbar ${hpClass(pct)}`, title: c.status }, h('div', { style: `width:${pct}%` })),
      h('span', { class: 'hptext' }, `❤️ ${text}`));
  }

  function quickHp(c, { allowDamage, allowHeal }) {
    const input = h('input', { type: 'number', min: '1', max: '9999', inputmode: 'numeric', placeholder: 'HP', 'aria-label': `Amount for ${c.name}` });
    const go = async (mode) => {
      const amount = Number(input.value);
      if (!amount || amount < 1) { input.focus(); return; }
      const attacker = mode === 'damage' ? defaultAttackerFor(c) : undefined;
      const res = await act('hp:change', { targetId: c.id, amount, mode, attackerId: attacker });
      if (res.ok) input.value = '';
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(allowDamage ? 'damage' : 'heal'); });
    return [
      input,
      allowDamage && h('button', { class: 'btn danger small', onclick: () => go('damage') }, '− Damage'),
      allowHeal && h('button', { class: 'btn small', onclick: () => go('heal') }, '+ Heal'),
    ];
  }

  function defaultAttackerFor(target) {
    // the DM's "attacker" is the creature whose turn it is, if they control it
    const cur = state.combat.turnId ? byId(state.combat.turnId) : null;
    if (cur && cur.mine && cur.id !== target.id) return cur.id;
    return undefined;
  }

  function renderOrder() {
    const dm = isDm();
    const list = $('#order');
    list.replaceChildren();
    const items = state.combatants;
    $('#order-empty').hidden = items.length > 0;
    const active = items.filter((c) => !c.hidden && !(c.type === 'enemy' && c.defeated)).length;
    $('#order-count').textContent = items.length ? `${active} in the fight` : '';

    for (const c of items) {
      const isCur = c.id === state.combat.turnId;
      const typeLabel = c.type === 'pc' ? 'Player' : c.type === 'companion' ? 'Friendly NPC' : 'Enemy';
      const sub = [];
      if (c.type !== 'enemy') {
        if (c.cls) sub.push(c.cls);
        if (c.level) sub.push(`Lv ${c.level}`);
        sub.push(c.mine && !dm ? 'you' : c.ownerName);
      }

      const actions = [];
      if (c.mine) {
        actions.push(...quickHp(c, { allowDamage: true, allowHeal: true }));
        actions.push(h('button', { class: 'btn ghost small', onclick: () => openEditor(c.type, c) }, '✏️ Edit'));
      } else if (!dm && c.type === 'enemy' && !c.defeated) {
        actions.push(h('button', { class: 'btn danger small', onclick: () => focusDamage(c.id) }, '🗡️ Attack'));
      } else if (!dm && c.type !== 'enemy') {
        actions.push(...quickHp(c, { allowDamage: false, allowHeal: true }));
      }
      if (dm && state.combat.active && !isCur && !c.hidden) {
        actions.push(h('button', { class: 'btn ghost small', title: 'Make it this creature\'s turn', onclick: () => act('turn:set', { id: c.id }) }, '▶ Give turn'));
      }

      const card = h('li', {
        class: ['card', c.type, isCur && 'current', c.defeated && 'defeated', c.hidden && 'is-hidden', c.mine && !dm && 'mine'].filter(Boolean).join(' '),
        'data-id': c.id,
      },
        h('div', { class: 'init', title: 'Initiative' }, fmtInit(c.initiative)),
        h('div', { class: 'c-main' },
          h('div', { class: 'c-title' },
            h('span', { class: 'c-name' }, c.name),
            h('span', { class: `badge ${c.type}` }, typeLabel),
            c.hidden && h('span', { class: 'badge hidden-b' }, 'Hidden'),
            c.defeated && h('span', { class: 'badge' }, c.type === 'enemy' ? '💀 Defeated' : '0 HP')),
          sub.length ? h('div', { class: 'c-sub' }, sub.join(' · ')) : null),
        h('div', { class: 'c-ac', title: 'Armor Class' }, c.ac === null ? '?' : String(c.ac), h('small', {}, 'AC')),
        hpRow(c),
        c.stats.length ? h('div', { class: 'c-stats' }, c.stats.map((s) => h('span', { class: 'chip' }, h('b', {}, s.key), s.value))) : null,
        actions.length ? h('div', { class: 'c-actions' }, actions) : null);
      list.append(card);
    }

    const cur = list.querySelector('.card.current');
    if (cur && state.yourTurn) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function miniCard(c, emptyText, emptyBtn, type) {
    if (!c) {
      return h('div', { class: 'mini' },
        h('span', { class: 'muted' }, emptyText),
        h('button', { class: `btn ${type === 'pc' ? 'primary' : ''} small`, onclick: () => openEditor(type) }, emptyBtn));
    }
    const hp = `${c.hp}/${c.hpMax} HP · AC ${c.ac} · Init ${fmtInit(c.initiative)}`;
    return h('div', { class: 'mini' },
      h('div', {},
        h('div', {}, h('strong', {}, c.name), ' ', h('span', { class: 'muted' }, [c.cls, c.level ? `Lv ${c.level}` : ''].filter(Boolean).join(' '))),
        h('div', { class: 'muted' }, hp)),
      h('button', { class: 'btn ghost small', onclick: () => openEditor(type, c) }, '✏️ Edit'));
  }

  function renderPlayerPanel() {
    const panel = $('#player-panel');
    if (isDm()) { panel.hidden = true; return; }
    panel.hidden = false;
    const pc = state.combatants.find((c) => c.mine && c.type === 'pc');
    const comp = state.combatants.find((c) => c.mine && c.type === 'companion');
    $('#my-pc').replaceChildren(miniCard(pc, 'No character yet.', 'Create character', 'pc'));
    $('#my-companion').replaceChildren(miniCard(comp, 'Friendly NPC (max 1).', '+ Add NPC', 'companion'));
  }

  function fillSelect(sel, options, keep) {
    const prev = keep ? sel.value : '';
    sel.replaceChildren(...options.map((o) => h('option', { value: o.value }, o.label)));
    if (prev && options.some((o) => o.value === prev)) sel.value = prev;
  }

  function renderDamage() {
    const panel = $('#damage-panel');
    if (isDm()) { panel.hidden = true; return; }
    panel.hidden = false;
    const enemies = state.combatants.filter((c) => c.type === 'enemy' && !c.defeated);
    const mine = state.combatants.filter((c) => c.mine);
    $('#damage-form').hidden = enemies.length === 0;
    $('#damage-empty').hidden = enemies.length > 0;

    fillSelect($('#dmg-target'), enemies.map((e) => ({
      value: e.id,
      label: e.hp === null ? `${e.name} — ${e.status}` : `${e.name} — ${e.hp}/${e.hpMax} HP`,
    })), true);

    const attackerSel = $('#dmg-attacker');
    const cur = state.combat.turnId ? byId(state.combat.turnId) : null;
    const hadValue = attackerSel.value;
    fillSelect(attackerSel, mine.map((m) => ({ value: m.id, label: m.name })), true);
    // default the attacker to whichever of my creatures is acting
    if (cur && cur.mine && (!hadValue || state.yourTurn)) attackerSel.value = cur.id;
    $('#attacker-field').hidden = mine.length < 2;
  }

  function focusDamage(id) {
    $('#dmg-target').value = id;
    const amount = $('#dmg-amount');
    amount.scrollIntoView({ block: 'center', behavior: 'smooth' });
    amount.focus({ preventScroll: true });
  }

  $('#damage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number($('#dmg-amount').value);
    const targetId = $('#dmg-target').value;
    if (!targetId || !amount) return;
    const res = await act('hp:change', {
      targetId,
      amount,
      mode: 'damage',
      attackerId: $('#dmg-attacker').value || undefined,
    });
    if (res.ok) {
      const t = byId(targetId);
      toast(`Hit ${t ? t.name : 'the enemy'} for ${amount}!`);
      $('#dmg-amount').value = '';
    }
  });

  function renderDmPanel() {
    const dm = isDm();
    $('#dm-panel').hidden = !dm;
    if (!dm) return;
    $('#set-reveal').checked = Boolean(state.settings.revealEnemies);
    $('#dm-key').textContent = state.dmKey || '';
  }

  function renderMembers() {
    const ul = $('#members');
    ul.replaceChildren(...state.members.map((m) => h('li', {},
      h('span', { class: `dot ${m.online ? 'on' : ''}`, title: m.online ? 'Online' : 'Offline' }),
      h('span', {}, m.name),
      m.role === 'dm' ? h('span', { class: 'badge dm' }, 'DM') : null,
      m.id === state.you.id ? h('span', { class: 'muted small' }, '(you)') : null)));
  }

  function renderLog() {
    const ul = $('#log');
    const items = [...state.log].reverse().map((l) => {
      const d = new Date(l.t);
      return h('li', {}, h('time', {}, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), l.text);
    });
    ul.replaceChildren(...items);
  }

  /* ------------------------------------------------------------ */
  /* editor dialog                                                 */
  /* ------------------------------------------------------------ */
  const dlg = $('#editor');
  const form = $('#editor-form');
  let editing = null; // { type, id }

  function statRow(key = '', value = '') {
    const row = h('div', { class: 'stat-row' },
      h('input', { placeholder: 'Stat (e.g. Spell DC)', maxlength: '24', value: key, 'data-k': '' }),
      h('input', { placeholder: 'Value (e.g. 15)', maxlength: '60', value, 'data-v': '' }),
      h('button', { type: 'button', class: 'btn ghost small', title: 'Remove stat', onclick: () => row.remove() }, '✕'));
    return row;
  }

  $('#btn-add-stat').addEventListener('click', () => {
    const row = statRow();
    $('#stats').append(row);
    row.querySelector('input').focus();
  });

  $('#btn-roll').addEventListener('click', () => {
    const bonus = Number(form.elements.initBonus.value) || 0;
    const roll = 1 + Math.floor(Math.random() * 20);
    form.elements.initiative.value = roll + bonus;
    toast(`🎲 d20 = ${roll}${bonus ? ` ${bonus > 0 ? '+' : '−'} ${Math.abs(bonus)}` : ''} → ${roll + bonus}`);
  });

  function openEditor(type, c = null) {
    editing = { type, id: c ? c.id : null };
    form.reset();
    $('#editor-error').textContent = '';
    const titles = {
      pc: c ? 'Edit your character' : 'Create your character',
      companion: c ? 'Edit friendly NPC' : 'Add a friendly NPC',
      enemy: c ? 'Edit enemy' : 'Add enemies',
    };
    $('#editor-title').textContent = titles[type];
    $('#cls-label').textContent = type === 'pc' ? 'Class' : 'Class / Kind';

    for (const el of form.querySelectorAll('[data-for]')) {
      const tags = el.dataset.for.split(' ');
      el.hidden = !(tags.includes(type) || (type === 'enemy' && !c && tags.includes('enemy-new')));
    }

    const f = form.elements;
    if (c) {
      f.name.value = c.name;
      f.cls.value = c.cls || '';
      f.level.value = c.level ?? 1;
      f.hpMax.value = c.hpMax;
      f.hp.value = c.hp;
      f.ac.value = c.ac;
      f.initiative.value = c.initiative;
      f.initBonus.value = c.initBonus || 0;
      f.hidden.checked = Boolean(c.hidden);
    } else {
      f.name.value = type === 'pc' ? (state ? state.you.name : '') : '';
      f.hp.value = '';
    }
    $('#stats').replaceChildren(...((c && c.stats) || []).map((s) => statRow(s.key, s.value)));
    $('#btn-delete').hidden = !c;
    dlg.showModal();
    setTimeout(() => f.name.focus(), 30);
  }

  $('#btn-cancel').addEventListener('click', () => dlg.close());

  $('#btn-delete').addEventListener('click', async () => {
    if (!editing || !editing.id) return;
    const c = byId(editing.id);
    if (!confirm(`Remove ${c ? c.name : 'this creature'}?`)) return;
    const res = await emit('combatant:remove', { id: editing.id });
    if (!res.ok) { $('#editor-error').textContent = res.error; return; }
    dlg.close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const stats = [...$('#stats').querySelectorAll('.stat-row')].map((r) => ({
      key: r.querySelector('[data-k]').value,
      value: r.querySelector('[data-v]').value,
    }));
    const combatant = {
      id: editing.id || undefined,
      type: editing.type,
      name: f.name.value,
      cls: f.cls.value,
      level: f.level.value,
      hpMax: f.hpMax.value,
      hp: f.hp.value === '' ? undefined : f.hp.value,
      ac: f.ac.value,
      initiative: f.initiative.value,
      initBonus: f.initBonus.value,
      count: f.count.value,
      hidden: editing.type === 'enemy' ? f.hidden.checked : undefined,
      stats,
    };
    const res = await emit('combatant:save', { combatant });
    if (!res.ok) { $('#editor-error').textContent = res.error; return; }
    dlg.close();
    toast(editing.id ? 'Saved.' : 'Added!');
  });
})();
