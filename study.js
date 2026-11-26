// Study with Chizu. The flow is decided by the chizu backend (supabase/functions/chizu in the 1O1 repo);
// this file only shows what it sends: her words, question cards, verdicts, subjects.
// Uses globals from demo.html: act, say, openSheet, fxCenter, thinkStart.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.118.0';
// Her replies stream through react-stream-markdown (Lemofyz's library): new characters fade in, math via KaTeX.
import React from 'https://esm.sh/react@19.2.1';
import { createRoot } from 'https://esm.sh/react-dom@19.2.1/client?deps=react@19.2.1';
import { StreamingMarkdown, createTextStream, katexMath } from 'https://esm.sh/react-stream-markdown@0.4.0?deps=react@19.2.1,react-dom@19.2.1';
import katex from 'https://esm.sh/katex@0.16.11';

const cfg = window.CHIZU_STUDY;
const FN = cfg.url + '/functions/v1/chizu';
const sb = createClient(cfg.url, cfg.key, {
  auth: { flowType: 'pkce', detectSessionInUrl: false, persistSession: true, autoRefreshToken: true, storageKey: 'chizu-study-auth' },
});
const el = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Sign-in ----------
async function session() { return (await sb.auth.getSession()).data.session; }
el('studyLogin').onclick = () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
async function finishSignIn() {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) return false;
  history.replaceState(null, '', location.pathname);
  const { error } = await sb.auth.exchangeCodeForSession(code);
  return !error;
}

// ---------- Talking to the backend: one POST, a stream of events back ----------
async function call(body, on) {
  const s = await session();
  if (!s) throw new Error('Please sign in first.');
  const r = await fetch(FN, { method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + s.access_token, apikey: cfg.key, 'Content-Type': 'application/json', Accept: 'text/event-stream' } });
  if (!(r.headers.get('content-type') || '').includes('text/event-stream')) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'Something went wrong, meow. Try again~');
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', done = false;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = '', data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!ev || !data) continue;
      const v = JSON.parse(data);
      if (ev === 'error') throw new Error(v.message);
      if (ev === 'done') done = true; else on[ev]?.(v);
    }
  }
  if (!done) throw new Error('She lost her train of thought, meow. Try again~');
}

