// Camera/microphone capture. Screen capture and quality presets come with the next milestone.

export const CAMERA_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export async function getMicTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  return stream.getAudioTracks()[0];
}

export async function getCameraTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS });
  return stream.getVideoTracks()[0];
}

/**
 * Opens microphone and camera, degrading gracefully: a missing or denied device just leaves
 * that track null (the call still works, receive-only for that kind).
 * @returns {Promise<{ audio: MediaStreamTrack | null, video: MediaStreamTrack | null, errors: Record<string, string> }>}
 */
export async function openLocalMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { audio: null, video: null, errors: { audio: 'unsupported', video: 'unsupported' } };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: CAMERA_CONSTRAINTS });
    return { audio: stream.getAudioTracks()[0] ?? null, video: stream.getVideoTracks()[0] ?? null, errors: {} };
  } catch {
    // One device failed (or the user denied one): try each separately.
    const [audio, video] = await Promise.allSettled([getMicTrack(), getCameraTrack()]);
    return {
      audio: audio.status === 'fulfilled' ? audio.value : null,
      video: video.status === 'fulfilled' ? video.value : null,
      errors: {
        ...(audio.status === 'rejected' ? { audio: audio.reason?.name ?? 'Error' } : {}),
        ...(video.status === 'rejected' ? { video: video.reason?.name ?? 'Error' } : {}),
      },
    };
  }
}
