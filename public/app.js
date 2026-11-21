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
  let lastRollSeq = null;
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
    /** The hosting device handed the room to this device: become the host. */
    async onHandover(room) {
      if (!session || session.host || !room || room.code !== session.code) return;
      const old = net;
      net = new P2PHost(callbacks, { clientId, onSave: saveHostedRoom });
      saveHostedRoom(room);
      session = { ...session, host: true };
      store.set('dnd.session', session);
      if (old) old.close();
      const res = await net.restore(room, session.name);
      if (res.ok) toast('📡 This device is now hosting the room.');
      else toast(res.error, true);
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
    promptedForPc = false;
    store.del('dnd.session');
    document.body.classList.remove('your-turn');
    document.title = 'D&D Turn Tracker';
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    $('#net-status').hidden = true;
    stopMusic();
    $('#music-dock').hidden = true;
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

  /* ---------- hosting: move the room to another device ---------- */
  function openHostDialog() {
    if (!state || !session || !session.host) return;
    const targets = state.members.filter((m) => m.online && m.id !== state.you.id && (m.role === 'screen' || m.role === 'dm'));
    $('#host-error').textContent = '';
    $('#host-targets').replaceChildren(...(targets.length
      ? targets.map((m) => h('button', { class: 'btn primary wide', onclick: () => moveHosting(m) },
        `📡 Move hosting to ${m.role === 'screen' ? '📺' : '👑'} ${m.name}`))
      : [h('p', { class: 'muted small' }, 'Open the tracker on the tablet and choose "Join as table display", then come back here to hand it the room.')]));
    $('#host-dialog').showModal();
  }
  $('#host-badge').addEventListener('click', openHostDialog);
  $('#btn-host-close').addEventListener('click', () => $('#host-dialog').close());

  async function moveHosting(member) {
    if (!net || net.kind !== 'host') return;
    if (!confirm(`Move the room to ${member.name}? This device will keep playing as before.`)) return;
    const res = await net.handover(member.id);
    if (!res.ok) { $('#host-error').textContent = res.error; return; }
    $('#host-dialog').close();
    // let go of the room and re-join it as a normal device
    const { code, name } = session;
    net.close();
    store.del('dnd.hostRoom');
    session = { ...session, host: false };
    store.set('dnd.session', session);
    callbacks.onStatus({ online: false, text: `Handing the room to ${member.name}…` });
    for (let attempt = 0; attempt < 30; attempt++) {
      const r = await joinRoom(code, name);
      if (r.ok) { toast(`📡 ${member.name} is now hosting.`); render(); return; }
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    callbacks.onStatus({ online: false, text: `Could not reach ${member.name}. Check that it is still open.` });
  }
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
  $('#btn-start').addEventListener('click', () => act('combat:start', { roll: true }));
  $('#btn-start-keep').addEventListener('click', () => act('combat:start', { roll: false }));
  $('#btn-skip-roll').addEventListener('click', () => {
    const r = state && state.combat.rollers[0];
    if (r && confirm(`Roll initiative automatically for ${r.name}?`)) act('initiative:skip');
  });
  $('#btn-roll-init').addEventListener('click', () => openInitiative(myRollIds(), { prompt: true }));
  $('#btn-end').addEventListener('click', () => {
    const rolling = state && state.combat.phase === 'rolling';
    if (confirm(rolling ? 'Cancel the initiative round?' : 'End combat? The turn order will reset.')) act('combat:end');
  });
  $('#btn-add-enemy').addEventListener('click', () => openEditor('enemy'));
  $('#btn-add-boss').addEventListener('click', () => openEditor('enemy', null, { boss: true }));
  $('#btn-add-lair').addEventListener('click', () => act('combatant:save', { combatant: { type: 'enemy', name: 'Lair actions', initiative: 20, hpMax: 1, lair: true } }));
  $('#set-reveal').addEventListener('change', (e) => act('settings:update', { revealEnemies: e.target.checked }));

  /* ------------------------------------------------------------ */
  /* rendering                                                     */
  /* ------------------------------------------------------------ */
  const isDm = () => state && state.you.role === 'dm';
  const isScreen = () => state && state.you.role === 'screen';
  const byId = (id) => state && state.combatants.find((c) => c.id === id);
  const fmtInit = (n) => (n === null || n === undefined ? '?' : String(n));

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
    renderBossBar($('#boss-bar'), { big: false });
    renderMap();
    renderMusic();
    renderConditionsDialog();
    renderMembers();
    renderLog();

    if (!dm && !screen && !promptedForPc && !state.combatants.some((c) => c.mine && c.type === 'pc')) {
      promptedForPc = true;
      // saved characters? offer them first, otherwise start a new one
      if (loadParties().length) openParties();
      else openEditor('pc');
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

    const rolling = combat.phase === 'rolling';
    if (rolling) {
      const [first, ...rest] = combat.rollers;
      $('#turn-round').textContent = '🎲 Rolling initiative';
      $('#turn-name').textContent = state.yourRoll
        ? 'Your turn to enter initiative!'
        : first ? `Waiting for ${first.role === 'dm' ? 'the DM' : first.name}…${rest.length ? ` (then ${rest.map((r) => r.name).join(', ')})` : ''}` : 'Starting…';
    } else if (!combat.active) {
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

    $('#btn-start').hidden = !dm || combat.active || rolling;
    $('#btn-start-keep').hidden = !dm || combat.active || rolling || !state.combatants.some((c) => c.initiative !== null && !c.lair);
    $('#btn-end').hidden = !dm || !(combat.active || rolling);
    $('#btn-end').textContent = rolling ? 'Cancel' : 'End combat';
    $('#btn-roll-init').hidden = !(rolling && state.yourRoll);
    $('#btn-skip-roll').hidden = !(dm && rolling && !state.yourRoll && combat.rollers.length);

    // initiative round: prompt this device when it's its turn to enter numbers
    if (rolling && state.yourRoll && combat.seq !== lastRollSeq) {
      lastRollSeq = combat.seq;
      turnAlert();
      openInitiative(myRollIds(), { prompt: true });
    }
    if (!rolling || !state.yourRoll) {
      lastRollSeq = null;
      if (initDlg.open && initPrompt) initDlg.close();
    }
    $('#btn-prev').hidden = !dm || !combat.active;
    $('#btn-next').hidden = !combat.active || !(dm || state.yourTurn);
    $('#btn-next').textContent = state.yourTurn ? 'End my turn ▶' : 'Next turn ▶';
  }

  function hpClass(pct) {
    return pct <= 25 ? 'low' : pct <= 50 ? 'mid' : '';
  }

  function initTitle(c) {
    if (c.lair) return 'Lair actions: initiative 20';
    if (!c.needsRoll) return `Acts right after ${c.leaderName || 'its leader'}`;
    if (c.initiative === null) return 'Initiative not rolled yet';
    const b = c.initBonus || 0;
    return c.initRoll !== null && c.initRoll !== undefined ? `Roll ${c.initRoll} ${b < 0 ? '−' : '+'} ${Math.abs(b)} = ${c.initiative}` : `Initiative ${c.initiative}`;
  }

  /* ---------- initiative dialog ---------- */
  const initDlg = $('#init-dialog');
  let initPrompt = false;

  /** My creatures that roll initiative (the DM rolls for every enemy). */
  function myRollIds() {
    return state.combatants.filter((c) => c.mine && c.needsRoll && (isDm() ? c.type === 'enemy' : true)).map((c) => c.id);
  }

  function openInitiative(ids, { prompt = false } = {}) {
    if (!ids.length) return;
    initPrompt = prompt;
    $('#init-title').textContent = prompt ? '🎲 Roll for initiative!' : '🎲 Initiative';
    $('#init-error').textContent = '';
    $('#init-rows').replaceChildren(...ids.map((id) => {
      const c = byId(id);
      if (!c) return null;
      const bonus = c.initBonus || 0;
      const total = h('span', { class: 'init-total' }, '');
      const input = h('input', { type: 'number', inputmode: 'numeric', placeholder: 'd20', 'data-id': c.id, value: c.initRoll ?? '', 'aria-label': `d20 roll for ${c.name}` });
      const show = () => { total.textContent = input.value === '' ? '' : `= ${Number(input.value) + bonus}`; };
      input.addEventListener('input', show);
      show();
      return h('div', { class: 'init-row' },
        h('span', { class: 'init-name' }, c.name, h('small', { class: 'muted' }, ` ${bonus < 0 ? '−' : '+'}${Math.abs(bonus)}`)),
        input,
        h('button', { type: 'button', class: 'btn ghost small', title: 'Roll a d20', onclick: () => { input.value = 1 + Math.floor(Math.random() * 20); show(); } }, '🎲'),
        total);
    }).filter(Boolean));
    if (!initDlg.open) initDlg.showModal();
    const first = initDlg.querySelector('input[data-id]');
    if (first) first.focus();
  }
  $('#btn-init-cancel').addEventListener('click', () => initDlg.close());
  $('#btn-init-auto').addEventListener('click', () => {
    for (const input of initDlg.querySelectorAll('input[data-id]')) {
      if (input.value === '') { input.value = 1 + Math.floor(Math.random() * 20); input.dispatchEvent(new Event('input')); }
    }
  });
  $('#init-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputs = [...initDlg.querySelectorAll('input[data-id]')];
    const missing = inputs.find((i) => i.value === '');
    if (missing) { $('#init-error').textContent = 'Enter a roll for everyone (or use 🎲 Roll for me).'; missing.focus(); return; }
    const res = await emit('initiative:set', { rolls: inputs.map((i) => ({ id: i.dataset.id, roll: i.value })) });
    if (!res.ok) { $('#init-error').textContent = res.error; return; }
    initDlg.close();
  });

  /* ---------- conditions: bar colors + chips ---------- */
  const MAGIC_RE = /mana|spell|slot|magic|\bki\b|sorcery|arcan/i;
  const MOVE_RE = /move|movement|speed|feet|\bft\b/i;

  /** Color a condition paints on a bar ('hp' or a bar stat), latest condition wins. */
  function tintFor(c, target) {
    let color = null;
    for (const k of c.conditions || []) {
      if (!k.color || !k.bar) continue;
      let hit = k.bar === 'all';
      if (target === 'hp') hit = hit || k.bar === 'hp';
      else {
        hit = hit
          || (k.bar === 'mana' && MAGIC_RE.test(target.key))
          || (k.bar === 'move' && MOVE_RE.test(target.key))
          || (k.bar.startsWith('stat:') && k.bar.slice(5).toLowerCase() === target.key.toLowerCase());
      }
      if (hit) color = k.color;
    }
    return color;
  }

  function barFill(pct, tint) {
    return h('div', { class: tint ? `tinted tint-${tint}` : null, style: `width:${pct}%` });
  }

  function condText(k) {
    return `${k.emoji} ${k.name}${k.level ? ` ${k.level}` : ''}`;
  }

  /** Condition chips; tapping them opens the effects dialog. */
  function conditionChips(c, { compact = false } = {}) {
    const list = c.conditions || [];
    if (!list.length) return null;
    const open = isScreen() ? null : () => openConditions(c.id);
    return h('div', { class: `c-conds${compact ? ' compact' : ''}` }, list.map((k) => h(open ? 'button' : 'span', {
      class: `cond cond-${k.kind}${k.secret ? ' cond-secret' : ''}`,
      title: `${k.name}${k.rounds ? ` – ${k.rounds} round(s) left` : ''}${k.secret ? ' (secret)' : ''}`,
      onclick: open,
      type: open ? 'button' : null,
    }, compact ? `${k.emoji}${k.level ? k.level : ''}` : condText(k),
    !compact && k.rounds ? h('small', {}, ` ⏳${k.rounds}`) : null,
    !compact && k.secret ? h('small', {}, ' 🤫') : null)));
  }

  function hpRow(c) {
    if (c.lair) return h('div', { class: 'c-hp lair-row muted small' }, '🏰 Lair actions happen on initiative 20 (losing ties).');
    const pct = Math.max(0, Math.min(100, c.hpPct));
    const text = c.hp === null ? c.status : `${c.hp} / ${c.hpMax}`;
    return h('div', { class: 'c-hp' },
      h('div', { class: `hpbar ${hpClass(pct)}`, title: c.status }, barFill(pct, tintFor(c, 'hp'))),
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
        h('div', { class: 'resbar', title: s.refill ? 'Refills at the start of each turn' : '' }, barFill(pct, tintFor(c, s))),
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
    const input = h('input', { type: 'number', min: '1', inputmode: 'numeric', placeholder: 'HP', 'aria-label': `Amount for ${c.name}`, 'data-hp-for': c.id });
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
    // keep half-typed HP amounts (and the focus) when another device's update redraws the list
    const typed = new Map([...list.querySelectorAll('input[data-hp-for]')].filter((i) => i.value !== '').map((i) => [i.dataset.hpFor, i.value]));
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.hpFor : null;
    list.replaceChildren();
    const items = state.combatants;
    $('#order-empty').hidden = items.length > 0;
    const active = items.filter((c) => !c.hidden && !(c.type === 'enemy' && c.defeated)).length;
    $('#order-count').textContent = items.length ? `${active} in the fight` : '';

    for (const c of items) {
      const isCur = c.id === state.combat.turnId;
      const typeLabel = c.lair ? 'Lair' : c.type === 'pc' ? 'Player' : c.type === 'companion' ? 'Friendly NPC' : 'Enemy';
      const sub = [];
      if (c.type !== 'enemy') {
        if (c.cls) sub.push(c.cls);
        if (c.level) sub.push(`Lv ${c.level}`);
        sub.push(c.mine && !dm ? 'you' : c.ownerName);
      } else if (c.leaderName) {
        sub.push(`🔗 serves ${c.leaderName}${c.followLeader ? ' · acts right after' : ''}`);
      }

      const actions = [];
      if (c.mine && c.lair) {
        actions.push(h('button', { class: 'btn ghost small', onclick: () => openEditor(c.type, c) }, '✏️ Edit'));
      } else if (c.mine) {
        actions.push(...quickHp(c, { allowDamage: true, allowHeal: true }));
        actions.push(h('button', { class: 'btn ghost small', onclick: () => openEditor(c.type, c) }, '✏️ Edit'));
      } else if (isScreen()) {
        // the table screen only displays
      } else if (!dm && c.type === 'enemy' && !c.defeated) {
        actions.push(h('button', { class: 'btn danger small', onclick: () => focusDamage(c.id) }, '🗡️ Attack'));
      } else if (!dm && c.type !== 'enemy') {
        actions.push(...quickHp(c, { allowDamage: false, allowHeal: true }));
      }
      if (!isScreen() && !c.lair) {
        actions.push(h('button', { class: 'btn ghost small', title: 'Buffs, debuffs and conditions', onclick: () => openConditions(c.id) }, '✨ Effects'));
      }
      if (dm && c.type === 'enemy' && !c.lair && !c.defeated) {
        actions.push(h('button', { class: 'btn ghost small', title: 'Add creatures summoned by / serving this one', onclick: () => openEditor('enemy', null, { leader: c.id, followLeader: true, name: '' }) }, '➕ Summon'));
      }
      if (dm && state.combat.active && !isCur && !c.hidden) {
        actions.push(h('button', { class: 'btn ghost small', title: 'Make it this creature\'s turn', onclick: () => act('turn:set', { id: c.id }) }, '▶ Give turn'));
      }

      const card = h('li', {
        class: ['card', c.type, isCur && 'current', c.defeated && 'defeated', c.hidden && 'is-hidden', c.mine && !dm && 'mine', c.boss && 'boss', c.lair && 'lair', c.leader && 'summon'].filter(Boolean).join(' '),
        'data-id': c.id,
      },
        c.mine && c.needsRoll && !isScreen()
          ? h('button', { class: `init init-btn${c.initiative === null ? ' unrolled' : ''}`, title: initTitle(c), 'aria-label': `Initiative for ${c.name}`, onclick: () => openInitiative([c.id]) }, fmtInit(c.initiative))
          : h('div', { class: `init${c.initiative === null ? ' unrolled' : ''}`, title: initTitle(c) }, fmtInit(c.initiative)),
        h('div', { class: 'c-main' },
          h('div', { class: 'c-title' },
            h('span', { class: 'c-name' }, c.lair ? `🏰 ${c.name}` : c.name),
            c.boss ? h('span', { class: 'badge boss-b' }, '👑 Boss') : h('span', { class: `badge ${c.type}` }, typeLabel),
            c.hidden && h('span', { class: 'badge hidden-b' }, 'Hidden'),
            c.defeated && h('span', { class: 'badge' }, c.type === 'enemy' ? '💀 Defeated' : '0 HP')),
          sub.length ? h('div', { class: 'c-sub' }, sub.join(' · ')) : null),
        c.lair ? h('span', {}) : h('div', { class: 'c-ac', title: 'Armor Class' }, c.ac === null ? '?' : String(c.ac), h('small', {}, 'AC')),
        conditionChips(c) ? h('div', { class: 'c-conds-row' }, conditionChips(c)) : null,
        hpRow(c),
        resourceBars(c),
        textStats(c),
        actions.length ? h('div', { class: 'c-actions' }, actions) : null);
      list.append(card);
    }

    for (const input of list.querySelectorAll('input[data-hp-for]')) {
      if (typed.has(input.dataset.hpFor)) input.value = typed.get(input.dataset.hpFor);
      if (focused && input.dataset.hpFor === focused) input.focus({ preventScroll: true });
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
    const comps = state.combatants.filter((c) => c.mine && c.type === 'companion');
    $('#my-pc').replaceChildren(miniCard(pc, 'No character yet.', 'Create character', 'pc'));
    $('#my-companion').replaceChildren(
      ...comps.map((c) => miniCard(c, '', '', 'companion')),
      comps.length < MAX_COMPANIONS
        ? miniCard(null, `Friendly NPCs: ${comps.length}/${MAX_COMPANIONS}`, '+ Add NPC', 'companion')
        : h('p', { class: 'muted small' }, `Friendly NPCs: ${MAX_COMPANIONS}/${MAX_COMPANIONS} (the most you can have)`));
    $('#btn-party-save').disabled = !pc;
  }

  /* ---------- saved characters ("preloads") ---------- */
  const MAX_COMPANIONS = 3;
  const PARTY_KEY = 'dnd.myParties';
  const partyDlg = $('#party-dialog');

  function loadParties() {
    const v = store.get(PARTY_KEY, []);
    return Array.isArray(v) ? v.filter((p) => p && p.pc && typeof p.pc.name === 'string') : [];
  }
  function saveParties(list) {
    store.set(PARTY_KEY, list.slice(0, 200));
  }

  /** What gets saved of a creature: its sheet, not its current HP or effects. */
  function snapshot(c) {
    return {
      name: c.name, cls: c.cls || '', level: c.level ?? 1, hpMax: c.hpMax, ac: c.ac, initBonus: c.initBonus || 0,
      stats: (c.stats || []).map((st) => (typeof st.max === 'number' ? { key: st.key, max: st.max, value: st.max, color: st.color, refill: st.refill } : { key: st.key, value: st.value })),
    };
  }

  $('#btn-party-save').addEventListener('click', () => {
    const pc = state.combatants.find((c) => c.mine && c.type === 'pc');
    if (!pc) return;
    const preset = {
      pc: snapshot(pc),
      companions: state.combatants.filter((c) => c.mine && c.type === 'companion').map(snapshot),
      savedAt: Date.now(),
    };
    saveParties([...loadParties().filter((p) => p.pc.name.toLowerCase() !== pc.name.toLowerCase()), preset]);
    toast(`💾 ${pc.name}${preset.companions.length ? ` and ${preset.companions.length} NPC(s)` : ''} saved on this device.`);
  });

  /** Bring a saved party into this room: update what you already have, add the rest (full HP). */
  async function useParty(preset) {
    const mine = state.combatants.filter((c) => c.mine);
    const pc = mine.find((c) => c.type === 'pc');
    const save = (type, t, existing) => emit('combatant:save', {
      combatant: { ...t, id: existing ? existing.id : undefined, type, hp: t.hpMax, stats: t.stats },
    });
    let res = await save('pc', preset.pc, pc);
    if (!res.ok) { toast(res.error, true); return; }
    let skipped = 0;
    const comps = mine.filter((c) => c.type === 'companion');
    let count = comps.length;
    for (const t of preset.companions || []) {
      const same = comps.find((c) => c.name.toLowerCase() === String(t.name).toLowerCase());
      if (!same && count >= MAX_COMPANIONS) { skipped++; continue; }
      res = await save('companion', t, same);
      if (res.ok && !same) count++;
      if (!res.ok) skipped++;
    }
    partyDlg.close();
    toast(`📂 ${preset.pc.name} is ready${skipped ? ` (${skipped} NPC(s) skipped: max ${MAX_COMPANIONS})` : ''}.`);
  }

  function renderParties() {
    const list = loadParties().sort((a, b) => b.savedAt - a.savedAt);
    $('#party-list').replaceChildren(...(list.length ? list.map((p) => h('div', { class: 'lib-row mine' },
      h('div', { class: 'lib-main' },
        h('div', { class: 'lib-name' }, p.pc.name),
        h('div', { class: 'muted small' }, [p.pc.cls, p.pc.level ? `Lv ${p.pc.level}` : '', `HP ${p.pc.hpMax}`, `AC ${p.pc.ac}`].filter(Boolean).join(' · ')
          + (p.companions && p.companions.length ? ` · with ${p.companions.map((c) => c.name).join(', ')}` : ''))),
      h('button', { class: 'btn ghost tiny', title: `Delete ${p.pc.name}`, onclick: () => {
        if (!confirm(`Delete the saved ${p.pc.name}?`)) return;
        saveParties(loadParties().filter((x) => x.pc.name !== p.pc.name));
        renderParties();
      } }, '🗑'),
      h('button', { class: 'btn primary small', onclick: () => useParty(p) }, 'Use'))) : [h('p', { class: 'muted small' }, 'Nothing saved yet. Create your character, then tap 💾 Save party.')]));
  }
  function openParties() {
    renderParties();
    if (!partyDlg.open) partyDlg.showModal();
  }
  $('#btn-party-open').addEventListener('click', openParties);
  $('#btn-party-close').addEventListener('click', () => partyDlg.close());
  $('#btn-party-new').addEventListener('click', () => { partyDlg.close(); openEditor('pc'); });
  $('#btn-party-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ type: 'dnd-turn-tracker-characters', parties: loadParties() }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'my-characters.json' });
    document.body.append(a);
    a.click();
    a.remove();
  });
  $('#party-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data.parties || []).filter((p) => p && p.pc && typeof p.pc.name === 'string');
      const byName = new Map(loadParties().map((p) => [p.pc.name.toLowerCase(), p]));
      for (const p of incoming) byName.set(p.pc.name.toLowerCase(), { savedAt: Date.now(), companions: [], ...p });
      saveParties([...byName.values()]);
      toast(`Imported ${incoming.length} character(s).`);
      renderParties();
    } catch {
      toast('That file is not a character list.', true);
    }
  });

  /* ---------- DM music (YouTube / Spotify), local to the DM's device ---------- */
  const MUSIC_KEY = 'dnd.music';
  const music = Object.assign({ saved: [], current: '' }, store.get(MUSIC_KEY, {}));
  let musicShown = null;

  /** Turn a YouTube or Spotify link into its embeddable player URL (null if not recognised). */
  function musicEmbed(link) {
    let u;
    const spUri = String(link).trim().match(/^spotify:(playlist|album|track|artist|episode|show):([A-Za-z0-9]+)$/);
    if (spUri) return { kind: 'spotify', src: `https://open.spotify.com/embed/${spUri[1]}/${spUri[2]}`, height: 152 };
    try { u = new URL(String(link).trim()); } catch { return null; }
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'open.spotify.com') {
      const m = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track|artist|episode|show)\/([A-Za-z0-9]+)/);
      return m ? { kind: 'spotify', src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, height: 152 } : null;
    }
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
      const list = u.searchParams.get('list');
      let id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
      const path = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/);
      if (!id && path) id = path[1];
      if (id && !/^[\w-]{6,}$/.test(id)) id = null;
      if (list && !/^[\w-]+$/.test(list)) return null;
      const base = 'https://www.youtube-nocookie.com/embed/';
      if (id) return { kind: 'youtube', src: `${base}${id}?rel=0&loop=1&${list ? `list=${list}` : `playlist=${id}`}`, height: 180 };
      if (list) return { kind: 'youtube', src: `${base}videoseries?rel=0&loop=1&list=${list}`, height: 180 };
    }
    return null;
  }

  function showMusic(link) {
    const e = link ? musicEmbed(link) : null;
    musicShown = e ? link : null;
    $('#music-player').replaceChildren(e
      ? h('iframe', {
        src: e.src, height: String(e.height), title: 'Music player', loading: 'eager', referrerpolicy: 'strict-origin-when-cross-origin',
        allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
      })
      : h('p', { class: 'muted small' }, 'Paste a YouTube or Spotify link below.'));
    renderMusicSaved();
  }
  function stopMusic() {
    if (musicShown) showMusic(null);
  }
  function persistMusic() {
    store.set(MUSIC_KEY, music);
  }
  function renderMusicSaved() {
    $('#music-saved').replaceChildren(...music.saved.map((m) => h('span', { class: `music-chip${m.url === musicShown ? ' playing' : ''}` },
      h('button', { type: 'button', title: m.url, onclick: () => { music.current = m.url; persistMusic(); showMusic(m.url); } }, `▶ ${m.name}`),
      h('button', { type: 'button', 'aria-label': `Remove ${m.name}`, onclick: () => {
        music.saved = music.saved.filter((x) => x !== m);
        persistMusic();
        renderMusicSaved();
      } }, '✕'))));
  }
  function readMusicForm() {
    const url = $('#music-url').value.trim();
    if (!musicEmbed(url)) { toast('Paste a YouTube or Spotify link (video, playlist, album…).', true); return null; }
    return { url, name: $('#music-name').value.trim() || (url.includes('spotify') ? 'Spotify' : 'YouTube') };
  }
  $('#music-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = readMusicForm();
    if (!m) return;
    music.current = m.url;
    persistMusic();
    showMusic(m.url);
  });
  $('#btn-music-save').addEventListener('click', () => {
    const m = readMusicForm();
    if (!m) return;
    music.saved = [...music.saved.filter((x) => x.url !== m.url), m].slice(-30);
    persistMusic();
    $('#music-url').value = '';
    $('#music-name').value = '';
    renderMusicSaved();
    toast(`💾 "${m.name}" saved.`);
  });
  $('#btn-music-toggle').addEventListener('click', () => {
    const dock = $('#music-dock');
    const open = dock.classList.toggle('collapsed') === false;
    $('#btn-music-toggle').setAttribute('aria-expanded', String(open));
    $('#btn-music-toggle').textContent = open ? '🎵 Hide' : musicShown ? '🎵 Music ♪' : '🎵 Music';
    if (open && musicShown === null && music.current) showMusic(music.current);
  });
  renderMusicSaved();

  function renderMusic() {
    const dm = isDm();
    $('#music-dock').hidden = !dm;
    if (!dm) stopMusic();
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
    const enemies = state.combatants.filter((c) => c.type === 'enemy' && !c.defeated && !c.lair);
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
  /* shared map + pen                                              */
  /* ------------------------------------------------------------ */
  const PEN_COLORS = { red: '#ff4d4d', yellow: '#ffd84d', white: '#ffffff', cyan: '#3fe0e8', green: '#3fd16b', black: '#111111' };

  /** A 16:9 map box (website or image) with a drawing layer on top. */
  function createMapView() {
    let pen = false;
    let color = 'red';
    let width = 2;
    let current = null; // stroke being drawn
    let pending = []; // drawn here, not yet confirmed by the host
    let map = { url: '', kind: 'page', strokes: [] };
    let canDraw = false;
    let shownUrl = null;

    const frame = h('div', { class: 'map-frame' });
    const canvas = h('canvas', { class: 'map-ink' });
    const stage = h('div', { class: 'map-stage' }, frame, canvas);
    const penBtn = h('button', { type: 'button', class: 'btn ghost small', title: 'Draw on the map' }, '✏️ Pen');
    const colorBtns = Object.keys(PEN_COLORS).map((c) => h('button', {
      type: 'button', class: `pen-color${c === color ? ' active' : ''}`, style: `background:${PEN_COLORS[c]}`, title: c, 'aria-label': `${c} pen`,
      onclick: () => { color = c; colorBtns.forEach((b) => b.classList.toggle('active', b.title === c)); },
    }));
    const widthSel = h('select', { 'aria-label': 'Pen size', onchange: (e) => { width = Number(e.target.value); } },
      h('option', { value: '1' }, 'Thin'), h('option', { value: '2', selected: true }, 'Medium'), h('option', { value: '3' }, 'Thick'));
    const drawTools = h('span', { class: 'map-draw-tools' }, penBtn, ...colorBtns, widthSel,
      h('button', { type: 'button', class: 'btn ghost small', title: 'Undo last line', onclick: () => act('map:undo') }, '↶'),
      h('button', { type: 'button', class: 'btn ghost small', title: 'Clear all drawings', onclick: () => { if (confirm('Clear all drawings?')) act('map:clear'); } }, '🗑'));
    const fsBtn = h('button', { type: 'button', class: 'btn ghost small', title: 'Full screen' }, '⛶ Full screen');
    const tools = h('div', { class: 'map-tools' }, fsBtn, drawTools);
    const note = h('p', { class: 'muted tiny-text map-note' }, 'Blank box? That website doesn\'t allow being shown inside other pages – use a direct image link or the site\'s "embed" link.');
    const wrap = h('div', { class: 'map-wrap' }, stage, tools, note);

    penBtn.addEventListener('click', () => {
      pen = !pen;
      penBtn.classList.toggle('active', pen);
      canvas.classList.toggle('drawing', pen);
    });
    fsBtn.addEventListener('click', () => {
      const doc = document;
      if (doc.fullscreenElement || doc.webkitFullscreenElement) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
      if (wrap.classList.contains('pseudo-fs')) { wrap.classList.remove('pseudo-fs'); redraw(); return; }
      const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
      if (req) req.call(wrap).catch(() => { wrap.classList.add('pseudo-fs'); redraw(); });
      else { wrap.classList.add('pseudo-fs'); redraw(); } // e.g. iPhone Safari
    });

    function point(e) {
      const r = canvas.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (!pen || !canDraw) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      current = { color, width, points: [point(e)] };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      const p = point(e);
      const last = current.points[current.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.004 && current.points.length < 400) {
        current.points.push(p);
        redraw();
      }
    });
    const finish = () => {
      if (!current) return;
      const stroke = current;
      current = null;
      pending.push(stroke);
      redraw();
      act('map:stroke', stroke).then(() => { pending = pending.filter((x) => x !== stroke); redraw(); });
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    function drawStroke(ctx, st, w, hgt) {
      ctx.strokeStyle = PEN_COLORS[st.color] || PEN_COLORS.red;
      ctx.lineWidth = Math.max(1.5, (w / 400) * [0, 1.2, 2.4, 4.5][st.width || 2]);
      ctx.beginPath();
      st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * hgt) : ctx.moveTo(x * w, y * hgt)));
      if (st.points.length === 1) ctx.lineTo(st.points[0][0] * w + 0.1, st.points[0][1] * hgt);
      ctx.stroke();
    }
    function redraw() {
      const r = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (!r.width) return;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 2;
      for (const st of [...map.strokes, ...pending, ...(current ? [current] : [])]) drawStroke(ctx, st, r.width, r.height);
    }
    new ResizeObserver(() => redraw()).observe(stage);
    document.addEventListener('fullscreenchange', () => setTimeout(redraw, 50));

    function update(next, opts) {
      map = next;
      canDraw = opts.canDraw;
      drawTools.hidden = !canDraw;
      if (!canDraw && pen) penBtn.click();
      if (shownUrl !== `${map.kind}|${map.url}`) {
        shownUrl = `${map.kind}|${map.url}`;
        frame.replaceChildren(map.kind === 'image'
          ? h('img', { src: map.url, alt: 'Map', referrerpolicy: 'no-referrer' })
          : h('iframe', { src: map.url, title: 'Map', referrerpolicy: 'no-referrer', allow: 'fullscreen', loading: 'lazy' }));
      }
      note.hidden = map.kind === 'image';
      redraw();
    }
    return { el: wrap, update };
  }

  const panelMap = createMapView();
  const displayMap = createMapView();
  $('#map-panel-view').append(panelMap.el);
  $('#d-map').append(displayMap.el);

  function renderMap() {
    const dm = isDm();
    const m = state.map || { url: '', strokes: [] };
    const fighting = state.combat.active || state.combat.phase === 'rolling';
    // DM: always (to set it up and draw); players: while not fighting; the display uses its own big box
    const showPanel = !isScreen() && (dm || (m.url && !fighting));
    $('#map-panel').hidden = !showPanel;
    $('#map-form').hidden = !dm;
    $('#map-hint').hidden = !dm;
    $('#map-panel-view').hidden = !m.url;
    if (showPanel && m.url) panelMap.update(m, { canDraw: state.canMap });
    if (dm && document.activeElement !== $('#map-url')) $('#map-url').value = m.url || '';
    const showDisplay = isScreen() && m.url && !fighting;
    $('#d-map').hidden = !showDisplay;
    if (showDisplay) displayMap.update(m, { canDraw: state.canMap });
  }

  $('#map-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#map-url').value.trim();
    if (!url) return;
    act('map:set', { url, kind: $('#map-kind').value || undefined });
  });
  $('#btn-map-remove').addEventListener('click', () => { if (confirm('Remove the map (and its drawings)?')) act('map:set', { url: '' }); });

  /* ------------------------------------------------------------ */
  /* table display (tablet battle board)                           */
  /* ------------------------------------------------------------ */
  const isAlly = (c) => c.type !== 'enemy';
  const actsInRound = (c) => !c.hidden && !(c.type === 'enemy' && c.defeated);

  function sideLabel(c) {
    if (c.lair) return 'Lair actions';
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
    if (c.lair) return h('div', { class: 'c-hp lair-row muted small' }, 'Initiative 20 · loses ties');
    const pct = Math.max(0, Math.min(100, c.hpPct));
    return h('div', { class: 'c-hp' },
      h('div', { class: `hpbar ${hpClass(pct)}` }, barFill(pct, tintFor(c, 'hp'))),
      h('span', { class: 'hptext' }, c.hp === null ? c.status : `${c.hp} / ${c.hpMax}`));
  }

  /** Boss bar: every boss, always at the top of the screen. */
  function renderBossBar(el, { big }) {
    const bosses = state.combatants.filter((c) => c.boss && !c.lair);
    el.hidden = bosses.length === 0;
    if (!bosses.length) { el.replaceChildren(); return; }
    el.replaceChildren(...bosses.map((b) => {
      const pct = Math.max(0, Math.min(100, b.hpPct));
      const minions = state.combatants.filter((x) => x.leader === b.id && !x.defeated).length;
      return h('div', { class: ['boss', b.defeated && 'defeated', b.id === state.combat.turnId && 'is-now', big && 'big'].filter(Boolean).join(' ') },
        h('div', { class: 'boss-head' },
          h('span', { class: 'boss-name' }, `👑 ${b.name}`),
          conditionChips(b, { compact: true }),
          minions ? h('span', { class: 'boss-minions', title: 'Summons still standing' }, `🔗 ${minions}`) : null,
          b.id === state.combat.turnId ? h('span', { class: 'd-tag now' }, 'NOW') : null,
          h('span', { class: 'boss-hp' }, b.defeated ? '💀 Defeated' : b.hp === null ? b.status : `${b.hp} / ${b.hpMax}`)),
        h('div', { class: `hpbar boss-track ${hpClass(pct)}` }, barFill(pct, tintFor(b, 'hp'))));
    }));
  }

  function dCard(c, tag) {
    return h('div', {
      class: ['d-card', isAlly(c) ? 'ally' : 'enemy', c.type, tag === 'now' && 'is-now', tag === 'next' && 'is-next', c.defeated && 'defeated', c.boss && 'boss', c.lair && 'lair', c.leader && 'summon'].filter(Boolean).join(' '),
    },
      h('div', { class: 'd-card-head' },
        h('span', { class: 'init' }, fmtInit(c.initiative)),
        h('div', { class: 'd-card-title' },
          h('div', { class: 'c-name' }, `${c.boss ? '👑 ' : c.lair ? '🏰 ' : ''}${c.name}`),
          h('div', { class: 'c-sub' }, [sideLabel(c), c.leaderName ? `🔗 ${c.leaderName}` : '', c.cls, c.level && c.type !== 'enemy' ? `Lv ${c.level}` : ''].filter(Boolean).join(' · '))),
        tag === 'now' && h('span', { class: 'd-tag now' }, 'NOW'),
        tag === 'next' && h('span', { class: 'd-tag next' }, 'NEXT'),
        c.defeated && h('span', { class: 'd-tag' }, c.type === 'enemy' ? '💀' : '0 HP'),
        c.lair ? null : h('span', { class: 'c-ac', title: 'Armor Class' }, c.ac === null ? '?' : String(c.ac), h('small', {}, 'AC'))),
      conditionChips(c),
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
    $('#display').classList.toggle('idle', !combat.active && combat.phase !== 'rolling');

    // NOW
    const now = $('#d-now');
    now.className = `d-now ${cur ? (isAlly(cur) ? 'ally' : 'enemy') : ''}`;
    if (cur) {
      now.replaceChildren(...[
        h('div', { class: 'd-round' }, `Round ${combat.round}`),
        h('div', { class: 'd-now-side' }, cur.lair ? '🏰 Lair turn' : isAlly(cur) ? '🛡️ Ally’s turn' : '⚔️ Enemy’s turn'),
        h('div', { class: 'd-now-name' }, `${cur.boss ? '👑 ' : cur.lair ? '🏰 ' : ''}${cur.name}`),
        h('div', { class: 'd-now-sub' }, [sideLabel(cur), cur.leaderName ? `🔗 serves ${cur.leaderName}` : '', cur.cls].filter(Boolean).join(' · ')),
        conditionChips(cur),
        dHp(cur),
        resourceBars(cur, { controls: false }),
      ].filter(Boolean)); // replaceChildren would print null as text
      if (combat.seq !== lastDisplaySeq) {
        lastDisplaySeq = combat.seq;
        now.classList.remove('pop');
        void now.offsetWidth;
        now.classList.add('pop');
      }
    } else if (combat.phase === 'rolling') {
      const [first, ...rest] = combat.rollers;
      now.className = 'd-now rolling';
      now.replaceChildren(...[
        h('div', { class: 'd-round' }, '🎲 Roll for initiative!'),
        h('div', { class: 'd-now-name' }, first ? `${first.role === 'dm' ? '👑 The DM' : first.name} is rolling…` : 'Starting…'),
        rest.length ? h('div', { class: 'd-now-sub' }, `Then: ${rest.map((r) => r.name).join(' → ')}`) : null,
        h('div', { class: 'd-now-sub' }, 'Roll a d20 – the app adds your bonus. The fight starts when everyone has entered their number.'),
      ].filter(Boolean));
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
    }, h('b', {}, fmtInit(c.initiative)), `${c.boss ? '👑 ' : c.lair ? '🏰 ' : ''}${c.name}`, (c.conditions || []).length ? h('span', { class: 'chip-conds' }, c.conditions.map((k) => k.emoji).join('')) : null)));
    const curChip = strip.querySelector('.is-now');
    if (curChip) curChip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });

    // allies / enemies
    const tagOf = (c) => (c.id === combat.turnId ? 'now' : c.id === nextId ? 'next' : null);
    const allies = state.combatants.filter(isAlly);
    // enemies: bosses first, each leader followed by its summons (indented), lair last
    const enemyList = state.combatants.filter((c) => !isAlly(c));
    const ids = new Set(enemyList.map((c) => c.id));
    const enemies = [];
    const placed = new Set();
    const place = (c, depth) => {
      if (placed.has(c.id)) return;
      placed.add(c.id);
      enemies.push([c, depth]);
      for (const m of enemyList.filter((x) => x.leader === c.id)) place(m, depth + 1);
    };
    const roots = enemyList.filter((c) => !c.lair && !(c.leader && ids.has(c.leader)));
    for (const c of [...roots.filter((c) => c.boss), ...roots.filter((c) => !c.boss)]) place(c, 0);
    for (const c of enemyList) place(c, 0); // lair + anything left over
    $('#d-allies').replaceChildren(...(allies.length ? allies.map((c) => dCard(c, tagOf(c))) : [h('p', { class: 'muted' }, 'No allies yet.')]));
    $('#d-enemies').replaceChildren(...(enemies.length
      ? enemies.map(([c, depth]) => {
        const card = dCard(c, tagOf(c));
        if (depth) card.style.marginLeft = `${Math.min(depth, 3) * 1.1}rem`;
        return card;
      })
      : [h('p', { class: 'muted' }, 'No enemies… yet.')]));
    const fighters = enemyList.filter((c) => !c.lair);
    $('#d-allies-count').textContent = allies.length ? `${allies.filter((c) => !c.defeated).length} standing` : '';
    $('#d-enemies-count').textContent = fighters.length ? `${fighters.filter((c) => !c.defeated).length} left` : '';
    renderBossBar($('#d-boss'), { big: true });

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
      type: 'number', inputmode: 'numeric', min: '1', placeholder: 'Max', 'aria-label': 'Max (makes it a bar)',
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
  $('#btn-add-legact').addEventListener('click', () => addStat({ key: 'Legendary actions', max: 3, value: 3, color: 'orange', refill: true }));
  $('#btn-add-legres').addEventListener('click', () => addStat({ key: 'Legendary resistance', max: 3, value: 3, color: 'purple' }));

  /* ------------------------------------------------------------ */
  /* conditions dialog (buffs / debuffs)                           */
  /* ------------------------------------------------------------ */
  const condDlg = $('#cond-dialog');
  const condForm = $('#cond-form');
  const PRESETS = window.DndRooms.CONDITION_PRESETS;
  let condFor = null;

  function presetButton(p) {
    return h('button', {
      type: 'button',
      class: `cond-preset cond-${p.kind}`,
      'data-key': p.key,
      title: p.rounds ? `Default duration: ${p.rounds} rounds` : '',
      onclick: () => togglePreset(p),
    }, `${p.emoji} ${p.name}`, p.rounds ? h('small', {}, ` ${p.rounds}r`) : null, p.color ? h('span', { class: `swatch tint-${p.color}`, title: 'Changes a bar color' }) : null);
  }
  $('#cond-official').replaceChildren(...PRESETS.filter((p) => p.official).map(presetButton));
  $('#cond-common').replaceChildren(...PRESETS.filter((p) => !p.official).map(presetButton));

  async function condAct(event, payload) {
    const res = await emit(event, payload);
    $('#cond-error').textContent = res.ok ? '' : res.error;
    return res;
  }

  function togglePreset(p) {
    const c = byId(condFor);
    if (!c) return;
    const active = (c.conditions || []).find((k) => k.key === p.key);
    // tapping an active condition removes it (Exhaustion goes up a level instead)
    if (active && !p.levels && active.canRemove) return condAct('condition:remove', { id: c.id, condId: active.id });
    const rounds = $('#cond-rounds').value;
    return condAct('condition:add', { id: c.id, condition: { preset: p.key, rounds: rounds || undefined } });
  }

  function openConditions(id) {
    condFor = id;
    $('#cond-error').textContent = '';
    $('#cond-rounds').value = '';
    condForm.reset();
    syncCondForm();
    $('#cond-secret-field').hidden = !isDm();
    renderConditionsDialog();
    condDlg.showModal();
  }
  $('#btn-cond-close').addEventListener('click', () => condDlg.close());

  function renderConditionsDialog() {
    if (!condDlg.open || !condFor) return;
    const c = byId(condFor);
    if (!c) { condDlg.close(); return; }
    $('#cond-title').textContent = `✨ Effects on ${c.name}`;
    const list = c.conditions || [];
    $('#cond-active').replaceChildren(...(list.length ? list.map((k) => {
      const preset = PRESETS.find((p) => p.key === k.key);
      return h('div', { class: `cond-line cond-${k.kind}` },
        h('span', { class: 'cond-line-name' }, condText(k)),
        k.rounds ? h('span', { class: 'muted small' }, `⏳ ${k.rounds} round${k.rounds > 1 ? 's' : ''} left`) : h('span', { class: 'muted small' }, 'until removed'),
        k.color ? h('span', { class: `swatch tint-${k.color}`, title: `Colors the ${k.bar.replace('stat:', '')} bar` }) : null,
        k.secret ? h('span', { class: 'small' }, '🤫 secret') : null,
        h('span', { class: 'spacer' }),
        preset && preset.levels && k.canRemove ? h('button', { class: 'btn ghost tiny', 'aria-label': 'Lower level', onclick: () => condAct('condition:level', { id: c.id, condId: k.id, delta: -1 }) }, '−') : null,
        preset && preset.levels ? h('button', { class: 'btn ghost tiny', 'aria-label': 'Raise level', onclick: () => condAct('condition:level', { id: c.id, condId: k.id, delta: 1 }) }, '+') : null,
        k.canRemove ? h('button', { class: 'btn ghost tiny', 'aria-label': `Remove ${k.name}`, onclick: () => condAct('condition:remove', { id: c.id, condId: k.id }) }, '✕') : null);
    }) : [h('p', { class: 'muted small' }, 'No effects yet. Tap one below to add it.')]));
    for (const b of condDlg.querySelectorAll('.cond-preset')) {
      b.classList.toggle('active', list.some((k) => k.key === b.dataset.key));
    }
  }

  function syncCondForm() {
    const f = condForm.elements;
    condForm.querySelector('.cond-bar-field').hidden = !f.color.value;
    condForm.querySelector('.cond-stat-field').hidden = !f.color.value || f.bar.value !== 'stat';
  }
  condForm.elements.color.addEventListener('change', syncCondForm);
  condForm.elements.bar.addEventListener('change', syncCondForm);

  condForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = condForm.elements;
    const bar = f.bar.value === 'stat' ? `stat:${f.stat.value.trim()}` : f.bar.value;
    const res = await condAct('condition:add', {
      id: condFor,
      condition: {
        name: f.name.value,
        emoji: f.emoji.value,
        kind: f.kind.value,
        color: f.color.value,
        bar,
        rounds: $('#cond-rounds').value || undefined,
        secret: f.secret.checked,
      },
    });
    if (res.ok) { condForm.reset(); syncCondForm(); }
  });

  function readStats() {
    return [...$('#stats').querySelectorAll('.stat-row')].map((r) => ({
      key: r.querySelector('[data-k]').value,
      value: r.querySelector('[data-v]').value,
      max: r.querySelector('[data-max]').value,
      color: r.querySelector('[data-color]').value || undefined,
      refill: r.querySelector('[data-refill]').checked,
    })).filter((st) => st.key || st.value);
  }

  /** A reusable monster from the editor's current fields (no count, leader or hidden). */
  function templateFromForm() {
    const f = form.elements;
    return {
      name: f.name.value.trim(),
      hpMax: Number(f.hpMax.value) || 10,
      ac: Number(f.ac.value) || 0,
      initBonus: Number(f.initBonus.value) || 0,
      boss: f.boss.checked,
      stats: readStats().map((st) => (st.max === '' ? { key: st.key, value: st.value } : { ...st, max: Number(st.max), value: st.value === '' ? Number(st.max) : Number(st.value) })),
      savedAt: Date.now(),
    };
  }

  const MY_KEY = 'dnd.myMonsters';
  function loadMyMonsters() {
    const v = store.get(MY_KEY, []);
    return Array.isArray(v) ? v.filter((m) => m && typeof m.name === 'string') : [];
  }
  function saveMyMonsters(list) {
    store.set(MY_KEY, list.slice(0, 1000));
  }

  /* ---------- monster library (DM) ---------- */
  const libDlg = $('#lib-dialog');
  let srdMonsters = null;

  async function loadSrd() {
    if (srdMonsters) return srdMonsters;
    try {
      const res = await fetch('data/srd-monsters.json');
      srdMonsters = (await res.json()).monsters || [];
    } catch {
      srdMonsters = [];
      toast('Could not load the SRD monster list.', true);
    }
    return srdMonsters;
  }

  /** SRD entry -> editor template: Type/CR/Speed as text, Movement and legendary bars. */
  function srdTemplate(m) {
    const stats = [
      { key: 'Type', value: `${m.s} ${m.t}` },
      { key: 'CR', value: `${m.cr} (${Number(m.xp).toLocaleString()} XP)` },
      { key: 'Hit dice', value: m.hd },
      { key: 'Speed', value: m.sp },
    ];
    if (m.pp != null) stats.push({ key: 'Passive Perception', value: String(m.pp) });
    if (m.mv) stats.push({ key: 'Movement', value: m.mv, max: m.mv, color: 'yellow', refill: true });
    if (m.la) stats.push({ key: 'Legendary actions', value: m.la, max: m.la, color: 'orange', refill: true });
    if (m.lr) stats.push({ key: 'Legendary resistance', value: m.lr, max: m.lr, color: 'purple' });
    return { name: m.n, hpMax: m.hp, ac: m.ac, initBonus: m.ib, boss: Boolean(m.la), stats };
  }

  function crValue(cr) {
    const [a, b] = String(cr).split('/');
    return b ? Number(a) / Number(b) : Number(a);
  }

  async function renderLibrary() {
    const q = $('#lib-q').value.trim().toLowerCase();
    const src = $('#lib-src').value;
    const statOf = (t, key) => ((t.stats || []).find((st) => String(st.key).toLowerCase() === key) || {}).value;
    const mine = loadMyMonsters().map((t) => {
      const cr = String(statOf(t, 'cr') || '').split(' ')[0] || undefined;
      const type = statOf(t, 'type') || '';
      return {
        kind: 'mine', name: t.name, cr, template: t,
        sub: `Saved · ${type ? `${type} · ` : ''}${cr ? `CR ${cr} · ` : ''}AC ${t.ac} · HP ${t.hpMax}${t.boss ? ' · 👑 boss' : ''}`,
        search: `${t.name} ${type} ${cr ? `cr ${cr}` : ''}`.toLowerCase(),
      };
    });
    const srd = src === 'mine' ? [] : (await loadSrd()).map((m) => ({
      kind: 'srd', name: m.n, cr: m.cr,
      sub: `${m.s} ${m.t} · CR ${m.cr} · AC ${m.ac} · HP ${m.hp}${m.la ? ' · 👑 legendary' : ''}`,
      template: null, raw: m, search: `${m.n} ${m.t} ${m.s} cr ${m.cr}`.toLowerCase(),
    }));
    let items = [...(src === 'srd' ? [] : mine), ...srd];
    const crMatch = q.match(/^cr\s*([\d/.]+)$/);
    if (crMatch) items = items.filter((i) => i.cr !== undefined && crValue(i.cr) === crValue(crMatch[1]));
    else if (q) items = items.filter((i) => q.split(/\s+/).every((w) => i.search.includes(w)));
    const shown = items.slice(0, 80);
    $('#lib-list').replaceChildren(...(shown.length ? shown.map((i) => h('div', { class: `lib-row ${i.kind}` },
      h('div', { class: 'lib-main' },
        h('div', { class: 'lib-name' }, i.kind === 'mine' ? `💾 ${i.name}` : i.name),
        h('div', { class: 'muted small' }, i.sub)),
      i.kind === 'mine' ? h('button', { class: 'btn ghost tiny', title: `Delete ${i.name}`, onclick: () => {
        if (!confirm(`Delete ${i.name} from your monsters?`)) return;
        saveMyMonsters(loadMyMonsters().filter((t) => t !== i.template && t.name !== i.name));
        renderLibrary();
      } }, '🗑') : null,
      h('button', { class: 'btn primary small', onclick: () => {
        libDlg.close();
        openEditor('enemy', null, { template: i.template || srdTemplate(i.raw) });
      } }, '+ Add'))) : [h('p', { class: 'muted small' }, q ? 'No monsters match.' : 'No monsters yet.')]),
    items.length > shown.length ? h('p', { class: 'muted small' }, `Showing ${shown.length} of ${items.length} – type to narrow down.`) : null);
  }

  $('#btn-library').addEventListener('click', () => {
    $('#lib-q').value = '';
    libDlg.showModal();
    renderLibrary();
    $('#lib-q').focus();
  });
  $('#btn-lib-close').addEventListener('click', () => libDlg.close());
  $('#lib-q').addEventListener('input', () => renderLibrary());
  $('#lib-src').addEventListener('change', () => renderLibrary());
  $('#btn-lib-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ type: 'dnd-turn-tracker-monsters', monsters: loadMyMonsters() }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'my-monsters.json' });
    document.body.append(a);
    a.click();
    a.remove();
  });
  $('#lib-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data.monsters || []).filter((m) => m && typeof m.name === 'string');
      const byName = new Map(loadMyMonsters().map((m) => [m.name.toLowerCase(), m]));
      for (const m of incoming) byName.set(m.name.toLowerCase(), m);
      saveMyMonsters([...byName.values()]);
      toast(`Imported ${incoming.length} monster(s).`);
      renderLibrary();
    } catch {
      toast('That file is not a monster list.', true);
    }
  });

  $('#btn-save-template').addEventListener('click', () => {
    const t = templateFromForm();
    if (!t.name) { $('#editor-error').textContent = 'Give the monster a name first.'; return; }
    const mine = loadMyMonsters().filter((m) => m.name.toLowerCase() !== t.name.toLowerCase());
    mine.push(t);
    saveMyMonsters(mine);
    toast(`💾 ${t.name} saved to your monsters.`);
  });

  function fillLeaderSelect(selfId, selected) {
    const sel = form.elements.leader;
    const options = state.combatants.filter((x) => x.type === 'enemy' && !x.lair && x.id !== selfId);
    sel.replaceChildren(
      h('option', { value: '' }, '— nobody (independent) —'),
      ...options.map((x) => h('option', { value: x.id, selected: x.id === selected }, `${x.boss ? '👑 ' : ''}${x.name}${x.defeated ? ' (defeated)' : ''}`)));
    syncSummonOpts();
  }
  function syncSummonOpts() {
    form.querySelector('.summon-opts').hidden = !form.elements.leader.value;
  }
  form.elements.leader.addEventListener('change', syncSummonOpts);

  function openEditor(type, c = null, preset = {}) {
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
      f.initBonus.value = c.initBonus || 0;
      f.hidden.checked = Boolean(c.hidden);
      f.boss.checked = Boolean(c.boss);
      f.onLeaderDeath.value = c.onLeaderDeath || 'dies';
      f.followLeader.checked = Boolean(c.followLeader);
    } else {
      f.name.value = type === 'pc' ? (state ? state.you.name : '') : '';
      f.hp.value = '';
      f.boss.checked = Boolean(preset.boss);
      f.followLeader.checked = Boolean(preset.followLeader);
    }
    if (!c && preset.template) {
      const t = preset.template;
      f.name.value = t.name || '';
      f.hpMax.value = t.hpMax || 10;
      f.ac.value = t.ac ?? 10;
      f.initBonus.value = t.initBonus || 0;
      f.boss.checked = Boolean(t.boss);
      $('#stats').replaceChildren(...(t.stats || []).map((st) => statRow(st)));
    }
    if (type === 'enemy') {
      fillLeaderSelect(c ? c.id : null, c ? c.leader : preset.leader);
      if (!c && preset.leader) {
        const leader = byId(preset.leader);
        $('#editor-title').textContent = `Summon for ${leader ? leader.name : 'leader'}`;
      }
      if (!c && preset.boss) $('#editor-title').textContent = 'Add a boss';
    }
    if (!(preset && preset.template)) $('#stats').replaceChildren(...((c && c.stats) || []).map((s) => statRow(s)));
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
    const stats = readStats();
    const combatant = {
      id: editing.id || undefined,
      type: editing.type,
      name: f.name.value,
      cls: f.cls.value,
      level: f.level.value,
      hpMax: f.hpMax.value,
      hp: f.hp.value === '' ? undefined : f.hp.value,
      ac: f.ac.value,
      initBonus: f.initBonus.value,
      count: f.count.value,
      hidden: editing.type === 'enemy' ? f.hidden.checked : undefined,
      stats,
    };
    if (editing.type === 'enemy') {
      Object.assign(combatant, {
        boss: f.boss.checked,
        leader: f.leader.value || null,
        onLeaderDeath: f.onLeaderDeath.value,
        followLeader: f.followLeader.checked,
      });
    }
    const res = await emit('combatant:save', { combatant });
    if (!res.ok) { $('#editor-error').textContent = res.error; return; }
    dlg.close();
    toast(editing.id ? 'Saved.' : 'Added!');
  });

  resume();
})();
