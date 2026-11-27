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
// Study without an account: a guest session keeps cards and notes on this device; saving with Google later keeps everything.
el('studyGuest').onclick = async () => {
  el('studyGuest').disabled = true;
  const { error } = await sb.auth.signInAnonymously().catch(e => ({ error: e }));
  el('studyGuest').disabled = false;
  if (error) { el('studyGuest').textContent = T('请用 Google 继续', 'Please continue with Google'); return; }
  window.posthog?.capture('guest_started'); openStudy();
};
const saveWithGoogle = () => { window.posthog?.capture('guest_save_clicked'); return sb.auth.linkIdentity({ provider: 'google', options: { redirectTo: location.origin + location.pathname } }); };
// Chizu asks in a speech bubble at her head's top-right instead of a browser dialog. Resolves true / false.
function catAsk(text, yes, no) {
  return new Promise(resolve => {
    document.querySelector('.catask')?.remove();
    const b = document.createElement('div'); b.className = 'catask'; b.setAttribute('role', 'alertdialog');
    b.innerHTML = '<p></p><div class="catask-row"><button type="button" class="catask-no"></button><button type="button" class="catask-yes"></button></div>';
    b.querySelector('p').textContent = text; b.querySelector('.catask-yes').textContent = yes; b.querySelector('.catask-no').textContent = no;
    document.body.appendChild(b);
    const f = document.getElementById('frame')?.getBoundingClientRect(), w = b.offsetWidth, h = b.offsetHeight;
    let left = f && f.width ? f.right - 18 : (innerWidth - w) / 2, top = f && f.width ? f.top - h + 18 : 80;
    if (top < 8) { top = f && f.width ? f.bottom - 6 : 80; b.classList.add('below'); }
    b.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + 'px'; b.style.top = top + 'px';
    requestAnimationFrame(() => b.classList.add('in'));
    const done = v => { b.classList.remove('in'); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); setTimeout(() => b.remove(), 200); resolve(v); };
    const away = e => { if (!b.contains(e.target)) done(false); }, esc = e => { if (e.key === 'Escape') done(false); };
    b.querySelector('.catask-yes').onclick = () => done(true); b.querySelector('.catask-no').onclick = () => done(false);
    setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', esc); }, 0);
    b.querySelector('.catask-no').focus({ preventScroll: true });
  });
}
el('studyOut').onclick = async () => {   // sign out of study (and of the claim page, which shares this sign-in)
  if (!await catAsk(T('要退出登录吗？小鱼干、题目和复习卡都会留在你的账号里。', 'Sign out? Your fish, questions and review cards stay saved on your account.'), T('退出', 'Sign out'), T('不了', 'Stay'))) return;
  await sb.auth.signOut().catch(() => {});
  window.posthog?.capture('signed_out'); window.posthog?.reset?.();
  location.reload();
};
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
let subjects = [], subject = localStorage.getItem('chizu_subject') || null, question = null;
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
  el('mUpload').textContent = T('照片或文件', 'Photo or file');
  el('subjList').innerHTML = subjects.map(f => '<div class="subjrow"><button data-subj="' + f.id + '"' + (f.id === subject ? ' class="on"' : '') + '>' + esc(f.name) +
    '<small>' + T(f.cards + ' 张卡' + (f.due ? ' · ' + f.due + ' 张待复习' : ''), f.cards + (f.cards === 1 ? ' card' : ' cards') + (f.due ? ' · ' + f.due + ' due' : '')) + '</small></button>' +
    '<button class="subjdel" data-del="' + f.id + '" aria-label="' + T('删除这个科目', 'Delete this subject') + '" title="' + T('删除', 'Delete') + '">×</button></div>').join('') +
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
// Delete a subject (and its cards and questions) after a confirm.
el('subjList').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  e.stopPropagation();
  const f = subjects.find(x => x.id === b.dataset.del); if (!f) return;
  el('subjList').hidden = true;
  if (!await catAsk(T(`要删掉「${f.name}」吗？${f.cards} 张卡片会一起没了，找不回来喵。`, `Delete "${f.name}"? Its ${f.cards} card${f.cards === 1 ? '' : 's'} go too, and I can't bring them back.`), T('删掉', 'Delete'), T('留着', 'Keep'))) return;
  const { data, error } = await sb.rpc('chizu_delete_subject', { p_id: f.id });
  if (error || !data) { bubble('her pop', T('删不掉喵，再试一次？', "Couldn't delete that, meow. Try again?")); return; }
  window.posthog?.capture('subject_deleted', { cards: f.cards });
  subjects = subjects.filter(x => x.id !== f.id);
  if (subject === f.id) { setSubject(null); showQuestion(null); }
  renderFolders(); el('subjList').hidden = !subjects.length ? true : false;
  refresh();
});
el('subjBtn').onclick = e => { e.stopPropagation(); el('subjList').hidden = !el('subjList').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#subjBar')) el('subjList').hidden = true; });

// ---------- Question cards live in the conversation: they scroll with it and stay as a record ----------
let cardEl = null;   // the card of the open question
function makeCard(q, animate = true) {
  const c = document.createElement('div'); c.className = 'qcard' + (animate ? ' enter' : ''); c.dataset.q = q.id;
  c.innerHTML = '<div class="qprompt"><span class="qtag">' + esc(q.tag || '') + '</span>' + fmt(q.prompt) + '</div><div class="choices"></div>';
  const box = c.querySelector('.choices');
  (q.options || []).forEach((o, i) => { const b = document.createElement('button'); b.innerHTML = '<b>' + 'ABCD'[i] + '</b>' + fmt(o); box.appendChild(b); });
  if (q.done) markCard(c, { correct: q.correct, answerIndex: q.answerIndex }, q.chosen);
  else {
    [...box.children].forEach((b, i) => b.onclick = () => choose(q, i, c));
    if (q.kind === 'frq') {
      const row = document.createElement('div'); row.className = 'row typed';
      row.innerHTML = '<input class="qAnswer" autocomplete="off"><button class="qCheck"></button>';
      const input = row.querySelector('input'), check = row.querySelector('button');
      input.placeholder = T('写下你的答案', 'Your answer'); check.textContent = T('提交', 'Check');
      check.onclick = () => submitTyped(q, input);
      input.onkeydown = e => { if (e.key === 'Enter') check.click(); };
      c.appendChild(row);
    }
    const lost = document.createElement('div'); lost.className = 'row lostrow';
    lost.innerHTML = '<button class="ghost qLost"></button>'; lost.firstChild.textContent = T('没看懂', "I don't get it"); lost.firstChild.onclick = hint;
    c.appendChild(lost);
  }
  math(c); return c;
}
// An answered card: the pick turns green or soft red, the right option is shown, and its controls go away.
function markCard(c, v, chosen) {
  c.classList.add('done'); c.querySelectorAll('.typed,.lostrow').forEach(r => r.remove());
  const btns = [...c.querySelectorAll('.choices button')];
  btns.forEach(b => { b.disabled = true; b.onclick = null; });
  if (chosen != null && btns[chosen]) btns[chosen].className = v.correct ? 'right' : 'wrong';
  if (!v.correct && v.answerIndex != null && btns[v.answerIndex]) btns[v.answerIndex].className = 'right';
}
function showQuestion(q) {
  question = q;
  if (!q) { cardEl = null; return; }
  cardEl = log().querySelector('.qcard[data-q="' + q.id + '"]');
  if (!cardEl) { cardEl = makeCard(q); log().appendChild(cardEl); }
  toBottom();
}
function showVerdict(v) {
  if (!cardEl || cardEl.dataset.q !== v.questionId) return;
  markCard(cardEl, v, pick);
}
// ---------- Daily lines: welcome back, today's reviews, leftovers from yesterday, all done ----------
const dayKey = () => new Date().toLocaleDateString('en-CA');
const sum = k => subjects.reduce((n, f) => n + (f[k] || 0), 0);
let prevDue = null;
function dueWatch() {   // called whenever fresh subject counts arrive
  const due = sum('due');
  if (prevDue > 0 && due === 0 && localStorage.getItem('chizu_alldone_day') !== dayKey()) {
    localStorage.setItem('chizu_alldone_day', dayKey());
    bubble('her pop', T('今天该复习的全部搞定啦喵！明天见～', "That's every review for today, done! See you tomorrow, meow~"));
    window.act?.('h_happy'); window.posthog?.capture('reviews_all_done');
  }
  prevDue = due;
}
function greet() {      // once per day when study opens
  if (!subjects.length) return;
  const last = +localStorage.getItem('chizu_last_study') || 0, today = dayKey();
  const firstToday = localStorage.getItem('chizu_last_study_day') !== today;
  localStorage.setItem('chizu_last_study', Date.now()); localStorage.setItem('chizu_last_study_day', today);
  if (!firstToday) return;
  const days = last ? Math.floor((Date.now() - last) / 864e5) : 0, due = sum('due'), overdue = sum('overdue');
  let line = days >= 2 ? T(`欢迎回来喵！${days} 天没见了，今天的学习可以开始啦～`, `Welcome back! It's been ${days} days, meow. Ready to start today's study?`)
                       : T('新的一天喵～', 'New day, meow~');
  if (due) line += ' ' + T(`今天有 ${due} 张卡要复习。`, `You have ${due} card${due === 1 ? '' : 's'} to review today.`);
  if (overdue) line += ' ' + T(`其中 ${overdue} 张是昨天没复习完的，我们先做这些。`, `${overdue} of them ${overdue === 1 ? 'has' : 'have'} been waiting since yesterday, let's start there.`);
  if (days < 2 && !due) return;   // nothing worth saying on an ordinary day with no reviews
  bubble('her pop', line); window.act?.(days >= 2 ? 'h_happy' : 'h_nod');
}
function applyState(st, full = true) {
  subjects = st.subjects || []; dueWatch();
  if (st.fish != null) window.chizuWallet?.(st.fish);
  if (subject && !subjects.some(s => s.id === subject)) setSubject(null); else renderFolders();
  if (full) {
    log().innerHTML = ''; cardEl = null;
    // Messages and answered cards in the order they happened; the open question last.
    const items = [...(st.messages || []).map(m => ({ at: m.at || '', m })), ...(st.history || []).map(c => ({ at: c.at, c })),
      ...(st.question ? [{ at: st.question.at || '~', c: st.question }] : [])].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    if (!items.length) bubble('her', T('嗨喵～ 想学什么？告诉我科目，我先出几道小题摸摸底。', "Hi, meow~ What do you want to learn? Tell me the subject and I'll start with a few quick questions."));
    for (const it of items) {
      if (it.c) log().appendChild(makeCard(it.c, false));
      else it.m.role === 'user' ? bubble('me', it.m.content) : staticMd('her', speech(it.m.content));
    }
  }
  showQuestion(st.question);
  toBottom();
}
// Her messages render a moment later (React), so scroll again once they have their height.
function toBottom() { log().scrollTop = 1e9; requestAnimationFrame(() => requestAnimationFrame(() => { log().scrollTop = 1e9; })); setTimeout(() => { log().scrollTop = 1e9; }, 200); }

// ---------- One turn: send, then show what comes back in order ----------
function setBusy(b) {
  for (const id of ['studySend', 'mHint', 'mUpload', 'mTired']) el(id).disabled = b;
  cardEl?.querySelectorAll('.qCheck,.qLost').forEach(x => x.disabled = b);
}
// Her thinking faces while the model writes; when it ends she goes back to blinking (a stopped clip would freeze her face).
const thinking = on => {
  const was = document.body.classList.contains('thinking');
  if (on && !was) { document.body.classList.add('thinking'); window.thinkStart?.(); }
  if (!on && was) { document.body.classList.remove('thinking'); act('idle'); }
};

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
      wallet: v => window.chizuWallet?.(v.fish),
      nofish: () => { window.chizuWallet?.(0); act('h_frown'); },
      pause: () => { paused = true; },
    });
    endBubble();
    await Promise.all(speaking); await cardShown;
    return true;
  } catch (e) {
    endBubble();
    bubble('err pop', e.message); act('idle');
    if (pick != null) { cardEl?.querySelectorAll('.choices .picked').forEach(b => b.className = ''); pick = null; }
    return false;
  } finally {
    busy = false; setBusy(false); thinking(false);
    saveCacheSoon();
  }
}
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ''; } })();
const refresh = () => turn({ action: 'state', subjectId: subject, tz: TZ }, null, true);
const next = () => subject && !paused && turn({ action: 'next', subjectId: subject });

