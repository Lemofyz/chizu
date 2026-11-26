// Study with Chizu: the 1O1 learning backend (explain, quiz, grade, review cards) behind Chizu's face.
// Uses globals from demo.html: $, act, say, openSheet.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
// Her replies stream through react-stream-markdown (Lemofyz's library): new characters fade in, math via KaTeX.
import React from 'https://esm.sh/react@19.2.1';
import { createRoot } from 'https://esm.sh/react-dom@19.2.1/client?deps=react@19.2.1';
import { StreamingMarkdown, createTextStream, katexMath } from 'https://esm.sh/react-stream-markdown@0.4.0?deps=react@19.2.1,react-dom@19.2.1';
import katex from 'https://esm.sh/katex@0.16.11';

const cfg = window.CHIZU_STUDY;
const FN = cfg.url + '/functions/v1/coach';
const FREE_DAILY = 5;
const sb = createClient(cfg.url, cfg.key, {
  auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: 'chizu-study-auth' },
});

const el = id => document.getElementById(id);
let state = null, sending = false, sid = null;
// Same formula as the backend's chizuSessionId: Chizu keeps one conversation of her own per account.
async function chizuSessionId(user) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('chizu-session:' + user)));
  h[6] = (h[6] & 0x0f) | 0x40; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ---------- Sign-in ----------
async function session() { return (await sb.auth.getSession()).data.session; }
el('studyLogin').onclick = () => sb.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo: location.origin + location.pathname },
});
async function finishSignIn() {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) return false;
  history.replaceState(null, '', location.pathname);
  const { error } = await sb.auth.exchangeCodeForSession(code);
  return !error;
}

