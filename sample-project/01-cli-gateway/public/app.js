/*
 * TalkBridge 채팅상담 샘플 — 프론트엔드 (프레임워크 없음, 바닐라 JS)
 *
 * 서버와의 계약:
 *   GET  /api/me                          내 정보(CLI whoami)
 *   GET  /api/rooms                       상담방 목록(CLI rooms)
 *   GET  /api/rooms/:userKey/messages     대화 내용(CLI rooms --user)
 *   POST /api/send    {userKey, text}     발신(CLI send)
 *   POST /api/end     {userKey, event?}   종료+봇전환(CLI end-with-bot)
 *   POST /api/block   {userKey}           차단(CLI block)
 *   GET  /api/events                      SSE — 게이트웨이 수신 실시간 푸시
 */

'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  connDot: $('conn-dot'),
  meta: $('meta'),
  roomList: $('room-list'),
  roomsHint: $('rooms-hint'),
  threadTitle: $('thread-title'),
  messages: $('messages'),
  composer: $('composer'),
  input: $('input'),
  btnSend: $('btn-send'),
  btnEnd: $('btn-end'),
  btnBlock: $('btn-block'),
  btnRefresh: $('btn-refresh'),
  eventLog: $('event-log'),
};

const state = {
  rooms: [],
  active: null,      // userKey
  messages: [],
  sending: false,
};

/* ── 유틸 ─────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 고객이 보낸 이미지는 별도 필드가 아니라 본문 text 안에 URL 로 들어온다.
 * URL 을 링크로 만들고, 이미지 확장자면 썸네일까지 붙인다.
 */
function renderText(text) {
  const raw = String(text ?? '');
  let html = esc(raw);
  const urls = raw.match(/https?:\/\/[^\s<>"']+/g) || [];

  html = html.replace(/https?:\/\/[^\s<>&]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);

  for (const u of urls) {
    if (/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u)) {
      html += `<img src="${esc(u)}" alt="첨부 이미지" loading="lazy">`;
    }
  }
  return html;
}

function timeOf(m) {
  if (m.atRaw) return m.atRaw;
  if (!m.at) return '';
  const d = new Date(m.at);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
         `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function logEvent(kind, text) {
  const li = document.createElement('li');
  li.className = `k-${kind}`;
  const t = new Date();
  li.innerHTML = `<time>${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</time>${esc(text)}`;
  el.eventLog.prepend(li);
  while (el.eventLog.children.length > 120) el.eventLog.lastChild.remove();
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || body.ok === false) throw new Error(body.error || body.raw || `HTTP ${res.status}`);
  return body;
}

/* ── 렌더 ─────────────────────────────────────────────────────────── */

function renderRooms() {
  el.roomList.innerHTML = '';

  if (!state.rooms.length) {
    el.roomsHint.textContent = '상담방이 없습니다. 고객이 카카오톡에서 문의를 보내면 여기에 나타납니다.';
    return;
  }
  el.roomsHint.textContent = `${state.rooms.length}개 · CLI rooms 기준`;

  for (const r of state.rooms) {
    const li = document.createElement('li');
    li.className = 'room' + (r.userKey === state.active ? ' active' : '');
    li.dataset.userKey = r.userKey;

    const badges = [];
    if (r.unread > 0) badges.push(`<span class="badge unread">${r.unread}</span>`);
    badges.push(`<span class="badge ${r.ended ? '' : 'live'}">${esc(r.status || '')}</span>`);

    li.innerHTML =
      `<div class="room-top">
         <span class="room-key">${esc(r.userKey)}</span>
         <span>${badges.join('')}</span>
       </div>
       <div class="room-last">${esc(r.lastText || '(내용 없음)')}</div>`;

    li.addEventListener('click', () => selectRoom(r.userKey));
    el.roomList.appendChild(li);
  }
}

function renderMessages() {
  if (!state.active) return;

  if (!state.messages.length) {
    el.messages.innerHTML = '<div class="empty"><p>아직 메시지가 없습니다.</p></div>';
    return;
  }

  el.messages.innerHTML = '';
  for (const m of state.messages) {
    const dir = m.direction || (m.kind === 'agent' ? 'out' : 'in');
    const div = document.createElement('div');
    div.className = `msg ${dir}` + (m.pending ? ' pending' : '');

    const seq = m.seq != null ? `#${m.seq} ` : '';
    div.innerHTML =
      `<div class="bubble">${renderText(m.text)}</div>
       <div class="msg-meta">${seq}${esc(timeOf(m))}${m.pending ? ' · 전송중' : ''}</div>`;

    el.messages.appendChild(div);
  }
  el.messages.scrollTop = el.messages.scrollHeight;
}

function updateComposer() {
  const room = state.rooms.find((r) => r.userKey === state.active);
  const canSend = Boolean(state.active) && !state.sending;

  el.input.disabled = !canSend;
  el.btnSend.disabled = !canSend;
  el.btnEnd.disabled = !state.active;
  el.btnBlock.disabled = !state.active;

  if (room && room.ended) {
    $('send-hint').textContent =
      '이 상담은 종료 상태입니다. 카카오 상담톡은 활성 세션에만 발신되므로 전송이 실패할 수 있습니다.';
  } else {
    $('send-hint').textContent =
      '활성 세션에만 발신할 수 있습니다. 발신은 상담 건수를 소진합니다.';
  }
}

/* ── 동작 ─────────────────────────────────────────────────────────── */

async function loadRooms() {
  try {
    const { rooms } = await api('/api/rooms');
    state.rooms = rooms;
    renderRooms();
  } catch (err) {
    logEvent('error', `상담방 조회 실패: ${err.message}`);
    el.roomsHint.textContent = `조회 실패: ${err.message}`;
  }
}

async function selectRoom(userKey) {
  state.active = userKey;
  el.threadTitle.textContent = userKey;
  el.messages.innerHTML = '<div class="empty"><p>불러오는 중…</p></div>';
  renderRooms();
  updateComposer();

  try {
    const { messages } = await api(`/api/rooms/${encodeURIComponent(userKey)}/messages`);
    state.messages = messages;
    const room = state.rooms.find((r) => r.userKey === userKey);
    if (room) room.unread = 0;
    renderRooms();
    renderMessages();
  } catch (err) {
    el.messages.innerHTML = `<div class="empty"><p>대화를 불러오지 못했습니다.</p><p class="muted">${esc(err.message)}</p></div>`;
    logEvent('error', `대화 조회 실패: ${err.message}`);
  }
}

async function send(text) {
  const userKey = state.active;
  if (!userKey || !text.trim()) return;

  state.sending = true;
  updateComposer();

  // 낙관적 표시 — 확정은 게이트웨이가 되돌려주는 kind:"agent" echo 로 갱신된다.
  state.messages.push({ seq: null, kind: 'agent', direction: 'out', text, at: new Date().toISOString(), pending: true });
  renderMessages();

  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify({ userKey, text }) });
    logEvent('agent', `발신 완료 → ${userKey}`);
  } catch (err) {
    state.messages = state.messages.filter((m) => !m.pending);
    renderMessages();
    logEvent('error', `발신 실패: ${err.message}`);
    alert(`발신 실패\n\n${err.message}`);
  } finally {
    state.sending = false;
    updateComposer();
    el.input.focus();
  }
}

