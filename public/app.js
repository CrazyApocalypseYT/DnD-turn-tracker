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
  /* networking                                                    */
  /* ------------------------------------------------------------ */
  const { SocketNet, P2PHost, P2PGuest, mode: NET_MODE } = window.DndNet;
  let net = null; // current transport
  let socketNet = null; // server mode: one socket for the whole session
  let state = null;
  let session = store.get('dnd.session'); // { code, name, host?, screen? }
  let lastAlertSeq = null;
  let promptedForPc = false;

  const callbacks = {
    onState(s) {
      state = s;
      render();
    },
    onStatus({ online, text }) {
      $('#conn').classList.toggle('off', !online);
      $('#conn').title = online ? 'Connected' : 'Not connected';
      const bar = $('#net-status');
      bar.textContent = text || '';
      bar.hidden = !text;
    },
    async onReconnected() {
      // after a dropped connection, silently re-join the room
      if (!session || session.host) return;
      const res = await net.request('room:join', { clientId, name: session.name, code: session.code, screen: session.screen });
      if (!res.ok) {
        leaveLocal();
        showLobbyError(res.error);
      }
    },
  };

  function saveHostedRoom(room) {
    store.set('dnd.hostRoom', room);
  }

  async function getSocketNet() {
    if (!socketNet) {
      socketNet = new SocketNet(callbacks);
      await socketNet.start();
    }
    return socketNet;
  }

  function emit(event, payload) {
    if (!net) return Promise.resolve({ ok: false, error: 'Not connected.' });
    return net.request(event, payload);
  }

  async function act(event, payload) {
    const res = await emit(event, payload);
    if (!res.ok) toast(res.error || 'Error', true);
    return res;
  }

  async function createRoom(name, screen) {
    if (NET_MODE === 'server') {
      net = await getSocketNet();
      return net.request('room:create', { clientId, name, screen });
    }
    if (net) net.close();
    net = new P2PHost(callbacks, { clientId, onSave: saveHostedRoom });
    return net.create(name, screen);
  }

  async function joinRoom(code, name, dmKey, screen) {
    if (NET_MODE === 'server') {
      net = await getSocketNet();
      return net.request('room:join', { clientId, name, code, dmKey, screen });
    }
    if (net) net.close();
    net = new P2PGuest(callbacks);
    try {
      await net.connect(code);
    } catch (err) {
      net.close();
      net = null;
      return { ok: false, error: err.message };
    }
    const res = await net.request('room:join', { clientId, name, code, dmKey, screen });
    if (!res.ok) { net.close(); net = null; }
    return res;
  }

  /** On page load: go back into the room this device was in. */
  async function resume() {
    if (!session || !session.code) {
      if (NET_MODE === 'server') getSocketNet().catch(() => {});
      return;
    }
    if (NET_MODE === 'server') {
      net = await getSocketNet(); // re-joins in onReconnected
      return;
    }
    let res;
    if (session.host) {
      const room = store.get('dnd.hostRoom');
      if (!room || room.code !== session.code) {
        leaveLocal();
        return showLobbyError('The room that was hosted on this device is no longer saved here.');
      }
      net = new P2PHost(callbacks, { clientId, onSave: saveHostedRoom });
      res = await net.restore(room, session.name);
    } else {
      showLobbyError('Reconnecting to the room…');
      res = await joinRoom(session.code, session.name);
    }
    if (!res.ok) {
      leaveLocal();
      showLobbyError(res.error);
    } else {
      showLobbyError('');
      keepAwake();
    }
  }

  /* ------------------------------------------------------------ */
  /* lobby                                                         */
  /* ------------------------------------------------------------ */
  const params = new URLSearchParams(location.search);
  $('#lobby-name').value = store.get('dnd.name', '');
  if (params.get('room')) $('#lobby-code').value = params.get('room').toUpperCase();
  if (NET_MODE === 'p2p') $('#host-hint').hidden = false;

  function showLobbyError(msg) {
    $('#lobby-error').textContent = msg || '';
  }

  function lobbyName(fallback) {
    const name = $('#lobby-name').value.trim() || fallback || '';
    if (!name) {
      showLobbyError('Please enter your name first.');
      $('#lobby-name').focus();
      return null;
    }
    if ($('#lobby-name').value.trim()) store.set('dnd.name', name);
    return name;
  }

  function enterRoom(code, name, extra = {}) {
    session = { code, name, ...extra };
    store.set('dnd.session', session);
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url);
    showLobbyError('');
    keepAwake();
    render(); // state may have arrived before the session was saved
  }

  async function withBusy(btn, fn) {
    const all = document.querySelectorAll('#lobby button');
    all.forEach((b) => { b.disabled = true; });
    const label = btn.textContent;
    btn.textContent = 'Connecting…';
    try { await fn(); } finally {
      all.forEach((b) => { b.disabled = false; });
      btn.textContent = label;
    }
  }

  async function create(screen) {
    const name = lobbyName(screen ? 'Table screen' : '');
    if (!name) return;
    unlockAudio();
    const btn = screen ? $('#btn-create-screen') : $('#btn-create');
    await withBusy(btn, async () => {
      const res = await createRoom(name, screen);
      if (!res.ok) return showLobbyError(res.error);
      enterRoom(res.code, name, { host: NET_MODE === 'p2p', screen: Boolean(screen) });
    });
  }
  $('#btn-create').addEventListener('click', () => create(false));
  $('#btn-create-screen').addEventListener('click', () => create(true));

  async function join(screen = false) {
    const name = lobbyName(screen ? 'Table display' : '');
    if (!name) return;
    const code = $('#lobby-code').value.trim().toUpperCase();
    if (!code) {
      showLobbyError('Enter the room code (or scan the QR code on the host device).');
      return $('#lobby-code').focus();
    }
    unlockAudio();
    const dmKey = screen ? '' : $('#lobby-dmkey').value.trim();
    await withBusy(screen ? $('#btn-join-screen') : $('#btn-join'), async () => {
      const res = await joinRoom(code, name, dmKey || undefined, screen);
      if (!res.ok) return showLobbyError(res.error);
      enterRoom(res.code, name, { screen });
    });
  }
  $('#btn-join').addEventListener('click', () => join(false));
  $('#btn-join-screen').addEventListener('click', () => join(true));
  $('#lobby-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(false); });

  function leaveLocal() {
    if (net && net !== socketNet) net.close();
    if (session && session.host) store.del('dnd.hostRoom');
    net = socketNet;
    session = null;
    state = null;
    store.del('dnd.session');
    document.body.classList.remove('your-turn');
    document.title = 'D&D Turn Tracker';
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    $('#net-status').hidden = true;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  $('#btn-leave').addEventListener('click', async () => {
    const hosting = session && session.host;
    const msg = hosting
      ? 'This device is hosting the room. If you leave, the room closes for everyone. Leave anyway?'
      : 'Leave this room? You can come back later with the same code.';
    if (!confirm(msg)) return;
    if (!hosting) await emit('room:leave', {});
    leaveLocal();
  });

  function inviteLink() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', state.code);
    return url.toString();
  }

  function qrSvg(text) {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const tpl = document.createElement('template');
    tpl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const svg = tpl.content.firstElementChild;
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `QR code for ${text}`);
    return svg;
  }

  function openInvite() {
    if (!state) return;
    const link = inviteLink();
    $('#invite-qr').replaceChildren(qrSvg(link));
    $('#invite-code').textContent = state.code;
    $('#invite-link').textContent = link;
    $('#invite').showModal();
  }
  $('#btn-invite').addEventListener('click', openInvite);
  $('#btn-invite-close').addEventListener('click', () => $('#invite').close());

  $('#btn-share').addEventListener('click', async () => {
    if (!state) return;
    const link = inviteLink();
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join my D&D table', text: `Room code: ${state.code}`, url: link });
      } else {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied!');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      try { await navigator.clipboard.writeText(link); toast('Invite link copied!'); } catch { toast(`Room code: ${state.code}`); }
    }
  });

  $('#btn-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    store.set('dnd.sound', soundOn);
    updateSoundButton();
    if (soundOn) { unlockAudio(); chime(); }
  });
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
  const isScreen = () => state && state.you.role === 'screen';
  const byId = (id) => state && state.combatants.find((c) => c.id === id);
  const fmtInit = (n) => String(n);

  function render() {
    if (!state) return;
    $('#lobby').hidden = true;
    $('#game').hidden = false;

    const dm = isDm();
    $('#room-code').textContent = state.code;
    const rb = $('#role-badge');
    const screen = isScreen();
    rb.textContent = dm ? '👑 Dungeon Master' : screen ? '📺 Table display' : `Player · ${state.you.name}`;
    rb.className = `badge ${dm ? 'dm' : screen ? 'screen' : 'player'}`;
    $('#host-badge').hidden = !(session && session.host);
    document.body.classList.toggle('screen-mode', screen);

    renderTurn();
    renderOrder();
    renderPlayerPanel();
    renderDamage();
    renderDmPanel();
    renderDisplay();
    renderMembers();
    renderLog();

    if (!dm && !screen && !promptedForPc && !state.combatants.some((c) => c.mine && c.type === 'pc')) {
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

  /** Bar stats (mana, movement…) under the HP bar, with −/+ for whoever controls the creature. */
  function resourceBars(c, { controls = true } = {}) {
    const bars = c.stats.map((s, i) => [s, i]).filter(([s]) => typeof s.max === 'number');
    if (!bars.length) return null;
    const canEdit = controls && c.mine;
    return h('div', { class: 'c-bars' }, bars.map(([s, i]) => {
      const pct = Math.round((s.value / s.max) * 100);
      const set = async () => {
        const v = prompt(`${s.key} for ${c.name} (0–${s.max}):`, String(s.value));
        if (v === null || v.trim() === '') return;
        act('stat:adjust', { id: c.id, index: i, value: v });
      };
      return h('div', { class: `res res-${s.color}` },
        h('span', { class: 'res-name' }, s.refill ? `${s.key} 🔁` : s.key),
        h('div', { class: 'resbar', title: s.refill ? 'Refills at the start of each turn' : '' }, h('div', { style: `width:${pct}%` })),
        canEdit
          ? h('button', { class: 'res-val linkish', title: 'Set value', onclick: set }, `${s.value}/${s.max}`)
          : h('span', { class: 'res-val' }, `${s.value}/${s.max}`),
        canEdit && h('span', { class: 'res-btns' },
          h('button', { class: 'btn ghost tiny', 'aria-label': `${s.key} minus 1`, onclick: () => act('stat:adjust', { id: c.id, index: i, delta: -1 }) }, '−'),
          h('button', { class: 'btn ghost tiny', 'aria-label': `${s.key} plus 1`, onclick: () => act('stat:adjust', { id: c.id, index: i, delta: 1 }) }, '+')));
    }));
  }

  function textStats(c) {
    const chips = c.stats.filter((s) => typeof s.max !== 'number');
    return chips.length ? h('div', { class: 'c-stats' }, chips.map((s) => h('span', { class: 'chip' }, h('b', {}, s.key), s.value))) : null;
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
      } else if (isScreen()) {
        // the table screen only displays
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
        resourceBars(c),
        textStats(c),
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
    if (isDm() || isScreen()) { panel.hidden = true; return; }
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
    if (isDm() || isScreen()) { panel.hidden = true; return; }
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

  /* ------------------------------------------------------------ */
  /* table display (tablet battle board)                           */
  /* ------------------------------------------------------------ */
  const isAlly = (c) => c.type !== 'enemy';
  const actsInRound = (c) => !c.hidden && !(c.type === 'enemy' && c.defeated);

  function sideLabel(c) {
    if (c.type === 'pc') return `Player · ${c.ownerName}`;
    if (c.type === 'companion') return `Friendly NPC · ${c.ownerName}`;
    return 'Enemy';
  }

  /** The creatures that act after the current one, wrapping into the next round. */
  function upNext(count) {
    const order = state.combatants.filter(actsInRound);
    if (!state.combat.active || order.length < 2) return [];
    const i = order.findIndex((c) => c.id === state.combat.turnId);
    const out = [];
    for (let k = 1; k <= Math.min(count, order.length - 1); k++) out.push(order[(Math.max(i, 0) + k) % order.length]);
    return out;
  }

  function dHp(c) {
    const pct = Math.max(0, Math.min(100, c.hpPct));
    return h('div', { class: 'c-hp' },
      h('div', { class: `hpbar ${hpClass(pct)}` }, h('div', { style: `width:${pct}%` })),
      h('span', { class: 'hptext' }, c.hp === null ? c.status : `${c.hp} / ${c.hpMax}`));
  }

  function dCard(c, tag) {
    return h('div', {
      class: ['d-card', isAlly(c) ? 'ally' : 'enemy', c.type, tag === 'now' && 'is-now', tag === 'next' && 'is-next', c.defeated && 'defeated'].filter(Boolean).join(' '),
    },
      h('div', { class: 'd-card-head' },
        h('span', { class: 'init' }, String(c.initiative)),
        h('div', { class: 'd-card-title' },
          h('div', { class: 'c-name' }, c.name),
          h('div', { class: 'c-sub' }, [sideLabel(c), c.cls, c.level && c.type !== 'enemy' ? `Lv ${c.level}` : ''].filter(Boolean).join(' · '))),
        tag === 'now' && h('span', { class: 'd-tag now' }, 'NOW'),
        tag === 'next' && h('span', { class: 'd-tag next' }, 'NEXT'),
        c.defeated && h('span', { class: 'd-tag' }, c.type === 'enemy' ? '💀' : '0 HP'),
        h('span', { class: 'c-ac', title: 'Armor Class' }, c.ac === null ? '?' : String(c.ac), h('small', {}, 'AC'))),
      dHp(c),
      resourceBars(c, { controls: false }));
  }

  let lastDisplaySeq = null;
  let screenQrFor = null;
  function renderDisplay() {
    const screen = isScreen();
    $('#display').hidden = !screen;
    $('#turn-banner').hidden = screen;
    document.querySelector('.layout').hidden = screen;
    if (!screen) return;

    const { combat } = state;
    const cur = combat.turnId ? byId(combat.turnId) : null;
    const next = upNext(3);
    const nextId = next[0] && next[0].id;
    $('#display').classList.toggle('idle', !combat.active);

    // NOW
    const now = $('#d-now');
    now.className = `d-now ${cur ? (isAlly(cur) ? 'ally' : 'enemy') : ''}`;
    if (cur) {
      now.replaceChildren(
        h('div', { class: 'd-round' }, `Round ${combat.round}`),
        h('div', { class: 'd-now-side' }, isAlly(cur) ? '🛡️ Ally’s turn' : '⚔️ Enemy’s turn'),
        h('div', { class: 'd-now-name' }, cur.name),
        h('div', { class: 'd-now-sub' }, [sideLabel(cur), cur.cls].filter(Boolean).join(' · ')),
        dHp(cur),
        resourceBars(cur, { controls: false }));
      if (combat.seq !== lastDisplaySeq) {
        lastDisplaySeq = combat.seq;
        now.classList.remove('pop');
        void now.offsetWidth;
        now.classList.add('pop');
      }
    } else {
      now.replaceChildren(
        h('div', { class: 'd-round' }, combat.active ? `Round ${combat.round}` : 'Out of combat'),
        h('div', { class: 'd-now-name' }, combat.active ? 'No one can act' : 'Waiting for the DM to start combat…'),
        h('div', { class: 'd-now-sub' }, 'Scan the QR code below to join from your phone.'));
    }

    // up next
    $('#d-next').replaceChildren(...(next.length ? next : []).map((c, i) => h('li', { class: isAlly(c) ? 'ally' : 'enemy' },
      h('span', { class: 'd-next-n' }, String(i + 1)),
      h('span', { class: 'd-next-name' }, c.name),
      h('span', { class: 'd-next-side' }, isAlly(c) ? '🛡️' : '⚔️'))));
    $('#d-next').closest('.d-next-box').hidden = next.length === 0;

    // initiative strip
    const strip = $('#d-strip');
    strip.replaceChildren(...state.combatants.map((c) => h('li', {
      class: ['chip-turn', isAlly(c) ? 'ally' : 'enemy', c.id === combat.turnId && 'is-now', c.id === nextId && 'is-next', c.defeated && 'defeated'].filter(Boolean).join(' '),
    }, h('b', {}, String(c.initiative)), c.name)));
    const curChip = strip.querySelector('.is-now');
    if (curChip) curChip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

    // allies / enemies
    const tagOf = (c) => (c.id === combat.turnId ? 'now' : c.id === nextId ? 'next' : null);
    const allies = state.combatants.filter(isAlly);
    const enemies = state.combatants.filter((c) => !isAlly(c));
    $('#d-allies').replaceChildren(...(allies.length ? allies.map((c) => dCard(c, tagOf(c))) : [h('p', { class: 'muted' }, 'No allies yet.')]));
    $('#d-enemies').replaceChildren(...(enemies.length ? enemies.map((c) => dCard(c, tagOf(c))) : [h('p', { class: 'muted' }, 'No enemies… yet.')]));
    $('#d-allies-count').textContent = allies.length ? `${allies.filter((c) => !c.defeated).length} standing` : '';
    $('#d-enemies-count').textContent = enemies.length ? `${enemies.filter((c) => !c.defeated).length} left` : '';

    // latest events
    $('#d-log').replaceChildren(...state.log.slice(-3).reverse().map((l) => h('li', {}, l.text)));

    // join block
    const link = inviteLink();
    if (screenQrFor !== link) {
      screenQrFor = link;
      $('#screen-qr').replaceChildren(qrSvg(link));
    }
    $('#screen-code').textContent = state.code;
    const hasDm = state.members.some((m) => m.role === 'dm');
    $('#screen-dmkey-box').hidden = hasDm || !state.dmKey;
    $('#screen-dmkey').textContent = state.dmKey || '';
  }
  $('#btn-reveal-key').addEventListener('click', () => {
    const k = $('#screen-dmkey');
    k.hidden = !k.hidden;
    $('#btn-reveal-key').textContent = k.hidden ? 'Show DM key' : 'Hide DM key';
  });

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

  const COLOR_LABELS = { blue: '🔵 Blue', purple: '🟣 Purple', yellow: '🟡 Yellow', orange: '🟠 Orange', teal: '🟢 Teal', pink: '🩷 Pink', gray: '⚪ Gray' };

  /** One custom stat in the editor. Filling in "Max" turns it into a bar. */
  function statRow(stat = {}) {
    const bar = typeof stat.max === 'number' || stat.bar;
    const color = h('select', { 'data-color': '', 'aria-label': 'Bar color' },
      h('option', { value: '' }, 'Auto color'),
      Object.entries(COLOR_LABELS).map(([v, label]) => h('option', { value: v, selected: stat.color === v }, label)));
    const refill = h('input', { type: 'checkbox', 'data-refill': '', checked: Boolean(stat.refill) });
    const maxInput = h('input', {
      type: 'number', inputmode: 'numeric', min: '1', max: '9999', placeholder: 'Max', 'aria-label': 'Max (makes it a bar)',
      value: stat.max ?? '', 'data-max': '',
    });
    const opts = h('div', { class: 'bar-opts' }, color, h('label', { class: 'toggle small' }, refill, h('span', {}, 'Refills every turn')));
    const sync = () => { opts.hidden = maxInput.value === ''; row.classList.toggle('is-bar', maxInput.value !== ''); };
    maxInput.addEventListener('input', sync);
    const row = h('div', { class: 'stat-row' },
      h('div', { class: 'stat-main' },
        h('input', { placeholder: bar ? 'Name (e.g. Mana)' : 'Name (e.g. Spell DC)', maxlength: '24', value: stat.key ?? '', 'data-k': '' }),
        h('input', { placeholder: bar ? 'Current' : 'Value', maxlength: '60', value: stat.value ?? '', 'data-v': '' }),
        maxInput,
        h('button', { type: 'button', class: 'btn ghost small', title: 'Remove stat', onclick: () => row.remove() }, '✕')),
      opts);
    sync();
    return row;
  }

  function addStat(stat) {
    const row = statRow(stat);
    $('#stats').append(row);
    row.querySelector('input').focus();
  }
  $('#btn-add-stat').addEventListener('click', () => addStat({}));
  $('#btn-add-bar').addEventListener('click', () => addStat({ bar: true }));
  $('#btn-add-mana').addEventListener('click', () => addStat({ key: 'Mana', max: 10, value: 10, color: 'blue' }));
  $('#btn-add-move').addEventListener('click', () => addStat({ key: 'Movement', max: 30, value: 30, color: 'yellow', refill: true }));

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
    $('#stats').replaceChildren(...((c && c.stats) || []).map((s) => statRow(s)));
    $('#btn-delete').hidden = !c;
    dlg.showModal();
    f.name.focus(); // no delayed focus: it could steal typing from another field
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
      max: r.querySelector('[data-max]').value,
      color: r.querySelector('[data-color]').value || undefined,
      refill: r.querySelector('[data-refill]').checked,
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

  resume();
})();
