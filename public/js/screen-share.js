// Screen capture helper. The user picks a target resolution; voice
// smoothness is guaranteed independently in call.js (voice track gets
// high network priority, screen video is bitrate-capped + low priority).
// The browser's own picker still chooses window / full screen / tab and
// whether to share system audio.

const QUALITY = {
  '720': { width: 1280, height: 720, maxBitrate: 1_500_000 },
  '1080': { width: 1920, height: 1080, maxBitrate: 2_500_000 },
  '1440': { width: 2560, height: 1440, maxBitrate: 4_000_000 },
};

const DEFAULT_QUALITY = '1080';

export function qualityFor(key) {
  return QUALITY[key] ?? QUALITY[DEFAULT_QUALITY];
}

export async function captureScreen(quality) {
  const q = qualityFor(quality);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: q.width, max: q.width },
      height: { ideal: q.height, max: q.height },
      frameRate: { ideal: 30, max: 30 },
    },
    // Delivered only if the user ticks "share audio" in the picker.
    // Voice-style processing would mangle system audio, so disable it.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  await applyQuality(stream, quality);
  for (const track of stream.getAudioTracks()) {
    track.contentHint = 'music';
  }
  return stream;
}

// Also used to switch resolution live while already sharing.
export async function applyQuality(stream, quality) {
  const q = qualityFor(quality);
  for (const track of stream.getVideoTracks()) {
    track.contentHint = 'detail';
    try {
      await track.applyConstraints({
        width: { max: q.width },
        height: { max: q.height },
        frameRate: { max: 30 },
      });
    } catch {
      // Some sources reject live constraint changes; capture still works.
    }
  }
}
