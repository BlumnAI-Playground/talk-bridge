/*
 * TalkBridge 채팅상담 샘플 — 프론트엔드 (프레임워크 없음, 바닐라 JS)
 *
 * 서버와의 계약:
 *   GET  /api/me                          내 정보(CLI whoami)
 *   GET  /api/rooms                       상담방 목록(CLI rooms)
 *   GET  /api/rooms/:userKey/messages     대화 내용(CLI rooms --user)
 *   POST /api/send    {userKey, text}     발신(CLI send) → { serial }
 *   POST /api/send/attachments {userKey, text?, files[{name,type,dataBase64}]}
 *                                         첨부 발신(CLI send --file …) → { results[] }
 *   POST /api/delete  {userKey, serial}   발신 취소(CLI delete) — 24시간 이내
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
  btnAttach: $('btn-attach'),
  fileInput: $('file-input'),
  attachTray: $('attach-tray'),
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
  files: [],         // 보낼 첨부 File[]
};

const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000; // 발신 취소는 발송 후 24시간까지
const ECHO_WAIT_MS = 5000; // 이 시간 안에 agent echo 가 안 오면 대화를 다시 조회해 확정한다

/* ── 유틸 ─────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 본문의 URL 은 링크로만 만든다 — 임의 URL 을 <img> 로 띄우지 않는다(고객이 입력한 링크일 수 있다). */
function renderText(text) {
  return esc(text).replace(/https?:\/\/[^\s<>&]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);
}

const ATTACH_LABEL = { photo: '사진', video: '동영상', audio: '음성', file: '파일' };

/**
 * 고객 첨부는 본문 text 안에 "[photo] 카카오CDN URL" 줄로 들어온다.
 * 서버(api.js parseAttachments)가 카카오 CDN 호스트만 골라 m.attachments 로 올려 주므로,
 * 그 줄은 본문에서 빼고 사진은 썸네일, 나머지는 링크 칩으로 그린다.
 * 묶음사진은 한 메시지에 여러 줄 → 썸네일 여러 장. CDN URL 은 영구 주소가 아니다.
 */
function renderBody(m) {
  const atts = m.attachments || [];
  if (!atts.length) return renderText(m.text);

  const urls = new Set(atts.map((a) => a.url));
  const rest = String(m.text ?? '').split('\n')
    .filter((line) => {
      const hit = /^\[(?:photo|video|audio|file)\] (\S+)/.exec(line.trim());
      if (!hit) return true;
      try { return !urls.has(new URL(hit[1]).href); } catch { return true; }
    })
    .join('\n').trim();

  const items = atts.map((a) => {
    const href = esc(a.url);
    const cap = a.comment ? `<span class="caption">${esc(a.comment)}</span>` : '';
    if (a.type === 'photo') {
      return `<a class="photo" href="${href}" target="_blank" rel="noreferrer"><img src="${href}" alt="고객 사진" loading="lazy"></a>${cap}`;
    }
    return `<a class="file-chip" href="${href}" target="_blank" rel="noreferrer">${ATTACH_LABEL[a.type] || esc(a.type)} 열기</a>${cap}`;
  });
  return (rest ? renderText(rest) : '') + `<div class="attachments">${items.join('')}</div>`;
}

/** 지울 말풍선 serial 목록 — 묶음 첨부 발신은 장마다 serial 이 따로 있고, 삭제도 장마다 한다. */
function serialsOf(m) {
  if (Array.isArray(m.serials) && m.serials.length > 1) {
    return m.serials.filter((s) => !(m.deletedSerials || []).includes(s));
  }
  return m.serial ? [m.serial] : [];
}

function canDelete(m) {
  // 확인 대기(pending)여도 serial 이 있으면 발신은 성공한 것 — 바로 취소할 수 있다
  if (m.direction !== 'out' || !m.serial || m.deleted) return false;
  const at = m.at ? Date.parse(m.at) : NaN;
  return Number.isNaN(at) || Date.now() - at < DELETE_WINDOW_MS;
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
    div.className = `msg ${dir}` + (m.pending ? ' pending' : '') + (m.deleted ? ' deleted' : '');

    const seq = m.seq != null ? `#${m.seq} ` : '';
    const del = canDelete(m)
      ? `<button type="button" class="del" data-serials="${esc(serialsOf(m).join(' '))}" title="CLI delete --serial">발신 취소</button>`
      : '';
    div.innerHTML =
      `<div class="bubble">${renderBody(m)}</div>
       <div class="msg-meta">${seq}${esc(timeOf(m))}${m.pending ? (m.serial ? ' · 전송됨(확인 대기)' : ' · 전송중') : ''}${m.deleted ? ' · 삭제됨' : ''}${del}</div>`;

    el.messages.appendChild(div);
  }
  el.messages.scrollTop = el.messages.scrollHeight;
}

