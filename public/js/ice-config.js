// ICE server configuration — the single place to tune connectivity.
// STUN alone works for ~80-90% of NAT setups (direct P2P, lowest latency).
// For strict NATs (CGNAT, corporate firewalls), add a TURN server below;
// without TURN those calls will fail to connect.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Example TURN entry (self-hosted coturn or managed service):
  // {
  //   urls: 'turn:turn.example.com:3478',
  //   username: 'user',
  //   credential: 'pass',
  // },
];
