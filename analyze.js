'use strict';

const { complete, applyCors, readBody, rateLimit, sendError, clip, clamp } = require('../lib/groq');

/* ------------------------- URL heuristic checks ------------------------- */

const OFFICIAL = {
  amazon: ['amazon.in', 'amazon.com', 'amazon.co.uk', 'amazon.ae', 'amazon.de', 'amzn.in', 'amzn.to'],
  flipkart: ['flipkart.com', 'fkrt.it'],
  paytm: ['paytm.com'],
  phonepe: ['phonepe.com'],
  paypal: ['paypal.com'],
  myntra: ['myntra.com'],
  meesho: ['meesho.com'],
  netflix: ['netflix.com'],
};
const RISKY_TLDS = ['zip', 'top', 'xyz', 'click', 'icu', 'buzz', 'cfd', 'sbs', 'monster', 'rest', 'tk', 'ml', 'gq', 'cf', 'ga'];
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'cutt.ly', 'is.gd', 'rb.gy', 'shorturl.at', 'tiny.cc'];
const SENSITIVE_WORDS = ['login', 'signin', 'verify', 'secure', 'account', 'update', 'wallet', 'otp', 'kyc', 'refund', 'gift', 'prize', 'lucky'];

function findUrl(text) {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0];
  const t = text.trim();
  if (!/\s/.test(t) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(t)) return t;
  return '';
}

function urlSignals(candidate) {
  if (!candidate) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(candidate) ? candidate : 'https://' + candidate);
  } catch (_) {
    return null;
  }

  const host = u.hostname.toLowerCase();
  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  const signals = [];

  if (/^http:\/\//i.test(candidate)) signals.push('Uses plain HTTP (no encryption)');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) signals.push('Host is a raw IP address');
  if (host.includes('xn--')) signals.push('Punycode domain (possible lookalike characters)');
  if (u.username || u.password) signals.push('URL contains embedded credentials or an @ trick');
  if (labels.length >= 5) signals.push('Unusually many subdomains');
  if ((host.match(/-/g) || []).length >= 3) signals.push('Many hyphens in the domain');
  if (RISKY_TLDS.includes(tld)) signals.push(`Top-level domain ".${tld}" is frequently abused`);
  if (SHORTENERS.includes(host)) signals.push('URL shortener hides the real destination');
  if (u.href.length > 120) signals.push('Very long URL');

  for (const [brand, domains] of Object.entries(OFFICIAL)) {
    const isOfficial = domains.some((d) => host === d || host.endsWith('.' + d));
    if (host.includes(brand) && !isOfficial) {
      signals.push(`Contains the brand name "${brand}" but is not an official ${brand} domain`);
    }
  }

  const found = SENSITIVE_WORDS.filter((w) => (host + u.pathname).toLowerCase().includes(w));
  if (found.length) signals.push(`Sensitive keywords in the URL: ${found.slice(0, 5).join(', ')}`);

  return { hostname: host, signals };
}

/* ------------------------------- prompt ------------------------------- */

const SYSTEM_PROMPT = `You are TrustLens Sovereign, an expert cybersecurity and e-commerce fraud analyst.
The user gives you a link, a message, seller details, a product description, or browser page telemetry.
Assess the likelihood of fraud, phishing, counterfeit products, fake reviews, deceptive pricing or scam tactics.

Rules:
- You cannot visit links. Judge only from the text, the URL structure and the automated URL checks provided.
- Automated URL checks are heuristics and can have false positives. Use them as hints, not as proof.
- Scam patterns include: asking for OTP/PIN/CVV, advance payment, payment outside the platform, UPI collect requests,
  WhatsApp/Telegram deals, lottery or prize claims, urgent KYC or account-block threats, unrealistic discounts, fake urgency.
- Official marketplace domains over HTTPS are generally legitimate. Judge the listing, seller and behavior instead.
- Never invent facts. If information is missing, say so and lower the confidence.
- Write the summary, threats and recommendations in the same language as the user's input (English, Hindi or Hinglish). Default to English.

Respond with ONLY a valid JSON object in exactly this shape:
{
  "riskScore": <integer 0-100, higher means more dangerous>,
  "verdict": "SAFE" | "SUSPICIOUS" | "DANGEROUS",
  "confidence": <integer 0-100>,
  "summary": "<one or two sentence plain-language conclusion>",
  "threats": ["<specific finding>"],
  "recommendations": ["<actionable advice>"]
}`;

const toList = (a, max = 8) =>
  Array.isArray(a) ? a.map((x) => clip(x, 300)).filter(Boolean).slice(0, max) : [];

const verdictFromScore = (s) => (s >= 70 ? 'DANGEROUS' : s >= 40 ? 'SUSPICIOUS' : 'SAFE');

/* ------------------------------- handler ------------------------------- */

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (rateLimit(req, res, { key: 'analyze', limit: 10 })) return;

  try {
    const body = readBody(req);
    let text = '';
    let urlCandidate = '';

    if (body.telemetry && typeof body.telemetry === 'object') {
      // Used by the Chrome extension
      text = 'Browser page telemetry:\n' + clip(JSON.stringify(body.telemetry), 6000);
      urlCandidate = clip(body.telemetry.url, 500);
    } else if (typeof body.input === 'string') {
      text = clip(body.input.trim(), 4000);
      urlCandidate = findUrl(text);
    }

    if (text.length < 3) {
      return res.status(400).json({ error: 'Please paste a link or some text to check.' });
    }

    const sig = urlSignals(urlCandidate);
    const userContent =
      `User input:\n"""\n${text}\n"""\n\n` +
      `Automated URL checks (heuristics, may have false positives):\n${sig ? JSON.stringify(sig) : 'No URL detected in the input.'}`;

    const { text: raw, model } = await complete({
      temperature: 0.2,
      maxTokens: 2500,
      json: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    let parsed = {};
    try {
      parsed = JSON.parse(raw || '{}');
    } catch (_) {
      const m = (raw || '').match(/\{[\s\S]*\}/);
      try {
        parsed = m ? JSON.parse(m[0]) : {};
      } catch (_) {
        parsed = {};
      }
    }

    const riskScore = Math.round(clamp(parsed.riskScore, 0, 100));
    const verdict = ['SAFE', 'SUSPICIOUS', 'DANGEROUS'].includes(parsed.verdict)
      ? parsed.verdict
      : verdictFromScore(riskScore);

    res.status(200).json({
      riskScore,
      verdict,
      confidence: Math.round(clamp(parsed.confidence, 0, 100)),
      summary: clip(parsed.summary || 'Analysis complete.', 600),
      threats: toList(parsed.threats),
      recommendations: toList(parsed.recommendations),
      signals: sig ? sig.signals : [],
      hostname: sig ? sig.hostname : '',
      model,
      analyzedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
};