// ---------- Rendering ----------
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
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
const log = () => el('studyLog');
const atBottom = () => log().scrollTop + log().clientHeight >= log().scrollHeight - 40;
function bubble(cls, text) {
  const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = fmt(text);
  log().appendChild(d); log().scrollTop = 1e9; math(d); return d;
}
const mathR = katexMath(katex);
function mdBubble(cls) {
  const d = document.createElement('div'); d.className = 'msg ' + cls + ' md';
  log().appendChild(d);
  const stream = createTextStream();
  createRoot(d).render(React.createElement(StreamingMarkdown, { stream, math: mathR, animate: true, label: 'Chizu', className: 'chizu-md' }));
  const s = stream.begin(); s.requestStarted();
  return { el: d, session: s };
}
function staticMd(cls, text) { const b = mdBubble(cls); b.session.append(text); b.session.complete(); return b.el; }
// Text is fed in at a reading pace (about 35 characters a second, faster when a long reply backs up),
// because the markdown library skips its fade for big bursts.
function pacer(session) {
  let queue = [], last = 0, carry = 0, raf = 0, ended = false, resolve;
  const finished = new Promise(r => resolve = r);
  const tick = t => {
    raf = 0;
    const dt = last ? Math.min(100, t - last) : 16; last = t;
    carry += (35 + queue.length / 3) * dt / 1000;
    const take = Math.min(queue.length, Math.floor(carry), 40);
    if (take > 0) { carry -= take; const stick = atBottom(); session.append(queue.splice(0, take).join('')); if (stick) log().scrollTop = 1e9; }
    if (queue.length) raf = requestAnimationFrame(tick);
    else if (ended) { session.complete(); resolve(); }
    else last = 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  return { push(t) { queue.push(...Array.from(t)); kick(); }, end() { ended = true; kick(); }, finished };
}

// ---------- Her *actions* become animations, not text ----------
const ACTIONS = [[/tail/i, 'tail'], [/run/i, 'hop'], [/blink/i, 'h_blink'], [/tilt/i, 'h_tilt'], [/nod/i, 'h_nod'], [/ear/i, 'h_ears'],
  [/squint|smil|happy|purr/i, 'h_happy'], [/yawn|sleepy/i, 'h_yawn'], [/wide|surpris|gasp/i, 'h_surprise'], [/frown|pout|huff|grump|glare/i, 'h_frown']];
const actFor = phrase => ACTIONS.find(([r]) => r.test(phrase))?.[1];
const ACTION_RE = /(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)\s*/g;
const speech = t => t.replace(ACTION_RE, '$1').replace(/^\s+/, '');
function speechSoFar(t) {   // hold back anything after a lone * that may still become an action
  const s = speech(t), lone = s.search(/(^|[^*])\*(?!\*)[^*\n]*$/);
  return lone < 0 ? s : s.slice(0, lone + (s[lone] === '*' ? 0 : 1));
}

// ---------- What is on screen ----------
let subjects = [], subject = localStorage.getItem('chizu_subject') || null, question = null, freeLeft = null;
let busy = false, paused = false, pick = null;
const current = () => subjects.find(s => s.id === subject) || null;
const zh = () => (current()?.language || (/^zh/i.test(navigator.language) ? 'zh' : 'en')) === 'zh';
const T = (cn, en) => zh() ? cn : en;

function setSubject(id) {
  subject = id; id ? localStorage.setItem('chizu_subject', id) : localStorage.removeItem('chizu_subject');
  renderFolders();
}
function renderFolders() {
  el('subjBar').hidden = !subjects.length;
  el('subjName').textContent = current()?.name || T('新科目', 'New subject');
  el('studyText').placeholder = T('跟芝士说点什么…', 'Talk to Chizu…');
  el('subjList').innerHTML = subjects.map(f => '<button data-subj="' + f.id + '"' + (f.id === subject ? ' class="on"' : '') + '>' + esc(f.name) +
    '<small>' + f.cards + (f.cards === 1 ? ' card' : ' cards') + (f.due ? ' · ' + f.due + ' due' : '') + '</small></button>').join('') +
    '<button data-subj="">' + T('+ 新科目', '+ New subject') + '<small></small></button>';
  el('subjList').querySelectorAll('[data-subj]').forEach(b => b.onclick = () => {
    el('subjList').hidden = true;
    if (!b.dataset.subj) { setSubject(null); showQuestion(null); bubble('her pop', T('接下来想学什么呀喵？', 'What do you want to learn next, meow?')); el('studyText').focus(); return; }
    if (b.dataset.subj === subject) return;
    setSubject(b.dataset.subj); paused = false; showQuestion(null);
    bubble('her pop', T(`换到「${current()?.name}」喵～`, `Switching to ${current()?.name}, meow~`)); act('h_nod');
    refresh().then(() => { if (!question) next(); });
  });
}
el('subjBtn').onclick = e => { e.stopPropagation(); el('subjList').hidden = !el('subjList').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#subjBar')) el('subjList').hidden = true; });

function showQuestion(q) {
  question = q;
  const card = el('studyQ'), stick = atBottom();
  card.hidden = !q;
  if (!q) { card.dataset.q = ''; return; }
  if (q.id !== card.dataset.q) { card.dataset.q = q.id; card.classList.remove('enter'); void card.offsetWidth; card.classList.add('enter'); }
  el('qPrompt').innerHTML = '<span class="qtag">' + esc(q.tag || '') + '</span>' + fmt(q.prompt); math(el('qPrompt'));
  const box = el('qChoices'); box.innerHTML = '';
  (q.options || []).forEach((o, i) => {
    const b = document.createElement('button'); b.innerHTML = '<b>' + 'ABCD'[i] + '</b>' + fmt(o);
    b.onclick = () => choose(q, i);
    box.appendChild(b);
  });
  math(box);
  el('qTyped').hidden = q.kind !== 'frq';
  el('qAnswer').placeholder = T('写下你的答案', 'Your answer');
  el('qCheck').textContent = T('提交', 'Check');
  el('qLost').textContent = T('没看懂', "I don't get it");
  if (stick) log().scrollTop = 1e9;
}
function showVerdict(v) {
  if (!question || question.id !== v.questionId) return;
  const btns = [...el('qChoices').children];
  btns.forEach(b => b.disabled = true);
  if (pick != null && btns[pick]) btns[pick].className = v.correct ? 'right' : 'wrong';
  if (!v.correct && v.answerIndex != null && btns[v.answerIndex]) btns[v.answerIndex].className = 'right';
}
function applyState(st, full = true) {
  subjects = st.subjects || [];
  if (subject && !subjects.some(s => s.id === subject)) setSubject(null); else renderFolders();
  freeLeft = st.freeLeft;
  if (full) {
    log().innerHTML = '';
    if (!st.messages?.length) bubble('her', T('嗨喵～ 想学什么？告诉我科目，我先出几道小题摸摸底。', "Hi, meow~ What do you want to learn? Tell me the subject and I'll start with a few quick questions."));
    for (const m of st.messages || []) m.role === 'user' ? bubble('me', m.content) : staticMd('her', speech(m.content));
  }
  showQuestion(st.question);
  log().scrollTop = 1e9;
}

// ---------- One turn: send, then show what comes back in order ----------
function setBusy(b) { for (const id of ['studySend', 'qCheck', 'qLost', 'mHint', 'mUpload', 'mCamera', 'mPhotos', 'mTired']) el(id).disabled = b; }
const thinking = on => { if (on && !document.body.classList.contains('thinking')) { document.body.classList.add('thinking'); window.thinkStart?.(); } if (!on) document.body.classList.remove('thinking'); };

async function turn(body, userText, quiet = false) {
  if (busy) return false;
  busy = true; setBusy(true);
  if (userText) bubble('me', userText);
  if (!quiet) thinking(true);
  let her = null, pace = null, text = '', shown = 0, acted = false;
  const speaking = [];      // her bubbles still typing; a new question waits for them
  let verdictAt = 0, cardShown = null;
  const startBubble = () => { thinking(false); her = mdBubble('her pop'); pace = pacer(her.session); speaking.push(pace.finished); text = ''; shown = 0; acted = false; };
  const endBubble = () => { if (!pace) return; const rest = speech(text); if (rest.length > shown) pace.push(rest.slice(shown)); pace.end(); her = pace = null; };
  try {
    await call(body, {
      say: v => {
        if (!her) startBubble();
        text += v.text;
        const visible = speechSoFar(text);
        if (visible.length > shown) { pace.push(visible.slice(shown)); shown = visible.length; }
        if (!acted) {
          const m = text.match(/\*([^*\n]+)\*/);
          if (m) { acted = true; act(actFor(m[1]) || 'idle'); }
          else if (!text.trimStart().startsWith('*') || text.length > 60) acted = true;
        }
      },
      say_end: () => endBubble(),
      verdict: v => {
        endBubble(); showVerdict(v); verdictAt = Date.now();
        act(v.correct ? 'h_happy' : 'h_frown'); if (v.correct) fxCenter('✨');
        startBubble(); acted = true; text = v.text; shown = speech(text).length; pace.push(speech(text)); endBubble();
        // The next question is being written: she thinks once she has finished talking.
        Promise.all(speaking).then(() => { if (busy) thinking(true); });
      },
      card: q => {
        endBubble();
        cardShown = (async () => {
          await Promise.all(speaking);
          const wait = verdictAt ? 1200 - (Date.now() - verdictAt) : 0;   // let the green or red sink in
          if (wait > 0) await sleep(wait);
          thinking(false); pick = null; showQuestion(q);
        })();
      },
      subject: s => { if (!subjects.some(x => x.id === s.id)) subjects.push({ ...s, cards: 0, due: 0 }); setSubject(s.id); paused = false; },
      state: st => applyState(st, false),
      limit: () => say('treat'),
      pause: () => { paused = true; },
    });
    endBubble();
    await Promise.all(speaking); await cardShown;
    return true;
  } catch (e) {
    endBubble();
    bubble('err pop', e.message); act('idle');
    if (pick != null) { pick = null; showQuestion(question); }
    return false;
  } finally {
    busy = false; setBusy(false); thinking(false);
    saveCacheSoon();
  }
}
const refresh = () => turn({ action: 'state', subjectId: subject }, null, true);
const next = () => subject && !paused && turn({ action: 'next', subjectId: subject });

function choose(q, i) {
  if (busy || pick != null) return;
  pick = i; el('qChoices').children[i].className = 'picked';
  turn({ action: 'answer', questionId: q.id, choice: i }, 'ABCD'[i] + ') ' + q.options[i]);
}
el('qCheck').onclick = () => {
  const a = el('qAnswer').value.trim(); if (!question || !a || busy) return;
  el('qAnswer').value = ''; el('qAnswer').blur();
  turn({ action: 'answer', questionId: question.id, text: a }, a);
};
el('qAnswer').onkeydown = e => { if (e.key === 'Enter') el('qCheck').click(); };
const hint = () => question && turn({ action: 'hint', questionId: question.id }, T('给个提示', 'Hint, please.'));
el('qLost').onclick = hint;
el('studySend').onclick = () => {
  const t = el('studyText').value.trim(); if (!t || busy) return;
  el('studyText').value = ''; el('studyText').blur();   // send closes the keyboard, like ChatGPT
  paused = false;
  turn({ action: 'say', subjectId: subject, text: t }, t);
};
el('studyText').onkeydown = e => { if (e.key === 'Enter') el('studySend').click(); };

// ---------- Opening study: last conversation at once from this device, then the server's ----------
const CACHE = 'chizu_v3_cache';
let cacheTimer = 0;
function saveCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(async () => {
    const s = await session(); if (!s) return;
    try { await call({ action: 'state', subjectId: subject }, { state: st => localStorage.setItem(CACHE, JSON.stringify({ user: s.user.id, st })) }); } catch (_) {}
  }, 1500);
}
async function openStudy() {
  openSheet('studySheet');
  const s = await session();
  el('studyAuth').hidden = !!s; el('studyMain').hidden = !s;
  if (!s) return;
  try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c?.user === s.user.id) applyState(c.st); } catch (_) {}
  try {
    await call({ action: 'state', subjectId: subject }, { state: st => { applyState(st); localStorage.setItem(CACHE, JSON.stringify({ user: s.user.id, st })); } });
  } catch (e) { if (!log().children.length) bubble('err', e.message); return; }
  if (!question) next();
}
el('studyBtn').onclick = () => el('studySheet').classList.contains('open') ? openSheet('') : openStudy();