/* ── 실시간(SSE) ──────────────────────────────────────────────────── */

function connect() {
  const es = new EventSource('/api/events');

  es.onopen = () => {
    el.connDot.className = 'dot live';
    logEvent('reference', '실시간 채널 연결됨');
  };

  es.onerror = () => {
    el.connDot.className = 'dot down';
  };

  es.addEventListener('inbound', (e) => {
    const d = JSON.parse(e.data);
    logEvent(d.kind, `${d.kind} · ${d.userKey} #${d.seq}`);

    // 방 목록 갱신
    const i = state.rooms.findIndex((r) => r.userKey === d.userKey);
    if (i >= 0) state.rooms[i] = { ...state.rooms[i], ...d.room };
    else state.rooms.unshift(d.room);
    state.rooms.sort((a, b) => (b.lastSeq || 0) - (a.lastSeq || 0));

    // 열려 있는 방이면 대화도 갱신
    if (d.userKey === state.active) {
      state.messages = d.messages;
      const room = state.rooms.find((r) => r.userKey === d.userKey);
      if (room) room.unread = 0;
      renderMessages();
    }
    renderRooms();
  });

  es.addEventListener('sent', (e) => {
    const d = JSON.parse(e.data);
    logEvent('agent', `send 반영 · ${d.userKey}`);
  });
}

/* ── 부팅 ─────────────────────────────────────────────────────────── */

async function boot() {
  try {
    const { me, brand, cli } = await api('/api/me');
    el.meta.textContent = `${brand} · ${me.scope} · ${cli} · ${me.endpoint}`;
  } catch (err) {
    el.meta.textContent = `CLI 확인 실패: ${err.message}`;
    logEvent('error', `whoami 실패: ${err.message}`);
  }

  await loadRooms();
  connect();
  updateComposer();
}

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.input.value;
  el.input.value = '';
  send(text);
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

el.btnRefresh.addEventListener('click', loadRooms);

el.btnEnd.addEventListener('click', async () => {
  if (!state.active) return;
  if (!confirm(`${state.active} 상담을 종료할까요?\n(end-with-bot — 종료 후 봇 시나리오로 전환)`)) return;
  try {
    await api('/api/end', { method: 'POST', body: JSON.stringify({ userKey: state.active }) });
    logEvent('ended', `상담 종료 · ${state.active}`);
    await loadRooms();
  } catch (err) {
    logEvent('error', `종료 실패: ${err.message}`);
    alert(`종료 실패\n\n${err.message}`);
  }
});

el.btnBlock.addEventListener('click', async () => {
  if (!state.active) return;
  if (!confirm(`${state.active} 를 차단할까요?`)) return;
  try {
    await api('/api/block', { method: 'POST', body: JSON.stringify({ userKey: state.active }) });
    logEvent('ended', `차단 · ${state.active}`);
  } catch (err) {
    logEvent('error', `차단 실패: ${err.message}`);
    alert(`차단 실패\n\n${err.message}`);
  }
});

boot();
