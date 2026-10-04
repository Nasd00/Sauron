/**
 * xAI Grok Voice Agent transport.
 *
 * xAI speaks the OpenAI Realtime event protocol over a WebSocket rather than
 * WebRTC, so the browser must stream microphone PCM itself and play the
 * returned PCM itself. Everything above the transport (turns, tools, cost,
 * radio handoff) keeps working because this module hands the controller a
 * data-channel-shaped object: `readyState` strings, `send(json)`, `close()`,
 * and open/message/error/close events. Audio deltas are consumed here and
 * never reach the turn handler.
 *
 * @module voice/xaiTransport
 */

export const XAI_DEFAULT_URL = 'wss://api.x.ai/v1/realtime';
export const XAI_PCM_RATE = 24000;
/** ~100 ms of 24 kHz audio per append, as xAI recommends. */
const INPUT_CHUNK_SAMPLES = 2400;
/** Room reverb after playback ends that must not count as user speech. */
const ECHO_TAIL_SECONDS = 0.35;
const AUDIO_DELTA_TYPES = new Set([
  'response.output_audio.delta',
  'response.audio.delta',
]);
const SOCKET_STATES = ['connecting', 'open', 'closing', 'closed'];

/** Streaming linear resampler from Float32 at `inRate` to PCM16 at `outRate`. */
export class Pcm16Resampler {
  constructor(inRate, outRate = XAI_PCM_RATE) {
    this.step = inRate / outRate;
    this.position = 0; // fractional read position into `carry + input`
    this.carry = new Float32Array(0);
  }
  push(input) {
    const source = new Float32Array(this.carry.length + input.length);
    source.set(this.carry);
    source.set(input, this.carry.length);
    const out = [];
    let position = this.position;
    while (position + 1 < source.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const sample =
        source[index] + (source[index + 1] - source[index]) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      out.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      position += this.step;
    }
    const keepFrom = Math.floor(position);
    this.carry = source.slice(keepFrom);
    this.position = position - keepFrom;
    return Int16Array.from(out);
  }
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToPcm16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length - (binary.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function pcm16ToFloat32(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

/** Build the authenticated socket URL; refuses anything but wss://. */
export function xaiSocketUrl({ url = XAI_DEFAULT_URL, model } = {}) {
  const target = new URL(url || XAI_DEFAULT_URL);
  if (target.protocol !== 'wss:')
    throw new Error('xAI Realtime URL must use wss://');
  if (model) target.searchParams.set('model', model);
  return target.toString();
}

const CAPTURE_WORKLET = `
class IrisPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('iris-pcm-capture', IrisPcmCapture);
`;

/**
 * Pull mono Float32 frames from a MediaStream. Prefers an AudioWorklet loaded
 * from a blob: URL (allowed by the app's script-src) and falls back to the
 * deprecated ScriptProcessorNode where worklets are unavailable.
 */
async function startCapture(context, stream, onFrame) {
  const source = context.createMediaStreamSource(stream);
  // Capture nodes must reach the graph's destination to be pulled; a muted
  // gain keeps the microphone out of the speakers.
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);
  if (context.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      const moduleUrl = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
      );
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const node = new AudioWorkletNode(context, 'iris-pcm-capture');
      node.port.onmessage = (event) => onFrame(event.data);
      source.connect(node);
      node.connect(sink);
      return () => {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
      };
    } catch {
      /* fall through to ScriptProcessorNode */
    }
  }
  const processor = context.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) =>
    onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(sink);
  return () => {
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
  };
}

/**
 * Gapless scheduled playback of 24 kHz PCM16 chunks, flushable on barge-in.
 *
 * Output is routed through a MediaStream into an <audio> element when the
 * browser allows it, the same path the WebRTC (OpenAI) session plays through.
 * Chrome's echo canceller reliably subtracts media-element output from the
 * microphone, but not Web Audio sent straight to the speakers; without this
 * the assistant hears itself and server VAD cancels its own reply.
 */
