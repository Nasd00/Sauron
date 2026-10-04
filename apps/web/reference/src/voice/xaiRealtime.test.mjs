import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PcmPlayer,
  Pcm16Resampler,
  base64ToPcm16,
  bytesToBase64,
  createXaiRealtimeSession,
  xaiSocketUrl,
} from './xaiTransport.js';
import { createRealtimeBackend } from './realtimeBackend.js';
import { IrisRealtimeController } from './realtimeController.js';
import {
  createXaiRealtimeTokenHandler,
  resolveVoiceProvider,
  xaiSessionConfig,
} from '../../server/providers/xai/realtime.js';

/* ---------------- fakes ---------------- */

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 }));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  serverSend(payload) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(payload) }),
    );
  }
}

class FakeAudioContext {
  static instances = [];
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = {};
    this.started = [];
    this.closed = false;
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    this.processor = { connect() {}, disconnect() {} };
    return this.processor;
  }
  createBuffer(_channels, length, rate) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const context = this;
    return {
      connect() {},
      start(at) {
        context.started.push(this);
        this.at = at;
      },
      stop() {
        this.stopped = true;
      },
    };
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
}

function micStream(enabled = true) {
  const track = { enabled, stop() {} };
  return { getAudioTracks: () => [track], getTracks: () => [track], track };
}

function openSession(options = {}) {
  FakeSocket.instances = [];
  FakeAudioContext.instances = [];
  const session = createXaiRealtimeSession({
    credential: {
      token: 'secret-123',
      model: 'grok-voice-latest',
      url: 'wss://api.x.ai/v1/realtime',
      session: { voice: 'eve' },
    },
    stream: micStream(),
    WebSocketImpl: FakeSocket,
    AudioContextImpl: FakeAudioContext,
    ...options,
  });
  return { session, socket: FakeSocket.instances[0] };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ---------------- pure helpers ---------------- */

test('resampler converts 48 kHz float frames to half as many 24 kHz PCM16 samples across chunks', () => {
  const resampler = new Pcm16Resampler(48000, 24000);
  let total = 0;
  for (let i = 0; i < 10; i++)
    total += resampler.push(new Float32Array(480).fill(0.5)).length;
  assert.ok(Math.abs(total - 2400) <= 1, `got ${total}`);
  const loud = new Pcm16Resampler(24000, 24000).push(
    Float32Array.from([2, -2, 0]),
  );
  assert.deepEqual([...loud], [0x7fff, -0x8000]);
});

test('base64 PCM round-trips', () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
  assert.deepEqual(
    [...base64ToPcm16(bytesToBase64(new Uint8Array(pcm.buffer)))],
    [...pcm],
  );
});

test('socket URL keeps wss:// only and carries the model', () => {
  assert.equal(
    xaiSocketUrl({ model: 'grok-voice-latest' }),
    'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
  );
  assert.throws(() => xaiSocketUrl({ url: 'http://evil.example/' }), /wss/);
});

/* ---------------- transport ---------------- */

test('session authenticates with the client-secret subprotocol and applies session.update on open', async () => {
  const { session, socket } = openSession();
  assert.deepEqual(socket.protocols, ['xai-client-secret.secret-123']);
  assert.equal(session.channel.readyState, 'connecting');
  let opened = false;
  session.channel.addEventListener('open', () => (opened = true));
  socket.open();
  await tick();
  assert.equal(opened, true);
  assert.equal(session.channel.readyState, 'open');
  assert.equal(session.channel.supportsImageInput, false);
  assert.deepEqual(socket.sent[0], {
    type: 'session.update',
    session: { voice: 'eve' },
  });
  session.close();
});

