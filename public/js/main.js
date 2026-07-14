// UI wiring only — call logic lives in call.js, transport in signaling.js,
// mic processing in noise-gate.js, screen capture in screen-share.js.
import { SignalingChannel } from './signaling.js';
import { VoiceCall } from './call.js';
import { NoiseGate } from './noise-gate.js';
import { captureScreen, applyQuality, qualityFor } from './screen-share.js';
import { generateRoomCredentials, fromB64url, deriveAuthKey } from './crypto.mjs';

const lobby = document.getElementById('lobby');
const callSection = document.getElementById('call');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const hintEl = document.querySelector('.hint');

const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatStatus = document.getElementById('chat-status');

const panel = document.getElementById('panel');
const panelToggle = document.getElementById('panel-toggle');
const panelChevron = document.getElementById('panel-chevron');
const panelMore = document.getElementById('panel-more');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');

const screenVideo = document.getElementById('screen-video');
const remoteAudio = document.getElementById('remote-audio');

const shareBtn = document.getElementById('share-btn');
const muteBtn = document.getElementById('mute-btn');
const muteLbl = muteBtn.querySelector('.lbl');
const muteIco = muteBtn.querySelector('.ico');
const shareLbl = shareBtn.querySelector('.lbl');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const hangupBtn = document.getElementById('hangup-btn');
const shareQualityEl = document.getElementById('share-quality');

const volumeEl = document.getElementById('volume');
const volumeValEl = document.getElementById('volume-val');
const shareVolumeEl = document.getElementById('share-volume');
const shareVolumeValEl = document.getElementById('share-volume-val');

const gateEnabledEl = document.getElementById('gate-enabled');
const gateStateEl = document.getElementById('gate-state');
const thresholdEl = document.getElementById('threshold');
const thresholdValEl = document.getElementById('threshold-val');
const holdEl = document.getElementById('hold');
const holdValEl = document.getElementById('hold-val');
const meterFill = document.getElementById('meter-fill');
const meterMarker = document.getElementById('meter-marker');

const METER_MIN_DB = -90;
const METER_MAX_DB = -10;
const SETTINGS_KEY = 'voice-call-settings-v2';
const PANEL_HIDE_MS = 4000;
const DEFAULT_HINT = '留空並按下按鈕即可建立加密房間,再用「複製連結」把邀請傳給對方';

let signaling = null;
let call = null;
let gate = null;
let muted = false;
let statsTimer = null;
let joined = false;
let localShareStream = null;
let panelHideTimer = null;

const STATE_TEXT = {
  new: '準備中…',
  connecting: '連線中…',
  connected: '✅ 通話中',
  disconnected: '⚠️ 連線中斷,嘗試恢復中…',
  failed: '❌ 連線失敗',
  closed: '通話已結束',
};

// --- Event wiring ---

joinBtn.addEventListener('click', onJoinClick);
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onJoinClick();
});

chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});
muteBtn.addEventListener('click', toggleMute);
hangupBtn.addEventListener('click', endCall);
shareBtn.addEventListener('click', toggleShare);

fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else callSection.requestFullscreen().catch(() => {});
});

copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    copyLinkBtn.textContent = '✅ 已複製';
  } catch {
    copyLinkBtn.textContent = '❌ 複製失敗';
  }
  setTimeout(() => (copyLinkBtn.textContent = '🔗 複製連結'), 2000);
});

panelToggle.addEventListener('click', () => {
  panelMore.hidden = !panelMore.hidden;
  panelChevron.classList.toggle('up', !panelMore.hidden);
});

// Tap the (video) background to summon or dismiss the floating card;
// interacting with the card keeps it alive.
callSection.addEventListener('click', (e) => {
  if (e.target.closest('#panel')) {
    schedulePanelHide();
    return;
  }
  if (panel.classList.contains('panel-hidden')) showPanel();
  else if (!screenVideo.hidden) panel.classList.add('panel-hidden');
});
panel.addEventListener('input', schedulePanelHide);

gateEnabledEl.addEventListener('change', () => {
  gate?.setEnabled(gateEnabledEl.checked);
  saveSettings();
});
thresholdEl.addEventListener('input', () => {
  applyThreshold();
  saveSettings();
});
holdEl.addEventListener('input', () => {
  applyHold();
  saveSettings();
});
volumeEl.addEventListener('input', () => {
  applyVolume();
  saveSettings();
});
shareVolumeEl.addEventListener('input', () => {
  applyShareVolume();
  saveSettings();
});
shareQualityEl.addEventListener('change', async () => {
  saveSettings();
  if (localShareStream) {
    await applyQuality(localShareStream, shareQualityEl.value);
    await call?.setScreenBitrate(qualityFor(shareQualityEl.value).maxBitrate);
  }
});

loadSettings();

