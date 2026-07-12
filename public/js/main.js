// UI wiring only — call logic lives in call.js, transport in signaling.js,
// mic processing in noise-gate.js, screen capture in screen-share.js.
import { SignalingChannel } from './signaling.js';
import { VoiceCall } from './call.js';
import { NoiseGate } from './noise-gate.js';
import { captureScreen, applyQuality, qualityFor } from './screen-share.js';

const lobby = document.getElementById('lobby');
const callSection = document.getElementById('call');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const hintEl = document.querySelector('.hint');

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
const DEFAULT_HINT = '兩人輸入相同的房間代碼即可通話,或直接開啟含房號的連結';

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

joinBtn.addEventListener('click', join);
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
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

// Auto-join when the URL carries a room code (?room=xxx):
// the lobby is skipped entirely.
const urlRoom = new URLSearchParams(location.search).get('room')?.trim();
if (urlRoom) {
  roomInput.value = urlRoom;
  join();
}

// --- Join / call lifecycle ---

async function join() {
  if (joined) return;
  const room = roomInput.value.trim();
  if (!room) return;
  joined = true;
  hintEl.textContent = DEFAULT_HINT;

  // Carry the room code in the URL so the link can be shared and
  // a refresh rejoins the same room.
  history.replaceState(null, '', `${location.pathname}?room=${encodeURIComponent(room)}`);

  lobby.hidden = true;
  callSection.hidden = false;
  showPanel();
  statusEl.textContent = '等待對方加入…';

  signaling = new SignalingChannel();

  signaling.on('room-full', () => {
    endCall();
    hintEl.textContent = '❌ 房間已滿(僅限 2 人),請稍後再試';
  });

  signaling.on('joined', async ({ peerCount }) => {
    // Second joiner is the impolite peer (initiates the offer);
    // first joiner is polite. Required by perfect negotiation.
    const polite = peerCount === 1;

    gate = new NoiseGate();
    gate.onLevel = updateMeter;

    call = new VoiceCall(signaling, {
      polite,
      audioTransform: async (rawStream) => {
        const processed = await gate.process(rawStream);
        gate.setEnabled(gateEnabledEl.checked);
        gate.setThreshold(Number(thresholdEl.value));
        gate.setHoldMs(Number(holdEl.value));
        return processed;
      },
    });

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

  signaling.connect(room);
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
