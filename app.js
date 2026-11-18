(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* Safe DOM builder: uses text nodes only, so AI output can never inject HTML. */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  async function post(path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('The request timed out. Please try again.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  $('year').textContent = new Date().getFullYear();

  /* ============================ Link Checker ============================ */

  const input = $('checkInput');
  const btn = $('checkBtn');
  const out = $('result');
  const colors = { safe: '#22c55e', suspicious: '#f59e0b', dangerous: '#ef4444' };

  input.addEventListener('input', () => {
    $('charCount').textContent = `${input.value.length} / 4000`;
  });

  document.querySelectorAll('[data-example]').forEach((el) => {
    el.addEventListener('click', () => {
      input.value = el.getAttribute('data-example');
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  });

  function listBlock(title, cls, items) {
    if (!items || !items.length) return null;
    return h('div', {}, h('h4', {}, title), h('ul', { class: cls }, items.map((t) => h('li', {}, t))));
  }

  function renderResult(r) {
    const lvl = String(r.verdict || '').toLowerCase();
    const color = colors[lvl] || '#64748b';
    out.textContent = '';
    out.appendChild(
      h('div', {},
        h('div', { class: 'score-row' },
          h('div', { class: 'ring', style: `--p:${r.riskScore};--c:${color}` },
            h('div', { class: 'ring-inner' }, String(r.riskScore))),
          h('div', {},
            h('div', { class: `verdict ${lvl}` }, r.verdict),
            h('div', { class: 'muted' }, `Risk score ${r.riskScore}/100 · Confidence ${r.confidence}%`))
        ),
        h('p', { class: 'summary' }, r.summary),
        listBlock('Detected threats', 'threats', r.threats),
        listBlock('Automated URL checks', 'sigs', r.signals),
        listBlock('Recommendations', 'recs', r.recommendations),
        h('p', { class: 'meta' }, `Model: ${r.model} · AI guidance, not a guarantee. Always verify before you pay.`)
      )
    );
  }

  async function runCheck() {
    const text = input.value.trim();
    if (text.length < 3) {
      out.textContent = '';
      out.appendChild(h('div', { class: 'error' }, 'Please paste a link or some text first.'));
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    out.textContent = '';
    out.appendChild(h('div', { class: 'loading' }, '⏳ Scanning with AI, this takes a few seconds...'));

    try {
      renderResult(await post('/api/analyze', { input: text }));
    } catch (err) {
      out.textContent = '';
      out.appendChild(h('div', { class: 'error' }, err.message));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Analyze';
    }
  }

  btn.addEventListener('click', runCheck);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runCheck();
  });

  /* ============================== Chatbot ============================== */

  const panel = $('chatPanel');
  const msgs = $('chatMsgs');
  const chatInput = $('chatInput');
  const sendBtn = $('chatSend');
  const suggest = $('chatSuggest');
  let history = [];
  let greeted = false;

  function addMsg(role, text) {
    const node = h('div', { class: `msg ${role}` }, text);
    msgs.appendChild(node);
    msgs.scrollTop = msgs.scrollHeight;
    return node;
  }

  function openChat() {
    panel.classList.add('open');
    if (!greeted) {
      greeted = true;
      addMsg('bot', 'Hi! I am the TrustLens AI assistant. Ask me about scams, fake sellers, phishing or UPI fraud. Hindi, English ya Hinglish, sab chalega.');
    }
    chatInput.focus();
  }

  async function sendChat(text) {
    const message = (text || chatInput.value).trim();
    if (!message || sendBtn.disabled) return;
    chatInput.value = '';
    suggest.style.display = 'none';
    addMsg('user', message);
    sendBtn.disabled = true;
    const typing = addMsg('bot', '…');

    try {
      const data = await post('/api/chat', { message, history });
      typing.textContent = data.reply;
      history.push({ role: 'user', content: message }, { role: 'assistant', content: data.reply });
      history = history.slice(-10);
    } catch (err) {
      typing.textContent = `⚠️ ${err.message}`;
    } finally {
      sendBtn.disabled = false;
      msgs.scrollTop = msgs.scrollHeight;
      chatInput.focus();
    }
  }

  $('chatFab').addEventListener('click', () => (panel.classList.contains('open') ? panel.classList.remove('open') : openChat()));
  $('chatClose').addEventListener('click', () => panel.classList.remove('open'));
  $('heroChat').addEventListener('click', openChat);
  sendBtn.addEventListener('click', () => sendChat());
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  suggest.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => sendChat(c.textContent)));
})();