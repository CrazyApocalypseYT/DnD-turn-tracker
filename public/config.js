/*
 * Runtime configuration.
 *
 * mode: 'p2p' (default) – no server needed. The device that creates a room
 *       (e.g. a tablet) hosts it in the browser, and the other devices
 *       connect to it directly with WebRTC (PeerJS).
 *       When the app is served by the included Node.js server (npm start),
 *       that server replaces this file with { mode: 'server' }.
 *
 * peer: options passed to `new Peer()` (https://peerjs.com/docs/#peer-options).
 *       Leave empty to use the free public PeerJS cloud broker for the
 *       initial handshake. To use your own PeerServer:
 *       peer: { host: 'peer.example.com', port: 443, path: '/', secure: true }
 */
window.DND_CONFIG = Object.assign({ mode: 'p2p', peer: {} }, window.DND_CONFIG || {});