// Auto-join when the URL carries a full invite (?room=<id>#<secret>):
// the lobby is skipped entirely. The secret lives in the fragment and is
// never sent to the server.
const invite = parseInvite(location.href);
if (invite) {
  join(invite.roomId, invite.secret);
}

// --- Join / call lifecycle ---

// Extract { roomId, secret } from a URL, or null if it isn't a full invite.
// room id comes from ?room=; the 256-bit secret from the #fragment.
function parseInvite(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const roomId = new URLSearchParams(u.search).get('room')?.trim();
  const secret = u.hash.startsWith('#') ? u.hash.slice(1).trim() : '';
  return roomId && secret ? { roomId, secret } : null;
}

// Lobby button: paste an invite link to join, or leave empty to create a new
// encrypted room. A bare code can't carry a secret, so E2EE requires the link.
function onJoinClick() {
  if (joined) return;
  const val = roomInput.value.trim();
  if (!val) {
    const { roomId, roomSecret } = generateRoomCredentials();
    join(roomId, roomSecret);
    return;
  }
  const invite = parseInvite(val);
  if (invite) {
    join(invite.roomId, invite.secret);
    return;
  }
  hintEl.textContent = '請貼上完整邀請連結,或清空欄位以建立新的加密房間';
}

async function join(roomId, secretB64) {
  if (joined) return;
  if (!roomId || !secretB64) return;
  joined = true;
  hintEl.textContent = DEFAULT_HINT;

  const roomSecret = fromB64url(secretB64);
  const authKey = await deriveAuthKey(roomSecret);

  // Carry the full invite (id + fragment secret) in the URL so "copy link"
  // shares everything the peer needs, and a refresh rejoins the same room.
  history.replaceState(
    null,
    '',
    `${location.pathname}?room=${encodeURIComponent(roomId)}#${secretB64}`
  );

  lobby.hidden = true;
  callSection.hidden = false;
  showPanel();
  statusEl.textContent = '等待對方加入…';

  signaling = new SignalingChannel();
  signaling.setAuthKey(authKey);

  signaling.on('room-full', () => {
    endCall();
    hintEl.textContent = '❌ 房間已滿(僅限 2 人),請稍後再試';
  });

  // A failed MAC means the relay (or someone on the path) tampered with a
  // signaling message. room_secret authenticates every signal, so this should
  // never happen in a healthy call — treat it as a security event.
  signaling.on('auth-fail', () => {
    statusEl.textContent = '⛔ 偵測到訊息遭竄改,已中止連線';
    setChatEnabled(false);
  });

  signaling.on('joined', async ({ peerCount }) => {
    // Second joiner is the impolite peer (initiates the offer);
    // first joiner is polite. Required by perfect negotiation.
    const polite = peerCount === 1;

    gate = new NoiseGate();
    gate.onLevel = updateMeter;

    call = new VoiceCall(signaling, {
      polite,
      roomSecret,
      audioTransform: async (rawStream) => {
        const processed = await gate.process(rawStream);
        gate.setEnabled(gateEnabledEl.checked);
        gate.setThreshold(Number(thresholdEl.value));
        gate.setHoldMs(Number(holdEl.value));
        return processed;
      },
    });

    call.onChatReady = () => setChatEnabled(true);
    call.onChatMessage = (text) => appendChat(text, 'peer');
    call.onRemoteStream = (stream) => {
      remoteAudio.srcObject = stream;
      applyVolume();
    };
    call.onScreenStream = (stream) => {
      screenVideo.srcObject = stream;
      screenVideo.hidden = false;
      applyShareVolume();
      schedulePanelHide();
    };
    call.onScreenEnded = hideScreenVideo;
    call.onStateChange = (state) => {
      statusEl.textContent = STATE_TEXT[state] ?? state;
      if (state === 'connected' && !statsTimer) {
        statsTimer = setInterval(updateStats, 2000);
      }
    };

    try {
      await call.start();
    } catch (err) {
      statusEl.textContent = `❌ 無法取得麥克風:${err.message}`;
    }
  });

  signaling.on('peer-left', () => {
    statusEl.textContent = '對方已離開通話';
    statsEl.textContent = '';
    hideScreenVideo();
  });

  signaling.on('disconnected', () => {
    if (!callSection.hidden) statusEl.textContent = '⚠️ 信令伺服器連線中斷';
  });

  signaling.connect(roomId);
}

// Tear down the call and return to the lobby. The room input keeps
// the last room code, so rejoining the same room is one click away.
function endCall() {
  clearInterval(statsTimer);
  statsTimer = null;
  stopShare();
  call?.hangup();
  call = null;
  gate?.close();
  gate = null;
  signaling?.close();
  signaling = null;
  remoteAudio.srcObject = null;
  hideScreenVideo();
  setChatEnabled(false);
  chatLog.innerHTML = '';
  chatInput.value = '';
  statsEl.textContent = '';
  meterFill.style.width = '0%';
  gateStateEl.textContent = '';
  muted = false;
  muteIco.textContent = '🔇';
  muteLbl.textContent = '靜音';
  muteBtn.classList.remove('active');
  panelMore.hidden = true;
  panelChevron.classList.remove('up');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  callSection.hidden = true;
  lobby.hidden = false;
  joined = false;
}

