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
  // 03: 상담지식 그래프
  btnGraphUser: $('btn-graph-user'),
  btnKgRefresh: $('btn-kg-refresh'),
  kgSnap: $('kg-snap'),
  kgPreset: $('kg-preset'),
  kgParamRow: $('kg-param-row'),
  kgParam: $('kg-param'),
  btnKgRun: $('btn-kg-run'),
  kgCypher: $('kg-cypher'),
  btnKgCypher: $('btn-kg-cypher'),
  kgResult: $('kg-result'),
  kgHint: $('kg-hint'),
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
  el.btnGraphUser.disabled = !state.active;

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

/* ── 03: 상담지식 그래프 — 미리 만들어진 Cypher 프리셋 ───────────────────
 *
 * 서버와의 계약 (server/graph.js):
 *   GET  /api/graph/presets                         프리셋 목록 (id·제목·컬럼·Cypher·params)
 *   GET  /api/graph/snapshot[?refresh=1]            파라미터 없는 프리셋 전부의 캐시 (refresh 면 재조회)
 *   GET  /api/graph/preset/:id?userKey=|keyword=    파라미터 프리셋 즉시 실행
 *   POST /api/graph/cypher {cypher}                 사용자 Cypher (읽기전용, MATCH 로 시작)
 *
 * 조회는 게이트웨이가 떠 있어도 된다(CLI v1.1.0 — 게이트웨이 조회 API 자동 경유). 파라미터 없는 프리셋은
 * 스냅샷으로 한 번에 받아 두고 화면에서 캐시를 넘겨 보며, 새로고침이 다시 조회한다.
 */

const kg = { presets: [], snapshot: null, current: null };

function presetById(id) {
  return kg.presets.find((p) => p.id === id);
}

function renderKgTable({ title, columns, rows, cypher, error, note }) {
  el.kgResult.innerHTML = '';
  if (error) {
    el.kgResult.innerHTML = `<div class="empty small"><p class="err">${esc(error)}</p></div>`;
    return;
  }
  const head = document.createElement('div');
  head.className = 'kg-title';
  head.innerHTML = `<b>${esc(title)}</b>${note ? ` <span class="muted">${esc(note)}</span>` : ''}`;
  el.kgResult.appendChild(head);

  if (!rows || !rows.length) {
    el.kgResult.innerHTML += '<div class="empty small"><p>결과가 없습니다.</p></div>';
  } else {
    const table = document.createElement('table');
    table.className = 'kg-table';
    const cols = columns && columns.length ? columns : rows[0].map((_, i) => `col${i + 1}`);
    table.innerHTML =
      `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${cols.map((_, i) => `<td>${renderText(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
    el.kgResult.appendChild(table);
    const count = document.createElement('div');
    count.className = 'kg-count';
    count.textContent = `${rows.length}행`;
    el.kgResult.appendChild(count);
  }

  if (cypher) {
    const d = document.createElement('details');
    d.className = 'kg-cypher';
    d.innerHTML = `<summary>Cypher 보기</summary><pre>${esc(cypher)}</pre>`;
    el.kgResult.appendChild(d);
  }
}

function showSnapshotPreset(id) {
  const p = presetById(id);
  if (!p || !kg.snapshot) return;
  const rows = kg.snapshot.results[id];
  const err = kg.snapshot.errors[id];
  kg.current = id;
  if (err) renderKgTable({ error: `${p.title}: ${err}` });
  else renderKgTable({ title: p.title, note: p.description, columns: p.columns, rows, cypher: p.cypher });
}

function updateSnapLabel() {
  if (!kg.snapshot || !kg.snapshot.at) { el.kgSnap.textContent = ''; return; }
  const d = new Date(kg.snapshot.at);
  const stats = (kg.snapshot.results.stats || []).map((r) => `${r[0]} ${r[1]}`).join(' · ');
  el.kgSnap.textContent = `— 스냅샷 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${stats ? ` · ${stats}` : ''}`;
}

function onPresetChange() {
  const p = presetById(el.kgPreset.value);
  if (!p) return;
  if (p.params) {
    el.kgParamRow.hidden = false;
    const name = p.params[0];
    el.kgParam.placeholder = name === 'userKey' ? 'userKey (열린 상담방이 있으면 자동 입력)' : '키워드 (예: 서명, 401, schedule)';
    if (name === 'userKey' && state.active) el.kgParam.value = state.active;
    renderKgTable({ title: p.title, note: p.description, columns: p.columns, rows: [], cypher: p.cypher });
    el.kgParam.focus();
  } else {
    el.kgParamRow.hidden = true;
    showSnapshotPreset(p.id);
  }
}

async function kgLoadPresets() {
  const { presets } = await api('/api/graph/presets');
  kg.presets = presets;
  el.kgPreset.innerHTML = '';
  const groups = [['스냅샷 (즉시)', presets.filter((p) => !p.params)], ['조건 조회', presets.filter((p) => p.params)]];
  for (const [label, list] of groups) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.title;
      og.appendChild(o);
    }
    el.kgPreset.appendChild(og);
  }
}