test('microphone frames stream as ~100 ms base64 appends, and muted push-to-talk frames are dropped', async () => {
  const stream = micStream();
  const { session, socket } = openSession({ stream });
  socket.open();
  await tick();
  const processor = FakeAudioContext.instances[0].processor;
  const frame = (n) =>
    processor.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array(n).fill(0.1) },
    });
  frame(2048);
  frame(2048);
  frame(2048);
  const appends = socket.sent.filter(
    (m) => m.type === 'input_audio_buffer.append',
  );
  assert.equal(appends.length, 1);
  assert.ok(base64ToPcm16(appends[0].audio).length >= 2400);
  stream.track.enabled = false;
  for (let i = 0; i < 10; i++) frame(2048);
  assert.equal(
    socket.sent.filter((m) => m.type === 'input_audio_buffer.append').length,
    1,
  );
  session.close();
});

test('audio deltas play locally and never reach the event channel; barge-in flushes playback', async () => {
  const { session, socket } = openSession();
  const forwarded = [];
  session.channel.addEventListener('message', (event) =>
    forwarded.push(JSON.parse(event.data).type),
  );
  socket.open();
  await tick();
  const output = FakeAudioContext.instances[1];
  const delta = bytesToBase64(new Uint8Array(new Int16Array(480).buffer));
  socket.serverSend({ type: 'response.output_audio.delta', delta });
  socket.serverSend({ type: 'response.output_audio.delta', delta });
  assert.equal(output.started.length, 2);
  assert.ok(output.started[1].at > output.started[0].at, 'gapless schedule');
  socket.serverSend({ type: 'response.function_call_arguments.done' });
  socket.serverSend({ type: 'input_audio_buffer.speech_started' });
  assert.ok(output.started.every((node) => node.stopped));
  assert.deepEqual(forwarded, [
    'response.function_call_arguments.done',
    'input_audio_buffer.speech_started',
  ]);
  session.close();
});

test('close() is idempotent and releases socket and audio contexts', async () => {
  const { session, socket } = openSession();
  socket.open();
  await tick();
  session.close();
  session.close();
  assert.equal(socket.readyState, 3);
  assert.equal(session.connectionState, 'closed');
  assert.ok(FakeAudioContext.instances.every((context) => context.closed));
});

/* ---------------- backend + controller ---------------- */

test('microphone is gated while the assistant is audible unless push-to-talk is held', async () => {
  let held = false;
  const { session, socket } = openSession({ allowBargeIn: () => held });
  socket.open();
  await tick();
  const processor = FakeAudioContext.instances[0].processor;
  const output = FakeAudioContext.instances[1];
  const frames = (count) => {
    for (let i = 0; i < count; i++)
      processor.onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) },
      });
  };
  const appends = () =>
    socket.sent.filter((m) => m.type === 'input_audio_buffer.append').length;
  // 1 s of assistant audio is now scheduled.
  socket.serverSend({
    type: 'response.output_audio.delta',
    delta: bytesToBase64(new Uint8Array(new Int16Array(24000).buffer)),
  });
  frames(10);
  assert.equal(appends(), 0, 'assistant echo never reaches the server');
  held = true;
  frames(3);
  assert.equal(appends(), 1, 'holding push-to-talk barges in');
  assert.ok(output.started.every((node) => node.stopped));
  // Playback over (+ echo tail): the mic streams normally again.
  held = false;
  output.currentTime = 5;
  frames(3);
  assert.equal(appends(), 2);
  session.close();
});