// --- Screen share ---

async function toggleShare() {
  if (!call) return;
  if (localShareStream) {
    stopShare();
    return;
  }
  try {
    localShareStream = await captureScreen(shareQualityEl.value);
  } catch {
    return; // user cancelled the picker
  }
  // Browser's own "stop sharing" bar ends the track directly.
  localShareStream.getVideoTracks()[0].addEventListener('ended', stopShare);
  await call.startScreenShare(localShareStream, {
    maxBitrate: qualityFor(shareQualityEl.value).maxBitrate,
  });
  shareLbl.textContent = '停止';
  shareBtn.classList.add('active');
}

function stopShare() {
  if (!localShareStream) return;
  call?.stopScreenShare();
  for (const track of localShareStream.getTracks()) track.stop();
  localShareStream = null;
  shareLbl.textContent = '分享';
  shareBtn.classList.remove('active');
}

function hideScreenVideo() {
  screenVideo.srcObject = null;
  screenVideo.hidden = true;
  showPanel();
}

// --- Floating panel visibility ---

function showPanel() {
  panel.classList.remove('panel-hidden');
  schedulePanelHide();
}

// Auto-hide only while a shared screen is on display; otherwise the
// card is the whole UI and stays put.
function schedulePanelHide() {
  clearTimeout(panelHideTimer);
  if (screenVideo.hidden) return;
  panelHideTimer = setTimeout(
    () => panel.classList.add('panel-hidden'),
    PANEL_HIDE_MS
  );
}

// --- Settings ---

function applyThreshold() {
  const db = Number(thresholdEl.value);
  thresholdValEl.textContent = `${db} dB`;
  const pct = ((db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
  meterMarker.style.left = `${pct}%`;
  gate?.setThreshold(db);
}

function applyHold() {
  const ms = Number(holdEl.value);
  holdValEl.textContent = `${ms} ms`;
  gate?.setHoldMs(ms);
}

function applyVolume() {
  const pct = Number(volumeEl.value);
  volumeValEl.textContent = `${pct}%`;
  remoteAudio.volume = pct / 100;
}

function applyShareVolume() {
  const pct = Number(shareVolumeEl.value);
  shareVolumeValEl.textContent = `${pct}%`;
  screenVideo.volume = pct / 100;
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      gateEnabled: gateEnabledEl.checked,
      threshold: thresholdEl.value,
      hold: holdEl.value,
      volume: volumeEl.value,
      shareVolume: shareVolumeEl.value,
      shareQuality: shareQualityEl.value,
    })
  );
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved) {
      gateEnabledEl.checked = saved.gateEnabled ?? true;
      thresholdEl.value = saved.threshold ?? -60;
      holdEl.value = saved.hold ?? 500;
      volumeEl.value = saved.volume ?? 100;
      shareVolumeEl.value = saved.shareVolume ?? 100;
      shareQualityEl.value = saved.shareQuality ?? '1080';
    }
  } catch {
    // Corrupt settings: fall back to defaults.
  }
  applyThreshold();
  applyHold();
  applyVolume();
  applyShareVolume();
}

// --- Live indicators ---

function updateMeter({ db, gateOpen }) {
  const clamped = Math.min(Math.max(db, METER_MIN_DB), METER_MAX_DB);
  const pct = ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
  meterFill.style.width = `${pct}%`;
  meterFill.classList.toggle('open', gateOpen);
  gateStateEl.textContent = gateEnabledEl.checked
    ? gateOpen ? '🟢 傳送中' : '⚪ 已閘除'
    : '';
}

async function updateStats() {
  const stats = await call?.getStats();
  if (!stats || stats.rtt == null) return;
  const route = stats.relayed ? 'TURN 中繼' : 'P2P 直連';
  statsEl.textContent = `延遲 ${stats.rtt} ms ・ ${route}`;
}

function toggleMute() {
  muted = !muted;
  call?.setMuted(muted);
  muteIco.textContent = muted ? '🎤' : '🔇';
  muteLbl.textContent = muted ? '解除' : '靜音';
  muteBtn.classList.toggle('active', muted);
}

// --- Encrypted chat ---

function setChatEnabled(on) {
  chatInput.disabled = !on;
  chatSend.disabled = !on;
  chatStatus.textContent = on ? '🔒 端到端加密' : '建立加密通道中…';
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !call) return;
  const sent = await call.sendChat(text);
  if (sent) {
    appendChat(text, 'me');
    chatInput.value = '';
  }
}

function appendChat(text, who) {
  const line = document.createElement('div');
  line.className = `chat-msg ${who}`;
  line.textContent = text;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}
