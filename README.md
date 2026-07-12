# Whispr

A minimal 1-on-1 voice call web app (Chinese UI: **偷聊**). Two people enter the
same room code and talk directly, peer-to-peer. The server only relays
signaling — voice audio never passes through it.

## Features

- **1-on-1 voice** — WebRTC peer-to-peer audio with echo cancellation, noise
  suppression, and auto gain control.
- **Room codes** — share a link (`?room=xxx`) or type a matching code; the room
  is capped at 2 peers.
- **Screen share** — share a window/screen/tab at 720p–1080p–1440p, switchable
  live. Voice always keeps priority: video is bitrate-capped and low-priority so
  it sheds frames first under congestion.
- **Noise gate** — an audio-worklet gate with adjustable threshold and tail
  hold, hysteresis, and a smooth release so word endings aren't clipped. Live
  mic meter included.
- **Connection stats** — live RTT and P2P/TURN route indicator.
- **Persistent settings** — volumes, gate, and quality are saved to
  `localStorage`.

## Architecture

Single-responsibility modules, low coupling:

- `server.js` — HTTP static server + WebSocket signaling relay (no media).
- `public/js/signaling.js` — thin WebSocket client; relays opaque messages.
- `public/js/call.js` — WebRTC logic using the perfect-negotiation pattern.
- `public/js/noise-gate.js` + `gate-worklet.js` — mic processing on the audio thread.
- `public/js/screen-share.js` — screen capture + quality control.
- `public/js/main.js` — UI wiring only.
- `public/js/ambient.js`, `range-fill.js` — self-contained visual layers.

## Run

```sh
npm install
npm start          # serves on http://localhost:3000
```

To expose it publicly over HTTPS (required for `getUserMedia` off localhost),
use the ngrok helper scripts:

- Put your ngrok authtoken in `ngrok.yml` (gitignored).
- Run `start-call.bat` to launch the server + tunnel, `stop-call.bat` to stop.

## Connectivity

STUN alone covers most NATs. For strict NATs (CGNAT, corporate firewalls) add a
TURN server in `public/js/ice-config.js`, or those calls will fail to connect.
