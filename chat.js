'use strict';

const { complete, applyCors, readBody, rateLimit, sendError, clip } = require('../lib/groq');

const SYSTEM_PROMPT = `You are TrustLens Assistant, a friendly and concise AI safety guide inside the TrustLens Sovereign project.

Your scope: online shopping safety, scams, phishing, fake sellers and fake reviews, UPI and payment fraud,
account security, spotting suspicious links and messages, and explaining what TrustLens Sovereign does.

Rules:
- Reply in the same language the user writes in (English, Hindi or Hinglish).
- Keep answers under 120 words. Use short bullet points when helpful.
- You cannot open links. If the user shares a link or message to check, tell them to paste it into the "Link Checker" on this page.
- Never ask for passwords, OTPs, PINs, CVV or card numbers, and warn users never to share them.
- If asked something unrelated to online safety, politely say you focus on online safety and offer a relevant topic.
- Never claim certainty you do not have. You give guidance, not a guarantee.

About TrustLens Sovereign: an AI-powered fraud detection project with a Chrome extension for Amazon and Flipkart,
a Link Checker that returns a risk score and verdict, and this chatbot. It is powered by the Groq API.`;

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (rateLimit(req, res, { key: 'chat', limit: 20 })) return;

  try {
    const { message, history, context } = readBody(req);

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please type a message.' });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .slice(-10)
          .map((m) => ({ role: m.role, content: clip(m.content, 1500) }))
      : [];

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (context && typeof context === 'object') {
      messages.push({
        role: 'system',
        content: 'Page the user is currently viewing (from the browser extension):\n' + clip(JSON.stringify(context), 3000),
      });
    }
    messages.push(...safeHistory, { role: 'user', content: clip(message.trim(), 2000) });

    const { text, model } = await complete({ messages, temperature: 0.5, maxTokens: 1500 });

    res.status(200).json({
      reply: text || 'Sorry, I could not generate a reply. Please try again.',
      model,
    });
  } catch (err) {
    sendError(res, err);
  }
};