// ---------- Talking to the backend ----------
const uuid = () => crypto.randomUUID();
async function headers(stream) {
  const s = await session();
  return { Authorization: 'Bearer ' + s.access_token, apikey: cfg.key, 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) };
}
async function loadState() {
  const r = await fetch(FN, { method: 'POST', headers: await headers(false),
    body: JSON.stringify({ action: 'state', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Could not reach her study notes. Try again.');
  return j.state;
}
// Learning actions stream her words as they are written, then send the saved state.
async function stream(body, onText) {
  const r = await fetch(FN, { method: 'POST', headers: await headers(true), body: JSON.stringify({ ...body, requestId: uuid(), persona: 'chizu' }) });
  if (!(r.headers.get('content-type') || '').includes('text/event-stream')) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'Something went wrong. Try again.');
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', next = null, done = false;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = 'message', data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const v = JSON.parse(data);
      if (ev === 'delta') onText(v.text);
      else if (ev === 'state') next = v.state;
      else if (ev === 'error') throw new Error(v.error);
      else if (ev === 'done') done = true;
    }
  }
  if (!next || !done) throw new Error('She lost her train of thought. Try again.');
  return next;
}

// ---------- Rendering ----------
const esc = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// **bold**, and *her actions* in soft grey italics (later these can trigger her animations).
const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*([^*\n]+)\*/g, '<span class="act">$1</span>');
let katexReady = null;
function math(node) {
  katexReady ??= new Promise(res => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css'; document.head.appendChild(css);
    const a = document.createElement('script'); a.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
    a.onload = () => { const b = document.createElement('script'); b.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js'; b.onload = res; document.head.appendChild(b); };
    document.head.appendChild(a);
  });
  katexReady.then(() => window.renderMathInElement?.(node, { delimiters: [{ left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }], throwOnError: false }));
}
function bubble(cls, text) {
  const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = fmt(text);
  el('studyLog').appendChild(d); el('studyLog').scrollTop = 1e9; math(d); return d;
}
const mathR = katexMath(katex);
// A chat bubble rendered by StreamingMarkdown; returns its element and a fresh reply session.
function mdBubble(cls) {
  const d = document.createElement('div'); d.className = 'msg ' + cls + ' md';
  el('studyLog').appendChild(d);
  const stream = createTextStream();
  createRoot(d).render(React.createElement(StreamingMarkdown, { stream, math: mathR, animate: true, label: 'Chizu', className: 'chizu-md' }));
  const session = stream.begin(); session.requestStarted();
  return { el: d, session };
}
function staticMd(cls, text) { const b = mdBubble(cls); b.session.append(text); b.session.complete(); return b.el; }
// The backend often sends a whole reply at once, and the library skips its fade for big bursts.
// So feed text in at a reading pace (about 35 characters a second, faster when a long reply backs up).
function pacer(session, onFrame) {
  let queue = [], last = 0, carry = 0, raf = 0, ended = false, resolve;
  const finished = new Promise(r => resolve = r);
  const tick = t => {
    raf = 0;
    const dt = last ? Math.min(100, t - last) : 16; last = t;
    const cps = 35 + queue.length / 3;
    carry += cps * dt / 1000;
    const take = Math.min(queue.length, Math.floor(carry), 40);
    if (take > 0) { carry -= take; session.append(queue.splice(0, take).join('')); onFrame?.(); }
    if (queue.length) raf = requestAnimationFrame(tick);
    else if (ended) { session.complete(); resolve(); }
    else last = 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  return { push(t) { queue.push(...Array.from(t)); kick(); }, end() { ended = true; kick(); }, finished };
}

const L = () => state?.learning;
const inSession = list => list.filter(x => x.session_id === sid);
function openQuestion() { return inSession(L().questions).find(q => q.status === 'open'); }
function pendingReview() {
  return inSession(L().questions).find(q => q.review_card_id && L().attempts.some(a => a.question_id === q.id && !L().reviewedAttempts.includes(a.id)));
}
function freeLeft() {
  const day = new Date().toLocaleDateString('en-CA');
  return Math.max(0, FREE_DAILY - L().questions.filter(q => !q.review_card_id && new Date(q.created_at).toLocaleDateString('en-CA') === day).length);
}
function render(full) {
  if (!L()) return;
  if (full) {
    el('studyLog').innerHTML = '';
    const msgs = inSession(L().messages).slice(-12);
    if (!msgs.length) bubble('her', "Hi. What are we studying today? Tell me the subject, or tap Quiz me.");
    for (const m of msgs) m.role === 'user' ? bubble('me', m.content) : staticMd('her', speech(m.content));
    el('studyLog').scrollTop = 1e9;
  }
  const q = openQuestion(), rv = !q && pendingReview();
  el('studyQ').hidden = !q;
  if (q) { el('qPrompt').innerHTML = fmt(q.prompt); math(el('qPrompt')); }
  el('studyRate').hidden = !rv;
  const mine = new Set(inSession(L().questions).map(q => q.id));
  const due = L().cards.filter(c => mine.has(c.question_id) && Date.parse(c.due_at) <= Date.now()).length;
  el('studyMeta').textContent = (due ? due + ' to review · ' : '') + freeLeft() + ' of ' + FREE_DAILY + ' free questions left today';
  window.chizuDue = due;
}

// ---------- Her described actions become animations ----------
// Order matters: "happy tail swish" should swish, not squint.
const ACTIONS = [[/tail/i, 'tail'], [/run/i, 'hop'], [/blink/i, 'h_blink'], [/tilt/i, 'h_tilt'], [/nod/i, 'h_nod'], [/ear/i, 'h_ears'],
  [/squint|smil|happy|purr/i, 'h_happy'], [/yawn|sleepy/i, 'h_yawn'], [/wide|surpris|gasp/i, 'h_surprise'], [/frown|pout|huff|grump|glare/i, 'h_frown']];
function actFor(phrase) { const hit = ACTIONS.find(([r]) => r.test(phrase)); return hit && hit[1]; }
// *Actions* are shown as her expression, not as text: strip them (single stars only, so **bold** survives).
const ACTION_RE = /(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)\s*/g;
const speech = t => t.replace(ACTION_RE, '$1').replace(/^\s+/, '');
// While streaming, hold back anything after a lone * that may still become an action.
function speechSoFar(t) {
  const s = speech(t), lone = s.search(/(^|[^*])\*(?!\*)[^*\n]*$/);
  return lone < 0 ? s : s.slice(0, lone + (s[lone] === '*' ? 0 : 1));
}

// ---------- Actions ----------
async function run(body, userText) {
  if (sending) return;
  sending = true; setBusy(true);
  if (userText) bubble('me', userText);
  // While the model thinks she does her thinking face; her reply then pops out of her head.
  let her = null, pace = null, text = '', shown = 0, acted = false;
  document.body.classList.add('thinking'); act('h_think');
  try {
    state = await stream(body, chunk => {
      if (!her) {
        document.body.classList.remove('thinking');
        her = mdBubble('her pop');
        pace = pacer(her.session, () => { el('studyLog').scrollTop = 1e9; });
      }
      text += chunk;
      const visible = speechSoFar(text);
      if (visible.length > shown) { pace.push(visible.slice(shown)); shown = visible.length; }
      if (!acted) {
        const m = text.match(/\*([^*\n]+)\*/);
        if (m) { acted = true; act(actFor(m[1]) || 'idle'); }
        else if (!text.trimStart().startsWith('*') || text.length > 60) { acted = true; act('idle'); }  // wait while an *action* is still arriving
      }
    });
    if (pace) { const rest = speech(text); if (rest.length > shown) pace.push(rest.slice(shown)); pace.end(); await pace.finished; }
    render(false);
    return text;
  } catch (e) {
    if (pace) pace.end();
    bubble('err pop', e.message); act('idle');
    if (/free questions/.test(e.message)) { say('treat'); }
  } finally { sending = false; setBusy(false); document.body.classList.remove('thinking'); }
}
function setBusy(b) { for (const id of ['studySend', 'studyQuiz', 'qCheck', 'qLost', 'studyMic']) el(id).disabled = b; }

el('studySend').onclick = () => {
  const t = el('studyText').value.trim(); if (!t) return;
  el('studyText').value = ''; run({ action: 'learn-chat', text: t }, t);
};
el('studyText').onkeydown = e => { if (e.key === 'Enter') el('studySend').click(); };
el('studyQuiz').onclick = () => run({ action: 'learn-next' }, 'Quiz me.');
el('qCheck').onclick = async () => {
  const q = openQuestion(), a = el('qAnswer').value.trim(); if (!q || !a) return;
  el('qAnswer').value = '';
  const reply = await run({ action: 'learn-answer', questionId: q.id, answer: a }, a);
  if (reply && /Correct/.test(reply)) fxCenter('✨');
};
el('qAnswer').onkeydown = e => { if (e.key === 'Enter') el('qCheck').click(); };
el('qLost').onclick = () => run({ action: 'learn-chat', text: "I didn't get it. Can you explain it another way?" }, "I don't get it.");
document.querySelectorAll('[data-rate]').forEach(b => b.onclick = async () => {
  const q = pendingReview(); if (!q) return;
  const at = L().attempts.filter(a => a.question_id === q.id && !L().reviewedAttempts.includes(a.id)).at(-1);
  await run({ action: 'learn-review', cardId: q.review_card_id, attemptId: at.id, rating: Number(b.dataset.rate) });
});

// ---------- Open the sheet ----------
async function openStudy() {
  openSheet('studySheet');
  const s = await session();
  el('studyAuth').hidden = !!s; el('studyMain').hidden = !s;
  if (!s) return;
  sid = await chizuSessionId(s.user.id);
  try { state = await loadState(); render(true); }
  catch (e) { el('studyLog').innerHTML = ''; bubble('err', e.message); }
}
el('studyBtn').onclick = () => el('studySheet').classList.contains('open') ? openSheet('') : openStudy();
// Tapping her small head (or Escape) brings her back to the middle of the screen.
el('frame').addEventListener('click', e => { if (document.body.classList.contains('studying')) { e.stopPropagation(); openSheet(''); } }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('studying')) openSheet(''); });

// Voice input where the browser supports it.
const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Rec) {
  el('studyMic').hidden = false;
  el('studyMic').onclick = () => {
    const r = new Rec(); r.lang = 'en-US'; r.interimResults = true;
    el('studyMic').textContent = '●';
    r.onresult = e => { el('studyText').value = [...e.results].map(x => x[0].transcript).join(''); };
    r.onend = () => { el('studyMic').textContent = '🎤'; if (el('studyText').value.trim()) el('studySend').click(); };
    r.start();
  };
}

// Focus sessions also count as study time in the same account (1O1's effective-time record).
window.chizuSync = async p => {
  if (!(await session())) return;
  const ended = new Date(), started = new Date(p.started);
  const seconds = Math.min(p.sec, Math.floor((ended - started) / 1000) + 1);
  try { await sb.rpc('save_study_session', { p_id: p.id, p_started: p.started, p_ended: ended.toISOString(), p_seconds: seconds, p_skill: null }); } catch (_) {}
};

// Small hook for testing the reply rendering in a browser console.
window.chizuDebug = { mdBubble, pacer, speechSoFar, speech };

// Coming back from Google sign-in opens the study sheet straight away.
if (await finishSignIn()) openStudy();
