# 🎲 D&D Turn Tracker

An online, real-time initiative / turn tracker for Dungeons & Dragons.
Everyone at the table opens the site, enters the same **room code**, and shares one turn order.
When it's your turn, **your device** (and only yours) plays a chime and the screen turns **green**.

## Features

- **Runs on phones and tablets with no setup** – one device hosts the room in the browser; the others join with a 5-character code or a QR code.
- **Player characters** – each player adds name, class, level, max/current HP, AC (CA), initiative bonus and any number of **custom stats**:
  - text stats shown as chips (Spell DC 15, Passive Perception 14…);
  - **bar stats** – give a stat a *Max* and it's drawn as a colored bar under the HP bar (Mana 12/20, Movement 30/30, Ki, Rage…). Whoever controls the creature can tap −/+ or set the exact value. Tick **Refills every turn** and it fills back up when that creature's turn starts (great for movement). Quick-add buttons for Mana and Movement.
- **Up to 3 friendly NPCs per player** – companions, familiars, pets, summons… with the same fields. Their turns alert their owner's device.
- **💤 Friendly NPCs in reserve** – tap **💤 Reserve** on a friendly NPC (or tick *Starts in reserve* when creating it) to keep it out of the fight: it stays in the party and on the table display, but gets no turns and isn't asked to roll initiative. Tap **⚔️ Join battle** when it's needed – mid-fight the app asks its owner for its initiative roll – and send it back to reserve any time. Its owner or the DM can do this.
- **💾 Saved characters** – players tap **Save party** to keep their character and friendly NPCs on their device, then **📂 My characters → Use** in any room brings them in at full HP with bars refilled (no retyping each session). When you join a room without a character, your saved ones are offered first. **Export/Import** moves them to another phone.
- **Unlimited enemies for the DM** – add them one at a time or in batches ("4× Goblin" → Goblin 1–4), optionally **hidden** until you reveal them.
- **Bosses & summons** – tick 👑 *Boss* and the monster appears in a **boss bar pinned to the top of every screen** (players see its condition, not exact HP, unless the DM reveals enemy stats). Use **➕ Summon** on any enemy to add creatures linked to it, and choose what happens **if the leader falls**: they die too, flee (removed), or keep fighting – also down a chain of summons. Summons can **act right after their leader**. One-tap presets for *Legendary actions* (refills every turn) and *Legendary resistance*, and a 🏰 **Lair actions** turn on initiative 20 that loses ties.
- **Buffs, debuffs & conditions** – tap **✨ Effects** on any creature: the 15 official 5e conditions (Exhaustion with levels 1–6) plus common effects (Blessed, Hasted, Raging, Concentrating, Dodging, Slowed, Burning, Bleeding, Cursed…), or create your own with a name, emoji, buff/debuff type, and **a color that repaints the HP, mana/magic, movement, all bars, or one named bar** (shown with moving stripes). Give it a duration in rounds and it **wears off automatically** at the end of that creature's turn. Players can affect any creature they see and remove what they added (or anything on their own creatures); the DM can do everything and add 🤫 secret effects only the DM sees.
- **No practical limits** – level, HP, AC and bar maximums go up to 1,000,000, with up to 100 custom stats per creature.
- **Deal damage** – players pick an enemy and an amount and hit it. Players can also damage/heal their own creatures and heal other players' creatures; the DM can change anyone's HP.
- **Secret enemy stats** – by default players only see an enemy's condition (Unharmed / Injured / Bloodied / Near death / Defeated), not its HP, AC or stats. The DM can toggle this.
- **Initiative round** – initiative isn't typed in the character form any more. When the DM taps **⚔️ Start combat**, everyone enters their **d20 roll** one at a time: **the DM first** (for all enemies), then the players in the order they acted in the last combat (join order the first time). The device whose turn it is to roll chimes and opens the roll box; the others see who they're waiting for. The app adds each creature's **initiative bonus** and sorts the fight. You can also tap the **initiative circle** on your card at any time to enter or change your roll, or let the app roll (🎲). The DM can roll for someone who's away (*⏭ Roll for them*) or *Start without rolling* to keep the current numbers. Summons that act after their leader and lair actions don't roll.
- **Turn order** – sorted by initiative (roll + bonus). Defeated enemies and hidden creatures are skipped; rounds are counted.
- **📚 Monster library (DM)** – search and add the **334 monsters of the free D&D 5e SRD 5.1** (name, type or CR, e.g. `dragon`, `undead`, `cr 5`): HP, AC, initiative bonus, CR/XP, speed, a Movement bar, and Legendary actions/resistance bars (legendary monsters come in as bosses). The full *Monster Manual* and other books are copyrighted and can't be included – instead, **💾 save your own monsters** from the enemy editor (e.g. from books you own). They're kept on the DM's device; **Export/Import** moves them to another device.
- **🎵 Music for the DM** – a 🎵 tab in the corner (and in the DM toolbar) on the **DM's device and the table display** – never on players' phones – plays a **YouTube** or **Spotify** link: a video, playlist, album or track. Save your playlists ("Tavern", "Combat"…) to switch with one tap; collapsing the tab keeps the music playing. It plays on that device, so use the one connected to the speaker. Some YouTube videos don't allow embedding, and Spotify's embedded player may only play short previews unless you're signed in to Spotify in that browser.
- **🗺️ Map with a DM pen** – the DM shares a map from **🗺️ Map** in the DM toolbar (the table display has *🗺️ Map link* / *📷 Map image* buttons too): paste a link to a map image or website, or **📷 upload a picture** (e.g. a screenshot). The **table display always shows it** – big at the top out of combat, under the turn info during combat – and players see it on their phones out of combat. **Full screen** works on every device. Turn on **✏️ Pen** (DM or table display) to draw: colors, sizes, undo, clear; lines appear **live on every screen while they're being drawn**. Many map websites (Map Genie, for example) don't allow being shown inside other apps – the browser blocks it and nothing can override that – so take a screenshot of the map and upload it; the pen works on pictures. *↗ Open site* opens a website in a normal tab (best on the DM's phone: on a hosting tablet, leaving the page pauses the room). The map box is 16:9 on every device so drawings line up.
- **Three kinds of device**
  - **DM** – runs enemies, turns and HP.
  - **Player** – their character, up to 3 friendly NPCs, saved characters, deal damage, turn alerts.
  - **Table display** (made for a tablet) – a big battle board for everyone to look at: *now* playing (ally or enemy, HP and bars), *up next*, an initiative strip, and separate **🛡️ Allies** / **⚔️ Enemies** columns, plus the last events and a QR code to join. Choose *Host on this tablet (table display)* or *Join as table display* in the lobby. It never sees secrets (hidden enemies, enemy HP/AC unless the DM reveals them).
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
  - **a tablet in the middle of the table – recommended** (*Host on this tablet (table display)*): it shows the battle board and a QR code; the DM joins from their phone with the **DM key** shown on the tablet. The DM can then switch apps or tabs (to look something up) without affecting anyone.
  - **the DM's phone/tablet** (*Host on my device as the DM*), if there's no tablet.
- **Moving the host:** the hosting device shows a **📡 Hosting** badge; tap it to hand the room to a table display (or to the DM) that's connected. The room moves in a few seconds and everyone reconnects automatically – handy when the DM started the room on their phone.
- A tablet can also just **join** an existing room as a table display (*Join as table display*).

**Publishing on GitHub Pages:**

1. Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch **main**, folder **/ (root)**.
2. Wait for the *pages build and deployment* run in the **Actions** tab to finish, then open `https://<user>.github.io/<repo>/` on every device. The root `index.html` forwards to the app in `public/` (invite links with `?room=CODE` keep working), and `.nojekyll` makes GitHub serve the files as they are.
3. Tip: *Share → Add to Home Screen* makes it open like an app.

> Check GitHub's current documentation for which plans allow Pages on **private** repositories.
> Any other static host works too: just upload the contents of `public/`.

**What you should know about this mode**

- Devices need an internet connection when joining: the free public PeerJS service is used to find the host (handshake only). After that, game data flows directly between devices, falling back to PeerJS's public relay (TURN) servers when a direct connection isn't possible. These public services have no uptime guarantee; you can point the app to your own PeerServer in `public/config.js`.
- **Keep the host device's tracker open with the screen on.** Phone and tablet browsers usually pause pages that are in the background, so if the host switches app or tab, sleeps or closes the browser, the other devices show "Reconnecting to the host…" and reconnect automatically when it's back. That's why a table display that stays on the table is the best host. The app asks the browser to keep the screen awake (Wake Lock) where supported.
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

1. **Host:** on the tablet, open the site → *Host on this tablet (table display)*. The DM opens the site on their phone and joins with the room code + the **DM key** shown on the tablet (*I'm the DM on a new device*). No tablet? The DM taps *Host on my device as the DM*.
2. **Players:** scan the QR code (or tap **📱 Invite** next to the room code) or type the code → *Join as player*, then fill in your character (or pick a saved one). Optionally add up to 3 friendly NPCs, and tap 💾 Save party to reuse them next time.
3. **DM:** use the **DM toolbar** at the top of your screen (it only appears on the DM's device): **➕ Enemies**, **📚 Monsters** (the SRD library and your saved monsters), **🗺️ Map** (paste a map link, then draw on it with ✏️ Pen), **🎵 Music**. Boss and lair buttons are in the *Dungeon Master* box. The table display can also set the map with its *🗺️ Set the map from here* button.
4. **DM:** **⚔️ Start combat** → everyone enters their initiative roll, DM first. The fight starts when everyone is done.
5. On your turn your screen goes green and chimes. Use **🗡️ Deal damage** (or the *Attack* button on an enemy) to hit enemies, then **End my turn**.

> Browsers only allow sound after you've interacted with the page, so tap anywhere once after opening it.

## Project layout

```
index.html, .nojekyll  Forward GitHub Pages visitors from the repo root to public/
public/              The app (static files – this is all a static host needs)
  index.html, app.js, style.css
  net.js             Transports: Node server (Socket.IO), P2P host, P2P guest
  config.js          Runtime config (p2p vs server, custom PeerServer)
  shared/rooms.js    Game rules: rooms, permissions, damage, turn order, per-player views
  shared/hub.js      Request handling, shared by the Node server and the P2P host
  data/srd-monsters.json  The 334 SRD 5.1 monsters used by the monster library
  vendor/            PeerJS 1.5.5 and qrcode-generator 2.0.4 (MIT), refreshed with `npm run vendor`
server.js            Optional Node.js server (Express + Socket.IO)
test/                node:test unit + integration tests
```

## Credits & licenses

- Monster data: This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode. The file `public/data/srd-monsters.json` was extracted (and reduced to the fields the tracker uses) from [5e-bits/5e-database](https://github.com/5e-bits/5e-database) (MIT), `src/2014/en/5e-SRD-Monsters.json`.
- [PeerJS](https://peerjs.com/) 1.5.5 and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4, both MIT, are included in `public/vendor/`.
- Dungeons & Dragons is a trademark of Wizards of the Coast. This is an unofficial fan tool, not affiliated with or endorsed by Wizards of the Coast.