test('assistant audio plays through an <audio> element so browser echo cancellation applies', () => {
  const context = new FakeAudioContext();
  context.createMediaStreamDestination = () => ({ stream: { id: 'tap' } });
  const connected = [];
  context.createGain = () => ({
    gain: { value: 1 },
    connect: (target) => connected.push(target),
  });
  const element = {
    paused: false,
    pause() {
      this.paused = true;
    },
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  const player = new PcmPlayer(context, 24000, {
    createAudioElement: (stream) => {
      element.srcObject = stream;
      return element;
    },
  });
  assert.equal(element.srcObject.id, 'tap');
  assert.equal(
    connected.includes(context.destination),
    false,
    'no direct speaker path that bypasses echo cancellation',
  );
  player.close();
  assert.equal(element.paused && element.removed, true);
  const fallback = new PcmPlayer(new FakeAudioContext());
  assert.equal(fallback.element, null);
});

test('backend surfaces the xAI provider, session config, and socket URL from the token reply', async () => {
  const backend = createRealtimeBackend({
    tokenTransport: async () =>
      Response.json(
        {
          provider: 'xai',
          value: 'xai-secret',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          model: 'grok-voice-latest',
          url: 'wss://api.x.ai/v1/realtime',
          session: { voice: 'eve' },
        },
        { headers: { 'X-IRIS-Voice-Provider': 'xai' } },
      ),
  });
  const minted = await backend.requestToken();
  assert.equal(minted.provider, 'xai');
  assert.equal(minted.token, 'xai-secret');
  assert.equal(minted.model, 'grok-voice-latest');
  assert.deepEqual(minted.session, { voice: 'eve' });
  assert.equal(minted.url, 'wss://api.x.ai/v1/realtime');
});

function installGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
}

test('controller runs an xAI session without WebRTC, executes tools over the socket, and tears down', async (t) => {
  const stream = micStream();
  installGlobals(t, {
    window: {},
    document: {
      querySelectorAll: () => [],
      body: { appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
  });
  const sessions = [];
  const actions = [];
  const controller = new IrisRealtimeController({
    runner: async (name, args) => {
      actions.push([name, args]);
      return { ok: true, action: name };
    },
    backend: {
      async requestToken() {
        return {
          provider: 'xai',
          token: 'xai-secret',
          model: 'grok-voice-latest',
          session: { voice: 'eve' },
        };
      },
      negotiate: () => assert.fail('xAI must not negotiate SDP'),
    },
    xaiSessionFactory: (options) => {
      const session = createXaiRealtimeSession({
        ...options,
        WebSocketImpl: FakeSocket,
        AudioContextImpl: FakeAudioContext,
      });
      sessions.push(session);
      return session;
    },
    debugSink: null,
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: {},
      detail: {},
    },
  });
  FakeSocket.instances = [];
  await controller.start();
  assert.equal(controller.status, 'connecting');
  const socket = FakeSocket.instances[0];
  socket.open();
  await tick();
  assert.equal(controller.status, 'listening');
  assert.equal(controller.dc, sessions[0].channel);

  socket.serverSend({
    type: 'response.function_call_arguments.done',
    name: 'fly_to_location',
    call_id: 'call_1',
    response_id: 'resp_1',
    arguments: JSON.stringify({ locationId: 'tokyo' }),
  });
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(actions, [['fly_to_location', { locationId: 'tokyo' }]]);
  const output = socket.sent.find(
    (m) =>
      m.type === 'conversation.item.create' &&
      m.item?.type === 'function_call_output',
  );
  assert.equal(output?.item.call_id, 'call_1');

  controller.stop();
  assert.equal(controller.status, 'idle');
  assert.equal(controller.dc, null);
  assert.equal(controller.pc, null);
  assert.equal(socket.readyState, 3);
});

test('an unexpected socket close tears the controller down to error', async (t) => {
  installGlobals(t, {
    window: {},
    document: { querySelectorAll: () => [], body: { appendChild() {} } },
    navigator: { mediaDevices: { getUserMedia: async () => micStream() } },
  });
  const controller = new IrisRealtimeController({
    runner: async () => ({ ok: true }),
    backend: {
      requestToken: async () => ({ provider: 'xai', token: 'x', model: 'm' }),
    },
    xaiSessionFactory: (options) =>
      createXaiRealtimeSession({
        ...options,
        WebSocketImpl: FakeSocket,
        AudioContextImpl: FakeAudioContext,
      }),
    debugSink: null,
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: {},
      detail: {},
    },
  });
  t.mock.method(console, 'error', () => {});
  FakeSocket.instances = [];
  await controller.start();
  const socket = FakeSocket.instances[0];
  socket.open();
  await tick();
  socket.readyState = 3;
  socket.dispatchEvent(
    Object.assign(new Event('close'), { code: 4001, reason: 'expired' }),
  );
  assert.equal(controller.status, 'error');
  assert.equal(controller.dc, null);
});

