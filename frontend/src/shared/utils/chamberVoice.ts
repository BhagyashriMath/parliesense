/**
 * chamberVoice.ts
 *
 * Real-voice audio broadcast for the parliamentary chamber.
 *
 * SENDER side (active mic holder):
 *   - Captures microphone via getUserMedia
 *   - Encodes raw PCM chunks with ScriptProcessorNode (float32 → Int16 PCM)
 *   - Streams binary chunks directly to backend /ws/audio as the "sender"
 *
 * LISTENER side (everyone else):
 *   - Connects to /ws/audio as a "listener"
 *   - Receives binary PCM chunks
 *   - Decodes and plays them through Web Audio API in real time
 *
 * No TTS, no AI voice — purely the original microphone audio.
 */

import { API_BASE } from "../../infrastructure/api/api";

function getAudioWsUrl(): string {
  if (API_BASE) {
    try {
      const u = new URL(API_BASE);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      u.pathname = "/ws/audio";
      return u.toString();
    } catch (_) {}
  }
  const proto = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    // Connect directly to backend port 3000 on localhost or across Wi-Fi LAN
    return `${proto}//${host}:3000/ws/audio`;
  }
  return `${proto}//localhost:3000/ws/audio`;
}

// User-interaction helper to unlock audio context in Chrome/Edge
if (typeof window !== "undefined") {
  const unlockAudio = () => {
    if (listenerCtx && listenerCtx.state === "suspended") {
      listenerCtx.resume().catch(() => {});
    }
    if (senderCtx && senderCtx.state === "suspended") {
      senderCtx.resume().catch(() => {});
    }
  };
  window.addEventListener("click", unlockAudio, { passive: true });
  window.addEventListener("keydown", unlockAudio, { passive: true });
  window.addEventListener("touchstart", unlockAudio, { passive: true });
}

/* ── SENDER ────────────────────────────────────────────────────────── */

let senderWs: WebSocket | null = null;
let senderStream: MediaStream | null = null;
let senderCtx: AudioContext | null = null;
let senderProcessor: ScriptProcessorNode | null = null;
let isSending = false;

export async function startVoiceSend(): Promise<void> {
  if (isSending || (senderWs && senderWs.readyState === WebSocket.OPEN)) return;
  isSending = true;

  try {
    senderStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.warn("[ChamberVoice] Mic access denied:", err);
    isSending = false;
    return;
  }

  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    senderCtx = new AudioCtx();
    if (senderCtx.state === "suspended") {
      await senderCtx.resume().catch(() => {});
    }

    const source = senderCtx.createMediaStreamSource(senderStream);
    const nativeSampleRate = senderCtx.sampleRate || 48000;
    // 2048 samples gives ultra-low latency (~42ms) floor conversation
    senderProcessor = senderCtx.createScriptProcessor(2048, 1, 1);

    senderWs = new WebSocket(getAudioWsUrl());
    senderWs.binaryType = "arraybuffer";

    senderWs.onopen = () => {
      console.log(`[ChamberVoice] Sender WS connected (sample rate: ${nativeSampleRate} Hz)`);
      senderWs!.send(JSON.stringify({ type: "register", role: "sender", sampleRate: nativeSampleRate }));

      senderProcessor!.onaudioprocess = (e) => {
        if (!senderWs || senderWs.readyState !== WebSocket.OPEN) return;
        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 PCM → Int16 PCM (half bandwidth)
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        senderWs!.send(int16.buffer);
      };

      source.connect(senderProcessor!);
      // Use 0.000001 (-120dB) gain instead of 0 to prevent Chrome from optimizing out onaudioprocess
      const silentGain = senderCtx!.createGain();
      silentGain.gain.setValueAtTime(0.000001, senderCtx!.currentTime);
      senderProcessor!.connect(silentGain);
      silentGain.connect(senderCtx!.destination);
      console.log("[ChamberVoice] Sender broadcasting real microphone voice");
    };

    senderWs.onerror = (e) => {
      console.warn("[ChamberVoice] Sender WS error:", e);
    };

    senderWs.onclose = () => {
      console.log("[ChamberVoice] Sender WS closed");
    };
  } catch (err) {
    console.warn("[ChamberVoice] Failed to start voice sender:", err);
    stopVoiceSend();
  }
}

