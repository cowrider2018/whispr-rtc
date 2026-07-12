// Thin WebSocket signaling client. Knows nothing about WebRTC —
// it only joins a room and relays opaque messages, keeping it
// decoupled from call logic.
export class SignalingChannel {
  #ws;
  #handlers = {};

  connect(room) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.#ws = new WebSocket(`${proto}://${location.host}`);

    this.#ws.addEventListener('open', () => {
      this.#ws.send(JSON.stringify({ type: 'join', room }));
    });

    this.#ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#handlers[msg.type]?.(msg);
    });

    this.#ws.addEventListener('close', () => {
      this.#handlers['disconnected']?.();
    });
  }

  on(type, handler) {
    this.#handlers[type] = handler;
  }

  sendSignal(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: 'signal', data }));
    }
  }

  close() {
    this.#handlers = {};
    this.#ws?.close();
  }
}