/* ---------------- server ---------------- */

function fakeRes() {
  const res = {
    headers: {},
    statusCode: 200,
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(body) {
      this.body = body;
    },
  };
  return res;
}

test('provider resolution prefers explicit choice, then OpenAI when keyed, else xAI', () => {
  assert.equal(resolveVoiceProvider({ VOICE_PROVIDER: 'XAI' }), 'xai');
  assert.equal(
    resolveVoiceProvider({ OPENAI_API_KEY: 'a', XAI_API_KEY: 'b' }),
    'openai',
  );
  assert.equal(resolveVoiceProvider({ XAI_API_KEY: 'b' }), 'xai');
  assert.equal(resolveVoiceProvider({}), 'openai');
});

test('session config carries IRIS instructions, tools, voice and 24 kHz PCM', () => {
  const tools = [{ type: 'function', name: 'x', parameters: {} }];
  const session = xaiSessionConfig({
    tools,
    env: { XAI_REALTIME_VOICE: 'rex', XAI_REALTIME_REASONING_EFFORT: 'none' },
  });
  assert.equal(session.voice, 'rex');
  assert.equal(session.tools, tools);
  assert.deepEqual(session.turn_detection, { type: 'server_vad' });
  assert.equal(session.audio.input.format.rate, 24000);
  assert.deepEqual(session.reasoning, { effort: 'none' });
  assert.ok(session.instructions.length > 100);
  assert.equal(xaiSessionConfig({ env: {} }).reasoning, undefined);
});

test('token handler mints a bare secret upstream and never echoes the API key', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const calls = [];
  const handler = createXaiRealtimeTokenHandler({
    resolveApiKey: () => 'xai-server-key-should-stay-private',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ value: 'ephemeral', expires_at: 123 });
    },
  });
  const res = fakeRes();
  await handler({ method: 'POST', headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/realtime/client_secrets');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    expires_after: { seconds: 300 },
  });
  assert.equal(
    calls[0].init.headers.Authorization,
    'Bearer xai-server-key-should-stay-private',
  );
  const body = JSON.parse(res.body);
  assert.equal(body.provider, 'xai');
  assert.equal(body.value, 'ephemeral');
  assert.equal(body.url, 'wss://api.x.ai/v1/realtime');
  assert.ok(Array.isArray(body.session.tools));
  assert.equal(res.headers['x-iris-voice-provider'], 'xai');
  assert.equal(res.body.includes('should-stay-private'), false);
});

test('token handler reports a missing key and sanitizes upstream failures', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const missing = fakeRes();
  await createXaiRealtimeTokenHandler({ resolveApiKey: () => '' })(
    { method: 'GET', headers: {}, socket: {} },
    missing,
  );
  assert.equal(missing.statusCode, 503);
  assert.match(missing.body, /XAI_API_KEY is not set/);

  const denied = fakeRes();
  await createXaiRealtimeTokenHandler({
    resolveApiKey: () => 'k',
    fetchImpl: async () =>
      Response.json({ error: 'upstream detail' }, { status: 401 }),
  })({ method: 'GET', headers: {}, socket: {} }, denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.body.includes('upstream detail'), false);

  const offline = fakeRes();
  await createXaiRealtimeTokenHandler({
    resolveApiKey: () => 'k',
    fetchImpl: async () => {
      throw new Error('getaddrinfo api.x.ai');
    },
  })({ method: 'GET', headers: {}, socket: {} }, offline);
  assert.equal(offline.statusCode, 502);
  assert.equal(offline.body.includes('api.x.ai'), false);
});