export function stopVoiceSend(): void {
  isSending = false;
  try { senderProcessor?.disconnect(); } catch (_) {}
  try { senderCtx?.close(); } catch (_) {}
  try { senderStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { senderWs?.close(); } catch (_) {}
  senderProcessor = null;
  senderCtx = null;
  senderStream = null;
  senderWs = null;
  console.log("[ChamberVoice] Sender stopped");
}

/* ── LISTENER ──────────────────────────────────────────────────────── */

let listenerWs: WebSocket | null = null;
let listenerCtx: AudioContext | null = null;
let listenerGain: GainNode | null = null;
let nextPlayTime = 0;
let isListening = false;
let listenerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const SAMPLE_RATE = 16000;
const BUFFER_AHEAD = 0.08; // 80 ms jitter look-ahead

export function startVoiceListen(): void {
  if (isListening || (listenerWs && (listenerWs.readyState === WebSocket.OPEN || listenerWs.readyState === WebSocket.CONNECTING))) {
    return;
  }
  isListening = true;

  if (listenerReconnectTimer) {
    clearTimeout(listenerReconnectTimer);
    listenerReconnectTimer = null;
  }

  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!listenerCtx || listenerCtx.state === "closed") {
    listenerCtx = new AudioCtx();
  }

  if (listenerCtx.state === "suspended") {
    listenerCtx.resume().catch(() => {});
  }

  listenerGain = listenerCtx.createGain();
  listenerGain.gain.value = 2.0; // Clear, amplified floor voice so it is easily heard through headphones/speakers
  listenerGain.connect(listenerCtx.destination);

  nextPlayTime = listenerCtx.currentTime + BUFFER_AHEAD;

  try {
    listenerWs = new WebSocket(getAudioWsUrl());
    listenerWs.binaryType = "arraybuffer";

    listenerWs.onopen = () => {
      console.log("[ChamberVoice] Listener connected — ready to receive live floor voice");
      listenerWs!.send(JSON.stringify({ type: "register", role: "listener" }));
    };

    listenerWs.onmessage = async (event) => {
      let buffer: ArrayBuffer;
      if (event.data instanceof ArrayBuffer) {
        buffer = event.data;
      } else if (event.data instanceof Blob) {
        buffer = await event.data.arrayBuffer();
      } else {
        return;
      }

      if (!listenerCtx || listenerCtx.state === "closed") {
        listenerCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      if (listenerCtx.state === "suspended") {
        try { await listenerCtx.resume(); } catch (_) {}
      }

      // Decode Int16 PCM back to Float32
      const int16 = new Int16Array(buffer);
      if (int16.length === 0) return;

      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
      }

      const nativeRate = listenerCtx.sampleRate || 48000;
      const audioBuffer = listenerCtx.createBuffer(1, float32.length, nativeRate);
      audioBuffer.copyToChannel(float32, 0);

      const source = listenerCtx.createBufferSource();
      source.buffer = audioBuffer;
      if (listenerGain) {
        source.connect(listenerGain);
      } else {
        source.connect(listenerCtx.destination);
      }

      const now = listenerCtx.currentTime;
      // If we fall behind or drift ahead more than 250ms, re-synchronize
      if (nextPlayTime < now || nextPlayTime > now + 0.25) {
        nextPlayTime = now + BUFFER_AHEAD;
      }

      source.start(nextPlayTime);
      nextPlayTime += audioBuffer.duration;
    };

    listenerWs.onerror = () => {
      // Reconnect if listening was active
      scheduleListenerReconnect();
    };

    listenerWs.onclose = () => {
      scheduleListenerReconnect();
    };
  } catch (err) {
    console.warn("[ChamberVoice] Listener connection failed:", err);
    scheduleListenerReconnect();
  }
}

function scheduleListenerReconnect(): void {
  if (!isListening) return;
  if (listenerWs) {
    try { listenerWs.close(); } catch (_) {}
    listenerWs = null;
  }
  if (!listenerReconnectTimer) {
    listenerReconnectTimer = setTimeout(() => {
      listenerReconnectTimer = null;
      if (isListening) {
        startVoiceListen();
      }
    }, 2000);
  }
}

export function stopVoiceListen(): void {
  isListening = false;
  if (listenerReconnectTimer) {
    clearTimeout(listenerReconnectTimer);
    listenerReconnectTimer = null;
  }
  try { listenerWs?.close(); } catch (_) {}
  try { listenerGain?.disconnect(); } catch (_) {}
  try { listenerCtx?.close(); } catch (_) {}
  listenerWs = null;
  listenerCtx = null;
  listenerGain = null;
  nextPlayTime = 0;
  console.log("[ChamberVoice] Listener stopped");
}
