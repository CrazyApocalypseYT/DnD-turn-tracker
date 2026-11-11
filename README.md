# 🎲 D&D Turn Tracker

An online, real-time initiative / turn tracker for Dungeons & Dragons.
Everyone at the table opens the site, enters the same **room code**, and shares one turn order.
When it's your turn, **your device** (and only yours) plays a chime and the screen turns **green**.

## Features

- **Rooms with a code** – the DM creates a room and gets a 5-character code (plus an invite link). Players join with that code.
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

## Run it locally

Requires Node.js 18 or newer.

```bash
npm install
npm start
# open http://localhost:3000
```

Other devices on the same Wi-Fi can join via `http://<your-computer-ip>:3000`.

Run the tests:

```bash
npm test
```

## Put it online

It is a single Node.js process (Express + Socket.IO), so it runs on any host that runs Node.js 18+ and supports WebSockets. Check your host's current documentation and pricing.

- **Build command:** `npm install`
- **Start command:** `npm start`
- The port is read from the `PORT` environment variable (default `3000`).
- A `Dockerfile` is included for container-based hosts.

### Data

Rooms are kept in memory and saved to `data/rooms.json` (override with `DATA_FILE`), so a normal restart keeps them.
On hosts with an ephemeral filesystem, rooms are lost when the server is redeployed or restarted.
Rooms unused for 14 days are deleted (`ROOM_TTL_DAYS`).

## How to play

1. **DM:** enter your name → *Create room as DM*. Share the code (click the code to copy the invite link).
2. **Players:** enter your name and the code → *Join as player*, then fill in your character. Optionally add one friendly NPC.
3. **DM:** *+ Add enemies*, then **⚔️ Start combat**.
4. On your turn your screen goes green and chimes. Use **🗡️ Deal damage** (or the *Attack* button on an enemy) to hit enemies, then **End my turn**.

> Browsers only allow sound after you've interacted with the page, so tap anywhere once after opening it. Use **Test alert** to check the sound and the green flash.

## Project layout

```
server.js          Express + Socket.IO server, persistence
src/rooms.js       Game rules: rooms, permissions, damage, turn order, per-player views
public/            Front-end (plain HTML/CSS/JS, no build step)
test/              node:test unit + integration tests
```
