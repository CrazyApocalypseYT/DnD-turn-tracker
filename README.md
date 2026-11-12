# 🎲 D&D Turn Tracker

An online, real-time initiative / turn tracker for Dungeons & Dragons.
Everyone at the table opens the site, enters the same **room code**, and shares one turn order.
When it's your turn, **your device** (and only yours) plays a chime and the screen turns **green**.

## Features

- **Runs on phones and tablets with no setup** – one device hosts the room in the browser; the others join with a 5-character code or a QR code.
- **Player characters** – each player adds name, class, level, max/current HP, AC (CA), initiative and any number of **custom stats** (Spell DC, Passive Perception, Ki points…).
- **One friendly NPC per player** – a companion, familiar, pet… with the same fields. Its turn alerts its owner's device.
- **Unlimited enemies for the DM** – add them one at a time or in batches ("4× Goblin" → Goblin 1–4), optionally **hidden** until you reveal them.
- **Deal damage** – players pick an enemy and an amount and hit it. Players can also damage/heal their own creatures and heal other players' creatures; the DM can change anyone's HP.
- **Secret enemy stats** – by default players only see an enemy's condition (Unharmed / Injured / Bloodied / Near death / Defeated), not its HP, AC or stats. The DM can toggle this.
- **Turn order** – sorted by initiative (decimals allowed to break ties, 🎲 button rolls d20 + bonus). Defeated enemies and hidden creatures are skipped; rounds are counted.
- **Your-turn alert** – chime (Web Audio, no files), green flash, green screen while it's your turn, vibration where the browser supports it. The screen is kept awake (Wake Lock) where supported.
- The player whose turn it is can press **End my turn**; the DM can go next/previous or give the turn to anyone.
- Live list of who is online, plus a shared combat log.
- Reloading the page or losing connection rejoins automatically. The DM gets a **DM key** to continue as DM on another device.

## Two ways to run it

### A) No server – a phone or tablet hosts the room (recommended)

The whole app is a set of static files (`public/`). Put them on any static web host **once**, then everyone just opens the link – nothing to install on any device.

- The device that taps **Create room** *is* the server: the room lives in that browser (and is saved there, so a reload or browser restart brings it back).
- The other phones join with the room code or by **scanning the QR code**, and connect **directly** to the host device over WebRTC ([PeerJS](https://peerjs.com/)).
- The host can be:
  - **the DM's phone/tablet** (*Create room – I'm the DM*), or
  - **a tablet in the middle of the table** (*Use this device as the table screen*): it shows the turn order and a big QR code; the DM joins from their phone with the **DM key** shown on the tablet.

**Publishing on GitHub Pages:**

1. Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch **main**, folder **/ (root)**.
2. Wait for the *pages build and deployment* run in the **Actions** tab to finish, then open `https://<user>.github.io/<repo>/` on every device. The root `index.html` forwards to the app in `public/` (invite links with `?room=CODE` keep working), and `.nojekyll` makes GitHub serve the files as they are.
3. Tip: *Share → Add to Home Screen* makes it open like an app.

> Check GitHub's current documentation for which plans allow Pages on **private** repositories.
> Any other static host works too: just upload the contents of `public/`.

**What you should know about this mode**

- Devices need an internet connection when joining: the free public PeerJS service is used to find the host (handshake only). After that, game data flows directly between devices, falling back to PeerJS's public relay (TURN) servers when a direct connection isn't possible. These public services have no uptime guarantee; you can point the app to your own PeerServer in `public/config.js`.
- **Keep the host device's tracker open with the screen on.** If it sleeps or the browser is closed, the other devices show "Reconnecting to the host…" and reconnect automatically when it's back. The app asks the browser to keep the screen awake (Wake Lock) where supported.
- Phones whose screen is off may not get the turn sound until they're woken up; when they wake, they reconnect automatically.
- Turn alerts, damage, editing etc. work the same as in server mode.

### B) With the Node.js server

Use this if you prefer a computer or cloud host to keep the rooms (no WebRTC involved). Requires Node.js 18+.

```bash
npm install
npm start
# open http://localhost:3000 (other devices on the same Wi-Fi: http://<computer-ip>:3000)
```

When served this way the app automatically talks to the server instead of hosting rooms in the browser.
It runs on any host that supports Node.js and WebSockets (a `Dockerfile` is included); the port comes from `PORT`.
Rooms are saved to `data/rooms.json` (`DATA_FILE`), and deleted after 14 days unused (`ROOM_TTL_DAYS`). On hosts with an ephemeral filesystem, rooms are lost on redeploy.

### Tests

```bash
npm test
```

## How to play

1. **Host:** open the site → *Create room – I'm the DM* (or *Use this device as the table screen* on a tablet; the DM then joins with the DM key).
2. **Players:** scan the QR code (tap **📱 Invite** next to the room code) or type the code → *Join as player*, then fill in your character. Optionally add one friendly NPC.
3. **DM:** *+ Add enemies*, then **⚔️ Start combat**.
4. On your turn your screen goes green and chimes. Use **🗡️ Deal damage** (or the *Attack* button on an enemy) to hit enemies, then **End my turn**.

> Browsers only allow sound after you've interacted with the page, so tap anywhere once after opening it. Use **Test alert** to check the sound and the green flash.

## Project layout

```
index.html, .nojekyll  Forward GitHub Pages visitors from the repo root to public/
public/              The app (static files – this is all a static host needs)
  index.html, app.js, style.css
  net.js             Transports: Node server (Socket.IO), P2P host, P2P guest
  config.js          Runtime config (p2p vs server, custom PeerServer)
  shared/rooms.js    Game rules: rooms, permissions, damage, turn order, per-player views
  shared/hub.js      Request handling, shared by the Node server and the P2P host
  vendor/            PeerJS 1.5.5 and qrcode-generator 2.0.4 (MIT), refreshed with `npm run vendor`
server.js            Optional Node.js server (Express + Socket.IO)
test/                node:test unit + integration tests
```
