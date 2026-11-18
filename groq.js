'use strict';

const GroqModule = require('groq-sdk');
const Groq = GroqModule.default || GroqModule;

const PRIMARY_MODEL = (process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
const FALLBACK_MODELS = (process.env.GROQ_FALLBACK_MODELS || 'qwen/qwen3.6-27b')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL_CHAIN = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter((m) => m !== PRIMARY_MODEL)];

let client = null;
function getClient() {
  if (!process.env.GROQ_API_KEY) {
    const e = new Error('GROQ_API_KEY is not set on the server.');
    e.status = 500;
    throw e;
  }
  if (!client) client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return client;
}

/* ------------------------------ helpers ------------------------------ */

const clip = (v, n = 500) => String(v == null ? '' : v).slice(0, n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
const stripThinking = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

function isModelUnavailable(err) {
  const code = err && (err.code || (err.error && err.error.code) || (err.error && err.error.error && err.error.error.code));
  const msg = String((err && err.message) || '').toLowerCase();
  return (
    code === 'model_not_found' ||
    code === 'model_decommissioned' ||
    (err && err.status === 404) ||
    msg.includes('model_not_found') ||
    msg.includes('decommissioned') ||
    msg.includes('does not exist')
  );
}

function isFormatError(err) {
  return err && err.status === 400 && /response_format|json/i.test(String(err.message || ''));
}

/* --------------------- Groq call with model fallback --------------------- */

let activeIndex = 0;

async function complete({ messages, temperature = 0.3, maxTokens = 1500, json = false }) {
  const groq = getClient();
  let lastErr;

  for (let i = activeIndex; i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i];
    let useJson = json;

    for (let attempt = 0; attempt < 2; attempt++) {
      const params = { model, messages, temperature, max_completion_tokens: maxTokens };
      if (useJson) params.response_format = { type: 'json_object' };
      if (model.startsWith('openai/gpt-oss')) params.reasoning_effort = 'low';

      try {
        const completion = await groq.chat.completions.create(params);
        activeIndex = i;
        return { text: stripThinking(completion.choices?.[0]?.message?.content), model };
      } catch (err) {
        lastErr = err;
        if (useJson && isFormatError(err)) {
          useJson = false; // retry same model without JSON mode
          continue;
        }
        break;
      }
    }

    if (isModelUnavailable(lastErr) && i < MODEL_CHAIN.length - 1) {
      console.warn(`[TrustLens] Model "${model}" unavailable, trying next fallback...`);
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

/* ---------------------- HTTP helpers for functions ---------------------- */

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch (_) {
      return {};
    }
  }
  return {};
}

// Best-effort in-memory rate limit (per server instance).
const hits = new Map();
function rateLimit(req, res, { key = 'default', limit = 20, windowMs = 60000 } = {}) {
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown';
  const id = `${key}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(id) || []).filter((t) => now - t < windowMs);

  if (recent.length >= limit) {
    res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
    res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    return true;
  }
  recent.push(now);
  hits.set(id, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

function sendError(res, err) {
  console.error('[TrustLens] Error:', (err && err.message) || err);
  const status = err && err.status === 429 ? 429 : 500;
  res.status(status).json({
    error:
      status === 429
        ? 'The AI service is busy. Please retry in a few seconds.'
        : 'Something went wrong on the server. Please try again.',
  });
}

module.exports = { complete, applyCors, readBody, rateLimit, sendError, clip, clamp, MODEL_CHAIN };