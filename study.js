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
function dueCards() {
  const mine = new Set(inSession(L().questions).map(q => q.id));
  return L().cards.filter(c => mine.has(c.question_id) && Date.parse(c.due_at) <= Date.now()).sort((a, b) => a.due_at.localeCompare(b.due_at));
}
// Anki-style review: front = the original question, back = its explanation; she rates how well she remembered.
let flashing = null, weak = [];
function showFlash(card) {
  flashing = card;
  const q = L().questions.find(x => x.id === card.question_id);
  const at = L().attempts.filter(a => a.question_id === card.question_id).at(-1);
  const back = speech(at?.explanation || '').replace(/^(AI-graded · )?(Correct!?|Not quite\.?)[^\n]*\n*/i, '').trim();
  el('fTag').textContent = 'Card · ' + (card.name || 'Review') + ' · ' + dueCards().length + ' left';
  el('fFront').innerHTML = fmt(q?.prompt || card.name); math(el('fFront'));
  el('fBack').innerHTML = fmt(back || 'No notes saved for this one.'); math(el('fBack'));
  el('fBack').hidden = true; el('fRate').hidden = true; el('fShowRow').hidden = false;
  el('studyFlash').hidden = false; el('studyQ').hidden = true; el('studyRate').hidden = true;
}
el('fShow').onclick = () => { el('fBack').hidden = false; el('fRate').hidden = false; el('fShowRow').hidden = true; act('h_tilt'); };
document.querySelectorAll('[data-frate]').forEach(b => b.onclick = async () => {
  if (!flashing || sending) return;
  const card = flashing, rating = Number(b.dataset.frate);
  el('studyFlash').hidden = true; flashing = null;
  act(rating >= 3 ? 'h_happy' : 'h_frown');
  await run({ action: 'learn-flash', cardId: card.id, rating }, null, true);
  if (rating <= 2) weak.push(card.name);
  const next = dueCards()[0];
  if (next) return showFlash(next);
  if (weak.length) {  // what she didn't remember gets practised right after the cards
    const topics = [...new Set(weak)].join('; '); weak = [];
    return run({ action: 'learn-chat', text: 'Give me one practice question on what I just forgot: ' + topics }, 'Practice what I forgot');
  }
  bubble('her pop', 'All caught up. Nice.');
});