export class PcmPlayer {
  constructor(context, rate = XAI_PCM_RATE, { createAudioElement } = {}) {
    this.context = context;
    this.rate = rate;
    this.output = context.createGain();
    this.stream = null;
    this.element = null;
    if (typeof context.createMediaStreamDestination === 'function') {
      const tap = context.createMediaStreamDestination();
      this.output.connect(tap);
      this.stream = tap.stream;
      this.element = createAudioElement?.(tap.stream) || null;
    }
    // No media element: fall back to direct Web Audio output.
    if (!this.element) this.output.connect(context.destination);
    this.sources = new Set();
    this.nextTime = 0;
  }
  enqueue(pcm) {
    if (!pcm.length) return;
    const buffer = this.context.createBuffer(1, pcm.length, this.rate);
    buffer.getChannelData(0).set(pcm16ToFloat32(pcm));
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.output);
    const startAt = Math.max(this.context.currentTime, this.nextTime);
    node.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
  }
  get playing() {
    return this.sources.size > 0;
  }
  /** True while assistant audio is audible, plus `tailSeconds` of room echo. */
  isAudible(tailSeconds = 0) {
    return (
      this.sources.size > 0 ||
      (this.nextTime > 0 &&
        this.context.currentTime < this.nextTime + tailSeconds)
    );
  }
  flush() {
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
  }
  close() {
    this.flush();
    if (this.element) {
      try {
        this.element.pause();
        this.element.srcObject = null;
        this.element.remove?.();
      } catch {
        /* no-op */
      }
      this.element = null;
    }
  }
}

/** Play a MediaStream through a hidden autoplaying <audio> element. */
function createPlaybackElement(stream) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  try {
    document
      .querySelectorAll?.('audio[data-iris-realtime-audio="true"]')
      .forEach((el) => el.remove());
    const element = document.createElement('audio');
    element.autoplay = true;
    element.dataset.irisRealtimeAudio = 'true';
    element.style.display = 'none';
    element.srcObject = stream;
    document.body?.appendChild?.(element);
    element.play?.()?.catch?.(() => {});
    return element;
  } catch {
    return null;
  }
}

/** Data-channel-shaped wrapper over the xAI socket. */
class SocketChannel extends EventTarget {
  constructor(socket) {
    super();
    this.socket = socket;
    this.label = 'xai-realtime';
    this.supportsImageInput = false;
  }
  get readyState() {
    return SOCKET_STATES[this.socket.readyState] || 'closed';
  }
  send(message) {
    this.socket.send(message);
  }
  close() {
    this.socket.close();
  }
}

/**
 * Open an xAI Realtime session for one controller connect attempt.
 *
 * `credential` is what the token endpoint returned: {token, model, url,
 * session}. The returned object stands in for an RTCPeerConnection on the
 * controller (`close()`, `connectionState`) and exposes `channel` as its data
 * channel. Every resource it acquires is released by `close()`, which is
 * idempotent; the microphone tracks stay owned by the caller.
 */