function choose(q, i, c) {
  if (busy || pick != null || c !== cardEl) return;
  window.posthog?.capture('question_answered', { kind: 'mcq' });
  pick = i; c.querySelectorAll('.choices button')[i].className = 'picked';
  turn({ action: 'answer', questionId: q.id, choice: i }, 'ABCD'[i] + ') ' + q.options[i]);
}
function submitTyped(q, input) {
  const a = input.value.trim(); if (!a || busy || q.id !== question?.id) return;
  input.value = ''; input.blur();
  turn({ action: 'answer', questionId: q.id, text: a }, a);
}
const hint = () => question && turn({ action: 'hint', questionId: question.id }, T('给个提示', 'Hint, please.'));
el('studySend').onclick = () => {
  const t = el('studyText').value.trim(); if (!t || busy) return;
  el('studyText').value = ''; el('studyText').blur();   // send closes the keyboard, like ChatGPT
  paused = false;
  turn({ action: 'say', subjectId: subject, tz: TZ, ...(window.chizuToday?.() || {}), text: t }, t);
};
el('studyText').onkeydown = e => { if (e.key === 'Enter') el('studySend').click(); };

// ---------- Opening study: last conversation at once from this device, then the server's ----------
const CACHE = 'chizu_v3_cache';
let cacheTimer = 0;
function saveCacheSoon() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(async () => {
    const s = await session(); if (!s) return;
    try { await call({ action: 'state', subjectId: subject, tz: TZ }, { state: st => {
      localStorage.setItem(CACHE, JSON.stringify({ user: s.user.id, st }));
      if (!busy) { subjects = st.subjects || subjects; renderFolders(); dueWatch(); }   // fresh card counts in the folder list
    } }); } catch (_) {}
  }, 1500);
}
async function openStudy() {
  window.posthog?.capture('study_opened'); window.chizuPlayed?.('study');
  openSheet('studySheet');
  const s = await session();
  el('studyAuth').hidden = !!s; el('studyMain').hidden = !s;
  el('studyAcct').hidden = !s;
  if (s && s.user?.is_anonymous) {
    el('studyWho').innerHTML = T('游客模式，换设备会丢记录 · ', 'Guest mode: progress stays on this device · ') + '<button type="button" class="save" id="studySave">' + T('用 Google 保存', 'Save with Google') + '</button>';
    el('studySave').onclick = saveWithGoogle; el('studyOutWrap').hidden = true;
  } else if (s) { el('studyWho').textContent = 'Signed in as ' + (s.user?.email || 'you'); el('studyOutWrap').hidden = false; }
  if (!s) return;
  try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c?.user === s.user.id) applyState(c.st); } catch (_) {}
  try {
    await call({ action: 'state', subjectId: subject, tz: TZ }, { notes_made: v => setTimeout(() => bubble('her pop', T(`昨天的聊天我整理成学习笔记啦（${v.count} 份），点我的头，在菜单「学习笔记」里看喵～`, `I turned yesterday's chat into study notes (${v.count}). Tap my head, then Study notes, meow~`)), 400), state: st => { applyState(st); localStorage.setItem(CACHE, JSON.stringify({ user: s.user.id, st })); } });
  } catch (e) { if (!log().children.length) bubble('err', e.message); return; }
  greet();
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
// ---------- Study notes: each past day's chat, summarized per subject ----------
function noteMd(md) {   // headings, bullet lists and bold, one line at a time
  let out = '', inList = false;
  for (const raw of String(md).split('\n')) {
    const line = esc(raw.trim()).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const li = line.match(/^[-*•]\s+(.*)$/);
    if (li) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + li[1] + '</li>'; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    if (!line) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    out += h ? '<h4>' + h[1] + '</h4>' : '<p>' + line + '</p>';
  }
  return out + (inList ? '</ul>' : '');
}
async function showNotes() {
  closeMenu();
  let p = el('notesPanel');
  if (!p) { p = document.createElement('div'); p.id = 'notesPanel'; p.className = 'notes-panel'; el('studySheet').appendChild(p); }
  p.innerHTML = '<div class="notes-head"><b>' + T('学习笔记', 'Study notes') + '</b><button type="button" class="notes-x" aria-label="Close">×</button></div><div class="notes-list"><p class="notes-empty">' + T('读取中…', 'Loading…') + '</p></div>';
  p.hidden = false; p.querySelector('.notes-x').onclick = () => { p.hidden = true; };
  let notes = [];
  try { await call({ action: 'notes' }, { notes: v => { notes = v.notes || []; } }); } catch (e) { p.querySelector('.notes-list').innerHTML = '<p class="notes-empty">' + esc(e.message) + '</p>'; return; }
  window.posthog?.capture('notes_opened', { count: notes.length });
  p.querySelector('.notes-list').innerHTML = notes.length ? notes.map((n, i) => '<details' + (i ? '' : ' open') + '><summary>' + esc(n.day.slice(5).replace('-', '/')) + (n.subject_name ? ' · ' + esc(n.subject_name) : '') + '</summary><div class="notes-body">' + noteMd(n.summary) + '</div></details>').join('')
    : '<p class="notes-empty">' + T('还没有笔记。今天学的东西，明天会自动整理成笔记放在这里喵。', 'No notes yet. Whatever we study today becomes notes here tomorrow, meow.') + '</p>';
}
// Hint: guess first. The first tap only nudges; tapping again on the same question gets a hint, never the answer.
let nudged = null;
el('mHint').onclick = () => {
  closeMenu(); if (!question) return;
  if (nudged !== question.id) { nudged = question.id; bubble('her pop', T('先猜一个嘛喵，错了也没关系，会变成卡片来练。', 'Have a guess first, meow. Wrong is fine, it turns into a card to practise.')); act('h_tilt'); return; }
  hint();
};
el('mNotes').onclick = () => showNotes();
el('mTired').onclick = () => { closeMenu(); paused = true; turn({ action: 'say', subjectId: subject, tz: TZ, ...(window.chizuToday?.() || {}), text: T('我累了', "I'm tired.") }, T('我累了', "I'm tired.")); };

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
for (const [btn, input] of [['mUpload', 'mFile']]) {
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
  // The same session earns fish on the server: 5 minutes = 1, counted once.
  try { await call({ action: 'focus', sessionId: p.id, started: p.started, seconds }, { wallet: v => window.chizuWallet?.(v.fish) }); } catch (_) {}
};
// Feeding her spends a fish on the server. 'ok', 'nofish', or null when signed out.
window.chizuFeed = async () => {
  if (!(await session())) return null;
  let r = 'nofish';
  try { await call({ action: 'feed' }, { wallet: v => { r = 'ok'; window.chizuWallet?.(v.fish); }, nofish: () => window.chizuWallet?.(0) }); } catch (_) { r = null; }
  return r;
};
// 25 minutes of studying in the chat: a gentle break reminder.
window.chizuBreak = () => { bubble('her pop', T('学了 25 分钟啦喵！伸个懒腰，喝口水，再继续～', "That's 25 minutes, meow! Stretch, drink some water, then we'll keep going.")); act('h_happy'); };
// For previews and console testing.
window.chizuDebug = { show: st => applyState(st, true), card: q => showQuestion(q), verdict: (v, i) => { pick = i; showVerdict(v); } };

// Coming back from Google sign-in opens the study sheet straight away.
if (await finishSignIn()) openStudy();
// Signed in: show her fish from the server.
else if (await session()) call({ action: 'wallet' }, { wallet: v => window.chizuWallet?.(v.fish) }).catch(() => {});
// Her number, if this account reserved one: share cards show it.
if (await session()) sb.rpc('chizu_my_reservation').then(({ data }) => { if (data?.[0]) { window.chizuOwner = true; window.chizuNo = data[0].no; window.chizuName = data[0].name || ''; window.dispatchEvent(new Event('chizu-owner')); } }).catch(() => {});
