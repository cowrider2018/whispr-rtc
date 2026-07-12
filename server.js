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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.normalize(
    path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath)
  );
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, {
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

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join' && typeof msg.room === 'string' && !ws.room) {
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