export function createXaiRealtimeSession({
  credential,
  stream,
  WebSocketImpl = globalThis.WebSocket,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  onRemoteStream,
  onCaptureError,
  allowBargeIn,
}) {
  if (typeof WebSocketImpl !== 'function')
    throw new Error('WebSocket support unavailable');
  if (typeof AudioContextImpl !== 'function')
    throw new Error('Web Audio support unavailable');
  const socket = new WebSocketImpl(
    xaiSocketUrl({ url: credential.url, model: credential.model }),
    [`xai-client-secret.${credential.token}`],
  );
  socket.binaryType = 'arraybuffer';
  const channel = new SocketChannel(socket);
  const inputContext = new AudioContextImpl();
  const outputContext = new AudioContextImpl();
  const player = new PcmPlayer(outputContext, XAI_PCM_RATE, {
    createAudioElement: createPlaybackElement,
  });
  const resampler = new Pcm16Resampler(inputContext.sampleRate);
  let pending = [];
  let pendingLength = 0;
  let stopCapture = null;
  let closed = false;
  let state = 'connecting';

  const micEnabled = () =>
    (stream?.getAudioTracks?.() || []).some((track) => track.enabled);
  const sendAudio = (pcm) => {
    if (socket.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: bytesToBase64(new Uint8Array(pcm.buffer)),
      }),
    );
  };
  const onFrame = (frame) => {
    if (closed) return;
    // Push-to-talk mutes tracks; skip silent frames rather than streaming
    // zeros (keeps server VAD and bandwidth idle while the key is up).
    if (!micEnabled()) {
      pending = [];
      pendingLength = 0;
      return;
    }
    // Half-duplex while the assistant is audible, matching the OpenAI
    // session's `interrupt_response: false`. xAI ignores that setting, so
    // its server VAD would hear the assistant through the speakers, treat it
    // as the user barging in, and cancel the reply after a fraction of a
    // second. Holding push-to-talk is an explicit interruption and passes.
    if (player.isAudible(ECHO_TAIL_SECONDS)) {
      if (!allowBargeIn?.()) {
        pending = [];
        pendingLength = 0;
        return;
      }
      player.flush();
    }
    const pcm = resampler.push(frame);
    pending.push(pcm);
    pendingLength += pcm.length;
    if (pendingLength < INPUT_CHUNK_SAMPLES) return;
    const chunk = new Int16Array(pendingLength);
    let offset = 0;
    for (const part of pending) {
      chunk.set(part, offset);
      offset += part.length;
    }
    pending = [];
    pendingLength = 0;
    sendAudio(chunk);
  };

  const forward = (data) =>
    channel.dispatchEvent(new MessageEvent('message', { data }));
  socket.addEventListener('open', () => {
    if (closed) return;
    state = 'connected';
    if (credential.session) {
      socket.send(
        JSON.stringify({ type: 'session.update', session: credential.session }),
      );
    }
    inputContext.resume?.().catch?.(() => {});
    outputContext.resume?.().catch?.(() => {});
    startCapture(inputContext, stream, onFrame).then(
      (stop) => {
        if (closed) stop();
        else stopCapture = stop;
      },
      (error) => onCaptureError?.(error),
    );
    if (player.stream) onRemoteStream?.(player.stream);
    channel.dispatchEvent(new Event('open'));
  });
  socket.addEventListener('message', (event) => {
    if (closed) return;
    if (typeof event.data !== 'string') {
      // Binary output transport: raw PCM16 frames.
      player.enqueue(new Int16Array(event.data));
      return;
    }
    let type = null;
    let payload = null;
    try {
      payload = JSON.parse(event.data);
      type = payload?.type;
    } catch {
      return;
    }
    if (AUDIO_DELTA_TYPES.has(type)) {
      if (typeof payload.delta === 'string')
        player.enqueue(base64ToPcm16(payload.delta));
      return;
    }
    // Barge-in: the user started talking, drop whatever is still queued.
    if (type === 'input_audio_buffer.speech_started') player.flush();
    forward(event.data);
  });
  socket.addEventListener('error', () => {
    if (closed) return;
    state = 'failed';
    channel.dispatchEvent(new Event('error'));
  });
  socket.addEventListener('close', (event) => {
    if (!closed) state = 'closed';
    channel.dispatchEvent(
      Object.assign(new Event('close'), {
        code: event?.code,
        reason: event?.reason,
      }),
    );
  });

  return {
    channel,
    player,
    get connectionState() {
      return state;
    },
    close() {
      if (closed) return;
      closed = true;
      state = 'closed';
      stopCapture?.();
      stopCapture = null;
      player.close();
      try {
        socket.close();
      } catch {
        /* no-op */
      }
      inputContext.close?.().catch?.(() => {});
      outputContext.close?.().catch?.(() => {});
    },
  };
}
