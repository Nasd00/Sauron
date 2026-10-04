import {
  enforceRateLimit,
  openAiRateLimiter,
} from '../openai/rate-limit.js';
import { realtimeInstructions } from '../openai/instructions.js';
import { IRIS_REALTIME_TOOLS } from '../openai/tools.js';

export const XAI_REALTIME_MODEL_DEFAULT = 'grok-voice-latest';
export const XAI_REALTIME_VOICE_DEFAULT = 'eve';
export const XAI_REALTIME_URL = 'wss://api.x.ai/v1/realtime';
/** Sample rate both directions use; xAI's default and recommended rate. */
export const XAI_AUDIO_RATE = 24000;
const XAI_SECRET_TTL_SECONDS = 300;

/**
 * Which voice provider serves /api/realtime/token.
 *
 * VOICE_PROVIDER=openai|xai wins when set. Otherwise OpenAI stays the default
 * whenever its key exists, and xAI is used only when it is the sole key, so
 * adding XAI_API_KEY to an OpenAI checkout never silently switches providers.
 */
export function resolveVoiceProvider(env = process.env) {
  const requested = String(env.VOICE_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (requested === 'xai' || requested === 'openai') return requested;
  if (!env.OPENAI_API_KEY && env.XAI_API_KEY) return 'xai';
  return 'openai';
}

/** The session.update body the browser sends once its socket opens. */
export function xaiSessionConfig({
  annotationGuidance,
  tools = IRIS_REALTIME_TOOLS,
  env = process.env,
} = {}) {
  const session = {
    voice: env.XAI_REALTIME_VOICE || XAI_REALTIME_VOICE_DEFAULT,
    instructions: realtimeInstructions(annotationGuidance),
    turn_detection: { type: 'server_vad' },
    audio: {
      input: { format: { type: 'audio/pcm', rate: XAI_AUDIO_RATE } },
      output: { format: { type: 'audio/pcm', rate: XAI_AUDIO_RATE } },
    },
    tools,
    tool_choice: 'auto',
  };
  const effort = String(env.XAI_REALTIME_REASONING_EFFORT || '')
    .trim()
    .toLowerCase();
  if (effort === 'high' || effort === 'none') session.reasoning = { effort };
  return session;
}

/**
 * Mint a short-lived xAI client secret for a browser WebSocket session.
 *
 * xAI's client_secrets endpoint does not accept session configuration, so the
 * secret is minted bare and the session config (instructions, tools, voice,
 * audio format) travels in this response for the browser to apply with
 * session.update. Neither is secret; XAI_API_KEY never leaves the server.
 */
export function createXaiRealtimeTokenHandler({
  annotationGuidance,
  endpoint = 'https://api.x.ai/v1/realtime/client_secrets',
  fetchImpl = (...args) => fetch(...args),
  resolveApiKey = () => process.env.XAI_API_KEY,
  tools = IRIS_REALTIME_TOOLS,
} = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'POST') {
      json(405, { error: 'Method not allowed' });
      return;
    }
    // Same per-IP throttle as the OpenAI mint: one guard for one endpoint.
    if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

    const apiKey = resolveApiKey();
    if (!apiKey) {
      json(503, { error: 'XAI_API_KEY is not set' });
      return;
    }
    const model = process.env.XAI_REALTIME_MODEL || XAI_REALTIME_MODEL_DEFAULT;

    let upstream;
    let data = null;
    try {
      upstream = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expires_after: { seconds: XAI_SECRET_TTL_SECONDS },
        }),
      });
      data = await upstream.json().catch(() => null);
    } catch {
      console.warn('[realtime-token] xAI mint failed');
      json(502, { error: 'Failed to create Realtime token' });
      return;
    }
    if (!upstream.ok || typeof data?.value !== 'string' || !data.value) {
      console.warn(`[realtime-token] xAI upstream HTTP ${upstream.status}`);
      json(upstream.ok ? 502 : upstream.status, {
        error: 'Failed to create Realtime token',
      });
      return;
    }
    res.setHeader('X-IRIS-Voice-Provider', 'xai');
    res.setHeader('X-IRIS-Voice-Tier', 'standard');
    res.setHeader('X-IRIS-Voice-Model', model);
    json(200, {
      provider: 'xai',
      value: data.value,
      expires_at: data.expires_at,
      model,
      url: XAI_REALTIME_URL,
      session: xaiSessionConfig({ annotationGuidance, tools }),
    });
  };
}
