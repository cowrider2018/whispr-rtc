// HTTP static file server + WebSocket signaling relay.
// Voice audio never passes through this server (WebRTC is peer-to-peer);
// this server only relays SDP offers/answers and ICE candidates.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PEERS_PER_ROOM = 2;

// --- Signaling hardening limits ---
const MAX_ROOM_ID_LEN = 128; // hashed room ids are 64 hex chars; leave margin
const MAX_MESSAGE_BYTES = 64 * 1024; // SDP + bundled ICE stays well under this
const MSG_RATE_WINDOW_MS = 1000;
const MSG_RATE_MAX = 60; // messages per window per socket before disconnect

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Security headers applied to every static response. Because signaling is
// end-to-end encrypted by the client, the server is untrusted for call
// content; these headers reduce the blast radius of the code we do serve.
//   - CSP locks script/style/connect to same-origin (no CDN, no inline JS),
//     so a compromised network can't inject exfiltration code.
//   - frame-ancestors/X-Frame-Options block clickjacking of the mic prompt.
//   - Permissions-Policy scopes mic + screen capture to this origin only.
//   - HSTS is honored only over HTTPS (ngrok); harmless on localhost.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss: stun: stuns: turn: turns:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), display-capture=(self), camera=(), geolocation=(), interest-cohort=()',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.normalize(
    path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath)
  );
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, SECURITY_HEADERS);
      return res.end('Not Found');
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    });
    res.end(data);
  });
});

// --- Signaling ---
// Protocol (JSON):
//   client -> server: { type: 'join', room }
//   client -> server: { type: 'signal', data }   (relayed to the other peer)
//   server -> client: { type: 'joined', peerCount }
//   server -> client: { type: 'peer-joined' } | { type: 'peer-left' }
//   server -> client: { type: 'signal', data }
//   server -> client: { type: 'room-full' }
const rooms = new Map(); // roomId -> Set<WebSocket>

// maxPayload drops oversized frames at the protocol level, before we ever
// allocate a string for them — cheap defense against memory-exhaustion.
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

// Per-socket sliding-window rate limit. A misbehaving or hijacked client
// that floods signal frames is disconnected rather than amplified to its peer.
function overRateLimit(ws) {
  const now = Date.now();
  if (!ws.msgTimes || now - ws.msgWindowStart >= MSG_RATE_WINDOW_MS) {
    ws.msgWindowStart = now;
    ws.msgTimes = 0;
  }
  return ++ws.msgTimes > MSG_RATE_MAX;
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    if (overRateLimit(ws)) return ws.close(1008, 'rate limit');

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (
      msg.type === 'join' &&
      typeof msg.room === 'string' &&
      msg.room.length > 0 &&
      msg.room.length <= MAX_ROOM_ID_LEN &&
      !ws.room
    ) {
      const room = rooms.get(msg.room) || new Set();
      if (room.size >= MAX_PEERS_PER_ROOM) {
        return ws.send(JSON.stringify({ type: 'room-full' }));
      }
      room.add(ws);
      rooms.set(msg.room, room);
      ws.room = msg.room;
      ws.send(JSON.stringify({ type: 'joined', peerCount: room.size }));
      broadcastToOthers(ws, { type: 'peer-joined' });
      return;
    }

    if (msg.type === 'signal' && ws.room) {
      broadcastToOthers(ws, { type: 'signal', data: msg.data });
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) rooms.delete(ws.room);
    else broadcastToOthers(ws, { type: 'peer-left' });
  });
});

function broadcastToOthers(sender, msg) {
  const room = rooms.get(sender.room);
  if (!room) return;
  const payload = JSON.stringify(msg);
  for (const client of room) {
    if (client !== sender && client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Voice call server running at http://localhost:${PORT}`);
});