function freeLeft() {
  const day = new Date().toLocaleDateString('en-CA');
  return Math.max(0, FREE_DAILY - L().questions.filter(q => !q.review_card_id && new Date(q.created_at).toLocaleDateString('en-CA') === day).length);
}
// Growth curve and library for the progress sheet, from Chizu's own conversation only.
function publishProgress() {
  if (!L()) return;
  const mine = new Map(inSession(L().questions).filter(q => !q.review_card_id).map(q => [q.id, q]));
  const atts = L().attempts.filter(a => mine.has(a.question_id)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const day = t => new Date(t).toLocaleDateString('en-CA');
  const growth = []; let right = 0, answered = 0, cur = null;
  for (const a of atts) {
    const d = day(a.created_at);
    if (cur && cur !== d) growth.push({ d: cur, correct: right, answered });
    cur = d; answered++; if (a.correct) right++;
  }
  if (cur) growth.push({ d: cur, correct: right, answered });
  if (growth.length && growth.at(-1).d !== day(Date.now())) growth.push({ d: day(Date.now()), correct: right, answered });
  const skills = new Map(L().skills.map(s => [s.id, s])), lib = new Map();
  for (const a of atts) {
    const k = mine.get(a.question_id).skill_id, sk = skills.get(k);
    const t = lib.get(k) || { name: sk?.name || 'Topic', answered: 0, correct: 0, mastered: sk?.mastered || 0 };
    t.answered++; if (a.correct) t.correct++; lib.set(k, t);
  }
  window.chizuProgress?.({ growth, library: [...lib.values()].sort((a, b) => b.answered - a.answered) });
}
window.chizuLoadProgress = async () => {
  const s = await session(); if (!s) return;
  sid ??= await chizuSessionId(s.user.id);
  try { state = await loadState(); publishProgress(); } catch (_) {}
};

function render(full) {
  if (!L()) return;
  publishProgress();
  if (full) {
    el('studyLog').innerHTML = '';
    const msgs = inSession(L().messages).filter(m => !(m.role === 'user' && m.content === '(flashcard)')).slice(-16);
    if (!msgs.length) bubble('her', "Hi. What are we studying today? Tell me the subject, or tap Quiz me.");
    // Instructions the page sends on your behalf show as the button you pressed.
    const said = t => /^Give me one new question on what I have been studying/.test(t) ? 'Quiz me.' : /^Give me one practice question on what I just forgot/.test(t) ? 'Practice what I forgot' : t;
    // Flashcard self-ratings are stored as an answer and its notes; they are not part of the conversation.
    const flashQ = new Set(L().messages.filter(m => m.role === 'user' && m.content === '(flashcard)').map(m => m.question_id));
    for (const m of msgs) { if (m.question_id && flashQ.has(m.question_id)) continue; m.role === 'user' ? bubble('me', said(m.content)) : staticMd('her', speech(m.content)); }
    el('studyLog').scrollTop = 1e9;
  }
  const q = openQuestion(), rv = !q && pendingReview();
  if (flashing && (q || rv)) { flashing = null; el('studyFlash').hidden = true; }
  el('studyQ').hidden = !q;
  if (q) {
    // Multiple choice: options are "A) ..." lines in the prompt and the answer is the option number.
    const opts = [...q.prompt.matchAll(/^\s*([A-D])[)）.．、:：]\s*(.+)$/gm)];
    const stem = opts.length >= 2 ? q.prompt.replace(/^\s*[A-D][)）.．、:：].*$/gm, '').trim() : q.prompt;
    // Where this question sits in the round (same rule as the backend): 3 placement, then 4 MCQs + 2 written answers.
    const nth = inSession(L().questions).filter(x => !x.review_card_id).findIndex(x => x.id === q.id) + 1, c = (nth - 4) % 6;
    const tag = q.review_card_id ? 'Review' : nth <= 3 ? 'Placement ' + nth + '/3' : c < 4 ? 'Practice ' + (c + 1) + '/4' : 'Final question ' + (c - 3) + '/2 · write your answer';
    el('qPrompt').innerHTML = '<span class="qtag">' + tag + '</span>' + fmt(stem); math(el('qPrompt'));
    const box = el('qChoices'); box.innerHTML = '';
    if (opts.length >= 2) {
      opts.forEach((m, i) => {
        const b = document.createElement('button'); b.innerHTML = '<b>' + m[1] + '</b>' + fmt(m[2]);
        b.onclick = () => { if (!sending) answer(q, String(i + 1), m[1] + ') ' + m[2]); };
        box.appendChild(b);
      });
      math(box);
    }
    el('qTyped').hidden = opts.length >= 2;
  }
  el('studyRate').hidden = !rv;
  const mine = new Set(inSession(L().questions).map(q => q.id));
  const due = L().cards.filter(c => mine.has(c.question_id) && Date.parse(c.due_at) <= Date.now()).length;
  el('studyMeta').textContent = freeLeft() + ' of ' + FREE_DAILY + ' free questions left today';
  el('studyQuiz').textContent = due && !q ? 'Review ' + due + (due === 1 ? ' card' : ' cards') : 'Quiz me';
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
async function run(body, userText, quiet = false) {
  if (sending) return;
  sending = true; setBusy(true);
  if (userText) bubble('me', userText);
  // While the model thinks she does her thinking face; her reply then pops out of her head.
  let her = null, pace = null, text = '', shown = 0, acted = false;
  if (!quiet) { document.body.classList.add('thinking'); window.thinkStart(); }
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
function setBusy(b) { for (const id of ['studySend', 'studyQuiz', 'qCheck', 'qLost']) el(id).disabled = b; }

el('studySend').onclick = () => {
  const t = el('studyText').value.trim(); if (!t) return;
  el('studyText').value = ''; el('studyText').blur();  // send closes the keyboard, like ChatGPT
  run({ action: 'learn-chat', text: t }, t);
};
el('studyText').onkeydown = e => { if (e.key === 'Enter') el('studySend').click(); };
el('studyQuiz').onclick = () => { const d = !openQuestion() && dueCards()[0]; if (d) showFlash(d); else run({ action: 'learn-next' }, 'Quiz me.'); };
el('qCheck').onclick = async () => {
  const q = openQuestion(), a = el('qAnswer').value.trim(); if (!q || !a) return;
  el('qAnswer').value = ''; el('qAnswer').blur();
  answer(q, a, a);
};
// After an answer and its explanation, the next question comes by itself (a short pause to read first).
async function answer(q, value, label) {
  const reply = await run({ action: 'learn-answer', questionId: q.id, answer: value }, label);
  if (!reply) return;
  if (/Correct|对啦/.test(reply)) fxCenter('✨');
  setTimeout(() => {
    if (!sending && !openQuestion() && !pendingReview() && document.body.classList.contains('studying')) run({ action: 'learn-next' }, null);
  }, 2200);
}
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


// Focus sessions also count as study time in the same account (1O1's effective-time record).
window.chizuSync = async p => {
  if (!(await session())) return;
  const ended = new Date(), started = new Date(p.started);
  const seconds = Math.min(p.sec, Math.floor((ended - started) / 1000) + 1);
  try { await sb.rpc('save_study_session', { p_id: p.id, p_started: p.started, p_ended: ended.toISOString(), p_seconds: seconds, p_skill: null }); } catch (_) {}
};

// Small hook for testing the reply rendering in a browser console.
window.chizuDebug = { mdBubble, pacer, speechSoFar, speech, show: (s, id) => { state = s; sid = id; render(true); } };

// Coming back from Google sign-in opens the study sheet straight away.
if (await finishSignIn()) openStudy();