// ---------- Her menu (tap her small head) ----------
el('frame').addEventListener('click', e => {
  if (!document.body.classList.contains('studying')) return;
  e.stopPropagation();
  el('mHint').hidden = !question;
  el('chizuMenu').hidden = !el('chizuMenu').hidden;
}, true);
const closeMenu = () => { el('chizuMenu').hidden = true; };
// Hint: guess first. The first tap only nudges; tapping again on the same question gets a hint, never the answer.
let nudged = null;
el('mHint').onclick = () => {
  closeMenu(); if (!question) return;
  if (nudged !== question.id) { nudged = question.id; bubble('her pop', T('先猜一个嘛喵，错了也没关系，会变成卡片来练。', 'Have a guess first, meow. Wrong is fine, it turns into a card to practise.')); act('h_tilt'); return; }
  hint();
};
el('mTired').onclick = () => { closeMenu(); paused = true; turn({ action: 'say', subjectId: subject, text: T('我累了', "I'm tired.") }, T('我累了', "I'm tired.")); };

// ---------- Upload: from her menu, or drop a file on the study screen ----------
async function upload(file) {
  if (!file || busy) return;
  if (file.size > 8 * 1024 * 1024) return bubble('err pop', T('文件要小于 8MB 喵。', 'Please keep files under 8MB, meow.'));
  // Photos are read here (free, in the browser) and sent as text.
  if (file.type.startsWith('image/')) {
    const note = bubble('her pop', T('在看你的照片喵…', 'Reading your photo, meow…')); act('h_think');
    let text = '';
    try { text = (await ocr(file)).trim(); } catch (_) {}
    note.remove();
    if (text.length < 8) { bubble('err pop', T('照片里的字看不清喵，靠近一点、亮一点再拍。', "I couldn't read that photo, meow. Try a closer, brighter shot.")); return act('h_frown'); }
    file = new File([text], (file.name || 'photo').replace(/\.[^.]+$/, '') + '.txt', { type: 'text/plain' });
  }
  const bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  paused = false;
  turn({ action: 'upload', subjectId: subject, name: file.name, base64: btoa(bin) }, '📎 ' + file.name);
}
let tess = null;
function ocr(file) {
  tess ??= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = () => res(window.Tesseract); s.onerror = rej; document.head.appendChild(s); });
  return tess.then(T => T.recognize(file, 'eng+chi_sim')).then(r => r.data.text);
}
for (const [btn, input] of [['mUpload', 'mFile'], ['mCamera', 'mCam'], ['mPhotos', 'mPick']]) {
  el(btn).onclick = () => { closeMenu(); el(input).click(); };
  el(input).onchange = e => { const f = e.target.files[0]; e.target.value = ''; upload(f); };
}
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (!document.body.classList.contains('studying')) return; e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', e => { if (document.body.classList.contains('studying')) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!document.body.classList.contains('studying')) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping');
  upload(e.dataTransfer.files[0]);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('studying')) openSheet(''); });