function updateComposer() {
  const room = state.rooms.find((r) => r.userKey === state.active);
  const canSend = Boolean(state.active) && !state.sending;

  el.input.disabled = !canSend;
  el.btnSend.disabled = !canSend;
  el.btnAttach.disabled = !canSend;
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

/** 열린 방의 대화를 화면 깜빡임 없이 다시 조회한다. */
async function reloadMessages(userKey) {
  if (state.active !== userKey) return;
  try {
    const { messages } = await api(`/api/rooms/${encodeURIComponent(userKey)}/messages`);
    if (state.active === userKey) {
      state.messages = messages;
      renderMessages();
    }
  } catch (err) {
    logEvent('error', `대화 재조회 실패: ${err.message}`);
  }
}

/**
 * 발신 확정은 원래 kind:"agent" echo(웹훅)가 한다. 웹훅이 안 오는 환경
 * (게이트웨이 sink 미구성·재시작 전 등)에서도 화면이 "전송중"에 멈추지 않도록
 * 잠시 뒤 대화를 다시 조회한다. echo 가 이미 왔다면 같은 내용이 다시 그려질 뿐이다.
 */
function confirmLater(userKey) {
  setTimeout(() => {
    if (state.active !== userKey) return;
    if (!state.messages.some((m) => m.pending) && !confirmLater.attach) return;
    confirmLater.attach = false;
    logEvent('agent', 'echo 대기 시간 초과 — 대화를 다시 조회해 확정합니다');
    reloadMessages(userKey);
  }, ECHO_WAIT_MS);
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
  if (!userKey) return;
  if (state.files.length) return sendAttachments(text);
  if (!text.trim()) return;

  state.sending = true;
  updateComposer();

  // 낙관적 표시 — 확정은 게이트웨이가 되돌려주는 kind:"agent" echo 로 갱신된다.
  const optimistic = { seq: null, kind: 'agent', direction: 'out', text, at: new Date().toISOString(), pending: true };
  state.messages.push(optimistic);
  renderMessages();

  try {
    const { serial } = await api('/api/send', { method: 'POST', body: JSON.stringify({ userKey, text }) });
    optimistic.serial = serial;
    renderMessages(); // serial 이 생겼으니 발신 취소 버튼을 바로 보인다
    confirmLater(userKey);
    logEvent('agent', `발신 완료 → ${userKey}${serial ? ` · ${serial}` : ''}`);
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

/* ── 첨부 ─────────────────────────────────────────────────────────── */

function renderTray() {
  el.attachTray.innerHTML = '';
  state.files.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const thumb = f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">` : '';
    chip.innerHTML = `${thumb}${esc(f.name)} <span class="muted">${Math.ceil(f.size / 1024)}KB</span>`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ghost';
    x.textContent = '×';
    x.title = '빼기';
    x.addEventListener('click', () => { state.files.splice(i, 1); renderTray(); });
    chip.appendChild(x);
    el.attachTray.appendChild(chip);
  });
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * 첨부 발신 — 이미지·파일을 한 번에 보낸다. text 는 첫 말풍선에 실린다(이미지면 캡션).
 * 말풍선마다 결과(serial)가 따로 온다. 일부만 실패하면 실패한 장만 다시 보내면 된다.
 * 낙관적 말풍선은 그리지 않는다 — 화면 반영은 kind:"agent" echo 가 한다.
 */
async function sendAttachments(text) {
  const userKey = state.active;
  const files = state.files.slice();
  state.sending = true;
  updateComposer();

  try {
    const payload = {
      userKey,
      text: text.trim() || undefined,
      files: await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, dataBase64: await toBase64(f) }))),
    };
    const { results } = await api('/api/send/attachments', { method: 'POST', body: JSON.stringify(payload) });
    state.files = [];
    renderTray();
    confirmLater.attach = true; // 첨부는 낙관적 말풍선이 없으니 echo 가 없으면 재조회로 보인다
    confirmLater(userKey);

    const failed = results.filter((r) => !r.ok);
    logEvent('agent', `첨부 발신 ${results.length - failed.length}/${results.length} → ${userKey}`);
    if (failed.length) {
      alert(`일부 첨부가 전송되지 않았습니다\n\n${failed.map((r) => `· ${r.kind}: ${r.message || r.code}`).join('\n')}`);
    }
  } catch (err) {
    if (!el.input.value) el.input.value = text; // 실패하면 캡션을 되돌려 둔다(첨부 목록은 그대로)
    logEvent('error', `첨부 발신 실패: ${err.message}`);
    alert(`첨부 발신 실패\n\n${err.message}`);
  } finally {
    state.sending = false;
    updateComposer();
    el.input.focus();
  }
}

/* ── 발신 취소 ────────────────────────────────────────────────────── */

async function deleteSent(serials) {
  const userKey = state.active;
  if (!userKey || !serials.length) return;
  const what = serials.length > 1 ? `말풍선 ${serials.length}개(묶음 첨부)를` : '이 메시지를';
  if (!confirm(`${what} 삭제할까요?\n\n고객 채팅방에 「메시지가 삭제되었습니다」 안내가 남고, 상담 건수는 돌아오지 않습니다.`)) return;

  // 삭제 단위는 말풍선 1개 — 한 번 호출로 묶음 전체가 지워지지 않는다.
  for (const serial of serials) {
    try {
      await api('/api/delete', { method: 'POST', body: JSON.stringify({ userKey, serial }) });
      logEvent('deleted', `발신 취소 · ${serial}`);
    } catch (err) {
      logEvent('error', `발신 취소 실패 ${serial}: ${err.message}`);
      alert(`발신 취소 실패\n\n${err.message}`);
      return;
    }
  }
  // 확정 표시는 kind:"deleted" 웹훅이 한다. 그 전까지 화면에서도 바로 지운 것처럼 보이게 한다.
  for (const m of state.messages) if (serials.includes(m.serial)) m.deleted = true;
  renderMessages();
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

  es.addEventListener('ack', (e) => {
    const d = JSON.parse(e.data);
    logEvent('agent', `발신 접수 · ${d.userKey}${d.serial ? ` · ${d.serial}` : ''}`);
  });

  es.addEventListener('test', (e) => {
    const d = JSON.parse(e.data);
    logEvent('reference', `연결 테스트 신호 · ${d.userKey} — 서명 통과`);
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

el.btnAttach.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', () => {
  state.files.push(...el.fileInput.files);
  el.fileInput.value = '';
  renderTray();
});

el.messages.addEventListener('click', (e) => {
  const btn = e.target.closest('button.del');
  if (btn) deleteSent(btn.dataset.serials.split(' ').filter(Boolean));
});

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