async function kgLoadSnapshot(refresh = false) {
  el.btnKgRefresh.disabled = true;
  if (refresh) el.kgHint.textContent = '프리셋을 다시 실행하는 중…';
  try {
    const { snapshot } = await api(`/api/graph/snapshot${refresh ? '?refresh=1' : ''}`);
    kg.snapshot = snapshot;
    updateSnapLabel();
    if (!snapshot.at) {
      const { status } = await api('/api/graph/status');
      const ready = status.active && status.libInstalled;
      renderKgTable({ error: ready ? '스냅샷이 아직 없습니다 — 새로고침을 누르세요.' : `그래프 미준비 — ${status.ok ? `활성:${status.active} · lib:${status.lib ?? '없음'}` : status.error} (README §2: npm run knowledge:install)` });
      return;
    }
    const cur = kg.current && !presetById(kg.current)?.params ? kg.current : 'stats';
    el.kgPreset.value = cur;
    showSnapshotPreset(cur);
    if (refresh) logEvent('reference', `그래프 스냅샷 갱신 · ${snapshot.ms}ms`);
  } catch (err) {
    renderKgTable({ error: `스냅샷 조회 실패: ${err.message}` });
    logEvent('error', `그래프 스냅샷 실패: ${err.message}`);
  } finally {
    el.btnKgRefresh.disabled = false;
  }
}

async function kgRunParamPreset() {
  const p = presetById(el.kgPreset.value);
  if (!p || !p.params) return;
  const value = el.kgParam.value.trim();
  if (!value) { el.kgParam.focus(); return; }
  el.btnKgRun.disabled = true;
  renderKgTable({ title: p.title, note: '조회 중…', columns: p.columns, rows: [] });
  try {
    const r = await api(`/api/graph/preset/${p.id}?${p.params[0]}=${encodeURIComponent(value)}`);
    renderKgTable({ title: `${p.title} · ${value}`, note: p.description, columns: r.columns, rows: r.rows, cypher: r.cypher });
    logEvent('reference', `그래프 프리셋 · ${p.title} · ${value}`);
  } catch (err) {
    renderKgTable({ error: `${p.title} 실패: ${err.message}` });
  } finally {
    el.btnKgRun.disabled = false;
  }
}

async function kgRunCypher() {
  const cypher = el.kgCypher.value.trim();
  if (!cypher) { el.kgCypher.focus(); return; }
  el.btnKgCypher.disabled = true;
  renderKgTable({ title: 'Cypher', note: '실행 중…', rows: [] });
  try {
    const r = await api('/api/graph/cypher', { method: 'POST', body: JSON.stringify({ cypher }) });
    renderKgTable({ title: 'Cypher', columns: r.columns, rows: r.rows, cypher: r.cypher });
    logEvent('reference', `그래프 Cypher · ${r.rows.length}행`);
  } catch (err) {
    renderKgTable({ error: `Cypher 실패: ${err.message}` });
  } finally {
    el.btnKgCypher.disabled = false;
  }
}

el.kgPreset.addEventListener('change', onPresetChange);
el.btnKgRun.addEventListener('click', kgRunParamPreset);
el.kgParam.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); kgRunParamPreset(); } });
el.btnKgCypher.addEventListener('click', kgRunCypher);
el.btnKgRefresh.addEventListener('click', () => kgLoadSnapshot(true));

// 열려 있는 상담방의 고객 타임라인을 프리셋으로 조회한다.
el.btnGraphUser.addEventListener('click', () => {
  if (!state.active) return;
  el.kgPreset.value = 'customer-timeline';
  onPresetChange();
  el.kgParam.value = state.active;
  kgRunParamPreset();
});

async function kgBoot() {
  try {
    await kgLoadPresets();
    await kgLoadSnapshot(false);
    el.kgHint.textContent = '';
  } catch (err) {
    renderKgTable({ error: `그래프 패널 초기화 실패: ${err.message}` });
  }
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
  kgBoot(); // 03: 프리셋 목록 + 스냅샷
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