// ---------- Progress sheet: library by subject and topic, growth line ----------
window.chizuLoadProgress = async () => {
  if (!(await session())) return;
  try { await call({ action: 'library' }, { library: p => window.chizuProgress?.(p) }); } catch (_) {}
};
// Focus sessions also count as study time in the same account (1O1's effective-time record).
window.chizuSync = async p => {
  if (!(await session())) return;
  const ended = new Date(), started = new Date(p.started);
  const seconds = Math.min(p.sec, Math.floor((ended - started) / 1000) + 1);
  try { await sb.rpc('save_study_session', { p_id: p.id, p_started: p.started, p_ended: ended.toISOString(), p_seconds: seconds, p_skill: null }); } catch (_) {}
};
// 25 minutes of studying in the chat: a gentle break reminder.
window.chizuBreak = () => { bubble('her pop', T('学了 25 分钟啦喵！伸个懒腰，喝口水，再继续～', "That's 25 minutes, meow! Stretch, drink some water, then we'll keep going.")); act('h_happy'); };
// For previews and console testing.
window.chizuDebug = { show: st => applyState(st, true), card: q => showQuestion(q), verdict: (v, i) => { pick = i; showVerdict(v); } };

// Coming back from Google sign-in opens the study sheet straight away.
if (await finishSignIn()) openStudy();
