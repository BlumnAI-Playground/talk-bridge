/*
 * TalkBridge Jev 자동응대봇 샘플 — 프론트엔드 (프레임워크 없음, 바닐라 JS)
 *
 * 서버와의 계약:
 *   GET  /api/me                              CLI whoami + Jev 상태(모델·키 출처 — 키는 마스킹)
 *   GET  /api/bot/rules                       자동응대 규칙
 *   PUT  /api/bot/rules                       규칙 저장 (서버가 정규화하고 warnings 를 돌려준다)
 *   POST /api/bot/rules/reset                 데모 규칙으로 초기화
 *   POST /api/sim/message  {simId, text}      시뮬레이터 한 턴 (카카오 발신 없음 · Jev 만 호출)
 *   POST /api/sim/reset    {simId}
 *   GET  /api/sim/request?simId=&text=        다음 턴에 Jev 로 보낼 요청 본문
 *   GET  /api/rooms · /api/rooms/:u/messages  실제 상담방 (CLI rooms --json)
 *   GET  /api/bot/activity                    최근 봇 활동 + 방별 봇 상태
 *   POST /api/bot/rooms/:u/pause|resume       방별 봇 정지·재개
 *   POST /api/send         {userKey, text}    상담원 직접 답장 (그 방의 봇은 정지)
 *   GET  /api/events                          SSE — inbound · bot · bot-state · rules
 */

'use strict';

const $ = (id) => document.getElementById(id);

const AFTER = { stay: '계속 대화', handoff: '상담원 연결', end: '상담 종료(봇 전환)' };
const BUILTIN = { greeting: '인사', thanks: '감사·마무리', none: '해당 없음', off_topic: '질문과 무관' };
const ROUTE = {
  faq: 'FAQ 답변', 'flow-start': '시나리오 시작', 'flow-start+prefill': '시나리오 시작 · 첫 단계 건너뜀', step: '단계 진행',
  'flow-done': '시나리오 완료', 'side-faq': '곁가지 FAQ 후 복귀', switch: '시나리오 전환', 'switch+prefill': '전환 · 첫 단계 건너뜀',
  confirmed: '확인됨', 'confirmed+prefill': '확인됨', clarify: '되묻기', reask: '다시 묻기', fallback: '모를 때',
  greeting: '인사', thanks: '감사', human: '상담원 요청', angry: '불만 → 상담원', keyword: '연결 키워드', 'reask-limit': '다시 묻기 한도',
};

const state = {
  rules: null,
  savedJson: '',
  warnings: [],
  ai: null,
  sel: 'faq:0',
  view: 'rules',
  simId: `web-${Math.random().toString(36).slice(2, 10)}`,
  simBusy: false,
  // 모니터
  rooms: [],
  bot: {},          // userKey → 봇 상태
  activity: [],
  active: null,
  messages: [],
  sending: false,
  unseen: 0,
};

/* ── 유틸 ─────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderText(text) {
  const raw = String(text ?? '');
  let html = esc(raw).replace(/https?:\/\/[^\s<>&]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);
  for (const u of raw.match(/https?:\/\/[^\s<>"']+/g) || []) {
    if (/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u)) html += `<img src="${esc(u)}" alt="첨부 이미지" loading="lazy">`;
  }
  return html.replace(/\n/g, '<br>');
}

const pad = (n) => String(n).padStart(2, '0');
function hm(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const pct = (v) => (v == null ? '-' : `${Math.round(Number(v) * 100)}%`);

async function api(path, options) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || body.ok === false) throw new Error(body.error || body.raw || `HTTP ${res.status}`);
  return body;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

const isDirty = () => state.rules && JSON.stringify(state.rules) !== state.savedJson;

/** Jev 선택지 id → 사람이 읽는 이름 (FAQ 제목 · 시나리오 이름 · 선택지 라벨 · 내장) */
function labelOf(id) {
  const r = state.rules;
  if (!r) return id;
  if (BUILTIN[id]) return BUILTIN[id];
  const f = r.faqs.find((x) => x.id === id);
  if (f) return `FAQ · ${f.title}`;
  const fl = r.flows.find((x) => x.id === id);
  if (fl) return `시나리오 · ${fl.name}`;
  for (const x of r.flows) for (const st of x.steps) {
    const o = st.options.find((y) => y.id === id);
    if (o) return o.label;
  }
  return id;
}

/* ── 규칙 로드·저장 ───────────────────────────────────────────────── */

function clampSel() {
  const r = state.rules;
  const [kind, n] = state.sel.split(':');
  const len = kind === 'faq' ? r.faqs.length : kind === 'flow' ? r.flows.length : null;
  if (len == null) return;
  if (!len) state.sel = kind === 'faq' ? (r.flows.length ? 'flow:0' : 'persona') : (r.faqs.length ? 'faq:0' : 'persona');
  else if (Number(n) >= len) state.sel = `${kind}:${len - 1}`;
}

function applyRules(rules, warnings = []) {
  state.rules = rules;
  state.savedJson = JSON.stringify(rules);
  state.warnings = warnings;
  clampSel();
  renderAll();
}

async function loadRules() {
  const { rules, ai } = await api('/api/bot/rules');
  state.ai = ai;
  applyRules(rules);
}

async function saveRules() {
  if (!state.rules) return;
  $('btn-save').disabled = true;
  try {
    const { rules, warnings, ai } = await api('/api/bot/rules', { method: 'PUT', body: JSON.stringify(state.rules) });
    state.ai = ai;
    applyRules(rules, warnings);
    flashHint(warnings.length ? `저장됨 · 확인할 점 ${warnings.length}개` : '저장됨');
  } catch (err) {
    alert(`저장 실패\n\n${err.message}`);
    updateDirty();
  }
}

function flashHint(text) {
  $('save-hint').textContent = `${text} · ${hm(new Date())}`;
}

function updateDirty() {
  $('btn-save').disabled = !isDirty();
  $('btn-save').textContent = isDirty() ? '저장 *' : '저장';
}

/* ── 상단 ─────────────────────────────────────────────────────────── */

function renderTop() {
  const s = state.rules.settings;
  $('sw-enabled').checked = s.enabled;
  $('sw-live').checked = s.live;

  const ai = state.ai;
  const chip = $('ai-chip');
  if (!ai) return;
  chip.className = `chip ${ai.ready ? 'ok' : 'bad'}`;
  chip.textContent = ai.ready ? `${ai.model} · 자동 ≥ ${s.autoThreshold} · 되묻기 ≥ ${s.confirmThreshold}` : 'Jev 키 없음';
  chip.title = ai.ready ? `키 ${ai.keyMasked} (${ai.keySource})\n${ai.baseUrl}` : ai.keyError;
}

/* ── 좌: 내비 ─────────────────────────────────────────────────────── */

function renderNav() {
  const r = state.rules;
  $('cnt-faqs').textContent = r.faqs.length;
  for (const li of $('nav-basic').children) li.classList.toggle('active', li.dataset.sel === state.sel);

  const fill = (ul, items, kind, name, count) => {
    ul.innerHTML = '';
    items.forEach((x, i) => {
      const li = document.createElement('li');
      li.dataset.sel = `${kind}:${i}`;
      li.className = state.sel === li.dataset.sel ? 'active' : '';
      li.innerHTML = `<span class="sdot ${x.enabled ? '' : 'off'}"></span><span class="sname">${esc(name(x) || '이름 없음')}</span><span class="count">${count(x)}</span>`;
      ul.appendChild(li);
    });
    if (!items.length) ul.innerHTML = '<li class="muted" style="cursor:default">없습니다</li>';
  };
  fill($('nav-faqs'), r.faqs, 'faq', (f) => f.title, (f) => AFTER[f.after] === '계속 대화' ? '' : AFTER[f.after]);
  fill($('nav-flows'), r.flows, 'flow', (f) => f.name, (f) => `${f.steps.length}단계`);
}

/* ── 중: 편집기 ───────────────────────────────────────────────────── */

const field = (label, inner, help = '') =>
  `<div class="field"><label>${label}</label>${inner}${help ? `<div class="help">${help}</div>` : ''}</div>`;
const text = (path, ph = '') => `<input type="text" data-path="${path}" value="${esc(getPath(state.rules, path))}" placeholder="${esc(ph)}">`;
const area = (path, rows = 3, ph = '') => `<textarea rows="${rows}" data-path="${path}" placeholder="${esc(ph)}">${esc(getPath(state.rules, path))}</textarea>`;
const lines = (path, rows = 3, ph = '') => `<textarea rows="${Math.max(rows, (getPath(state.rules, path) || []).length)}" data-path="${path}" data-kind="lines" placeholder="${esc(ph)}">${esc((getPath(state.rules, path) || []).join('\n'))}</textarea>`;
const csv = (path, ph = '') => `<input type="text" data-path="${path}" data-kind="csv" value="${esc(getPath(state.rules, path).join(', '))}" placeholder="${esc(ph)}">`;
const afterSelect = (path) => `<select data-path="${path}">${Object.entries(AFTER).map(([v, l]) =>
  `<option value="${v}" ${getPath(state.rules, path) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
const tools = (list, i, len) => `
  <div class="card-tools">
    <button class="icon" data-act="move" data-list="${list}" data-i="${i}" data-d="-1" title="위로" ${i === 0 ? 'disabled' : ''}>▲</button>
    <button class="icon" data-act="move" data-list="${list}" data-i="${i}" data-d="1" title="아래로" ${i === len - 1 ? 'disabled' : ''}>▼</button>
    <button class="icon danger" data-act="remove" data-list="${list}" data-i="${i}" title="삭제">✕</button>
  </div>`;

function warningsBox() {
  if (!state.warnings.length) return '';
  return `<div class="warn-box"><ul>${state.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
}

/** 판정 기준을 한 줄 막대로 — 모를 때 · 되묻기 · 자동 답변 구간 */
function gateHtml(s) {
  const c = Math.round(s.confirmThreshold * 100);
  const a = Math.round(s.autoThreshold * 100);
  return `<div class="gate">
    <span class="g-fb" style="width:${c}%">모를 때 &lt; ${c}%</span>
    <span class="g-cl" style="width:${a - c}%">되묻기</span>
    <span class="g-au" style="width:${100 - a}%">자동 ≥ ${a}%</span>
  </div>`;
}

const range = (path, min, max, step) => {
  const v = getPath(state.rules, path);
  return `<div class="range-row"><input type="range" min="${min}" max="${max}" step="${step}" data-path="${path}" data-kind="number" value="${v}"><output data-for="${path}">${v}</output></div>`;
};

function renderEditor() {
  const ed = $('editor');
  const actions = $('editor-actions');
  actions.innerHTML = '';
  const r = state.rules;

  if (state.sel === 'persona') {
    $('editor-title').textContent = '봇 문구';
    ed.innerHTML = warningsBox() +
      '<p class="help" style="margin-top:0">Jev 는 문장을 만들지 않습니다. <b>고객에게 나가는 문장은 전부 이 화면에 적은 글</b>이고, Jev 는 그중 무엇을 보낼지 고릅니다.</p>' +
      field('봇 이름', text('persona.name', '브릿지봇')) +
      field('인사 (의도 = 인사)', area('persona.greeting', 2)) +
      field('감사·마무리 (의도 = 감사)', area('persona.thanks', 2)) +
      field('모를 때', area('persona.fallback', 3),
        'Jev 가 "해당 없음" 을 골랐거나 확신도가 되묻기 기준보다 낮을 때. 지어내지 않고 이 문구로 답합니다.') +
      field('되묻기', area('persona.clarify', 2), '<code>{title}</code> 자리에 FAQ 제목·시나리오 이름이 들어갑니다. 다음 턴에 Jev 가 "네/아니요" 를 판정합니다.') +
      field('다시 묻기 (시나리오 단계)', area('persona.reask', 2),
        '고객 대답을 선택지로 분류하지 못했을 때. <code>{ask}</code> = 단계 질문, <code>{options}</code> = 선택지 라벨 목록. 2번 넘게 실패하면 상담원에게 넘깁니다.');
    return;
  }

  if (state.sel === 'settings') {
    const s = r.settings;
    $('editor-title').textContent = '판정 기준';
    ed.innerHTML = warningsBox() +
      '<p class="help" style="margin-top:0">Jev 는 고른 답과 함께 <b>확신도(confidence, 0~1)</b> 를 줍니다. 확률이 한 선택지에 몰릴수록 1 에 가깝습니다. 확신도로 세 갈래를 나눕니다.</p>' +
      `<div id="gate-preview">${gateHtml(s)}</div>` +
      `<div class="row">
        ${field('자동 답변 기준', range('settings.autoThreshold', 0.3, 1, 0.01), '이 이상이면 FAQ 답변을 그대로 보내고 시나리오를 시작합니다')}
        ${field('되묻기 기준', range('settings.confirmThreshold', 0, 0.95, 0.01), '이 이상 ~ 자동 기준 미만이면 "혹시 ○○ 문의이실까요?"')}
      </div>` +
      '<p class="help">공식 권장은 0.9 / 0.5 입니다. 이 샘플은 한국어 평가(<code>npm run eval</code>)에서 자동 답변 오답 0건을 확인한 <b>0.8 / 0.5</b> 로 시작합니다. 규칙을 바꾸면 평가를 다시 돌려 오답이 0 인지 보세요.</p>' +
      '<div class="section-title">상담원 연결 판정</div>' +
      `<div class="row">
        ${field('상담원 요청 기준', range('settings.humanThreshold', 0.5, 1, 0.01), '"사람이랑 얘기하고 싶어요" 확률(noul)이 이 이상이면 연결')}
        ${field('매우 화남이면 연결', `<div style="padding:6px 0"><label class="switch"><input type="checkbox" data-path="settings.angryHandoff" ${s.angryHandoff ? 'checked' : ''}><span class="slider"></span><span>사용</span></label></div>`, '불만도 점수(score 0~2)가 1.5 이상이면 연결')}
      </div>` +
      '<div class="section-title">맥락</div>' +
      field('최근 대화 턴 수', `<input type="number" min="0" max="12" data-path="settings.historyTurns" data-kind="number" value="${s.historyTurns}">`,
        '이번 세션의 최근 N턴(고객+봇)을 Jev state 에 함께 보냅니다. 직전 봇 질문은 항상 들어갑니다.') +
      '<div class="section-title">운영</div>' +
      '<p class="help" style="margin-top:0">[봇 켜기]·[실발신] 은 상단 스위치로 바꿉니다 (바로 저장). 실발신을 끄면 dry-run — 실제 상담방 메시지를 판정해 모니터에만 보여 주고 카카오로 보내지 않습니다.</p>' +
      `<p class="help">Jev: ${state.ai?.ready ? `${esc(state.ai.model)} · 키 ${esc(state.ai.keyMasked)} (${esc(state.ai.keySource)})` : `<span style="color:var(--danger)">${esc(state.ai?.keyError || '키 없음')}</span>`}</p>`;
    return;
  }

  if (state.sel === 'handoff') {
    $('editor-title').textContent = '상담원 연결';
    ed.innerHTML = warningsBox() +
      field('연결 키워드', csv('handoff.keywords', '상담원, 상담사, 직원 연결'),
        '고객 메시지에 포함되면 <b>Jev 도 부르지 않고</b> 바로 아래 안내를 보내고 그 방의 봇을 멈춥니다. 쉼표로 구분.') +
      field('연결 안내 문구', area('handoff.message', 2)) +
      field('Jev 오류 시 안내 문구', area('handoff.errorMessage', 2, '비우면 오류 때 아무것도 보내지 않습니다'),
        'Jev 호출이 재시도 후에도 실패하면 이 문구를 보내고 상담원에게 넘깁니다.') +
      '<p class="help">키워드 외에도 Jev 가 매 턴 "상담원을 원하는가"(noul) 와 "불만도"(score) 를 판정합니다 — [판정 기준] 에서 조정. FAQ·시나리오의 "완료 후 → 상담원 연결" 도 같은 동작입니다.</p>';
    return;
  }

  const [kind, n] = state.sel.split(':');
  const i = Number(n);

  if (kind === 'faq') {
    const f = r.faqs[i];
    if (!f) { $('editor-title').textContent = 'FAQ'; ed.innerHTML = '<div class="empty" style="margin-top:40px"><p>FAQ 가 없습니다.</p></div>'; return; }
    const P = `faqs.${i}`;
    $('editor-title').textContent = `FAQ · ${f.title || '이름 없음'}`;
    actions.innerHTML = `
      <label class="switch" title="끄면 Jev 선택지에서 빠집니다"><input type="checkbox" data-path="${P}.enabled" ${f.enabled ? 'checked' : ''}><span class="slider"></span><span>사용</span></label>
      <button class="ghost danger" data-act="remove" data-list="faqs" data-i="${i}">삭제</button>`;
    ed.innerHTML = warningsBox() +
      `<div class="row">${field('제목', text(`${P}.title`, '환불 · 청약철회'), '되묻기 문구의 {title} 로도 쓰입니다')}${field('id', text(`${P}.id`, 'refund'), 'Jev 선택지 키 · 영문 소문자·숫자·-')}</div>` +
      '<div class="section-title">Jev 가 고르는 기준 (criteria)</div>' +
      field('무엇에 대한 문의인가', area(`${P}.what`, 2, '결제 취소·환불·청약철회 가능 여부와 방법')) +
      field('고객이 묻는 예', lines(`${P}.examples`, 3, '한 줄에 하나\n환불 되나요?\n어제 결제했는데 취소하고 싶어요'),
        '고객 말투 그대로 2~4개. 제목만 있을 때보다 확신도가 크게 오릅니다.') +
      field('헷갈리면 안 되는 것 (not_for)', text(`${P}.notFor`, '결제 수단·결제 방법 문의'),
        '비슷한 카드와 자꾸 섞일 때 경계를 적습니다.') +
      '<div class="section-title">고객에게 보낼 답변</div>' +
      field('답변', area(`${P}.answer`, 5, '고객에게 그대로 발송되는 글'), 'Jev 가 이 카드를 자동 답변 기준 이상으로 고르면 이 글이 그대로 나갑니다.') +
      field('답변 후', afterSelect(`${P}.after`), '상담원 연결 = 봇 정지 · 상담 종료 = 실발신일 때 end-with-bot');
    return;
  }

  // 시나리오
  const fl = r.flows[i];
  if (!fl) { $('editor-title').textContent = '시나리오'; ed.innerHTML = '<div class="empty" style="margin-top:40px"><p>시나리오가 없습니다.</p></div>'; return; }
  const P = `flows.${i}`;
  $('editor-title').textContent = `시나리오 · ${fl.name || '이름 없음'}`;
  actions.innerHTML = `
    <label class="switch" title="끄면 Jev 선택지에서 빠집니다"><input type="checkbox" data-path="${P}.enabled" ${fl.enabled ? 'checked' : ''}><span class="slider"></span><span>사용</span></label>
    <button class="ghost" data-act="dup-flow" data-i="${i}">복제</button>
    <button class="ghost danger" data-act="remove" data-list="flows" data-i="${i}">삭제</button>`;

  const stepIds = fl.steps.map((s) => s.id);
  const nextSelect = (path, cur) => `<select data-path="${path}">
      <option value="" ${!cur ? 'selected' : ''}>다음 순서 단계</option>
      ${stepIds.map((id) => `<option value="${esc(id)}" ${cur === id ? 'selected' : ''}>→ ${esc(id)}</option>`).join('')}
      <option value="done" ${cur === 'done' ? 'selected' : ''}>마무리</option></select>`;

  ed.innerHTML = warningsBox() +
    `<div class="flow" id="flow-preview">${flowHtml(fl)}</div>` +
    `<div class="row">${field('이름', text(`${P}.name`, '요금제 추천'))}${field('id', text(`${P}.id`, 'pricing'))}</div>` +
    '<div class="section-title">Jev 가 이 시나리오를 고르는 기준</div>' +
    field('무엇에 대한 문의인가', area(`${P}.what`, 2)) +
    field('고객이 묻는 예', lines(`${P}.examples`, 3, '한 줄에 하나')) +
    field('헷갈리면 안 되는 것', text(`${P}.notFor`)) +
    '<div class="section-title">단계 — 봇이 묻고, Jev 가 고객 대답을 선택지로 분류</div>' +
    '<p class="help" style="margin-top:0">각 단계는 <b>고정 질문 + 선택지</b> 입니다. 고객이 "한달 250명정도?" 처럼 자유롭게 답해도 Jev 가 "월 101~300명" 으로 분류하고, 그 선택지의 말을 붙여 다음 단계로 갑니다. 첫 단계는 시나리오를 고를 때 <b>미리 함께 판정</b>해서, 첫 메시지에 답이 있으면 건너뜁니다.</p>' +
    fl.steps.map((st, j) => {
      const S = `${P}.steps.${j}`;
      return `<div class="step-card">
        <div class="step-head"><span class="num">${j + 1}</span><span class="grow">${text(`${S}.ask`, '봇이 묻는 말')}</span>
          <input type="text" style="width:110px" data-path="${S}.id" value="${esc(st.id)}" title="단계 id (받은 정보 이름)">
          ${tools(`${P}.steps`, j, fl.steps.length).replace('card-tools', 'card-tools" style="flex-direction:row')}
        </div>
        ${field('판정 지시 (선택)', text(`${S}.judge`, '예) 하루 단위로 말하면 30일을 곱해서 판단한다'), 'Jev instructions 에 덧붙입니다. 비우면 질문만으로 판정합니다.')}
        ${st.options.map((o, k) => {
          const O = `${S}.options.${k}`;
          return `<div class="opt"><div class="opt-body">
              <input type="text" data-path="${O}.label" value="${esc(o.label)}" placeholder="선택지 라벨 (예: 월 101~300명)">
              <input type="text" data-path="${O}.id" value="${esc(o.id)}" placeholder="id">
              <textarea class="wide" rows="${Math.max(1, o.examples.length)}" data-path="${O}.examples" data-kind="lines" placeholder="고객 대답 예 (한 줄에 하나, 선택)">${esc(o.examples.join('\n'))}</textarea>
              <textarea class="wide" rows="2" data-path="${O}.say" placeholder="이 선택지일 때 덧붙일 말 (선택)">${esc(o.say)}</textarea>
              ${nextSelect(`${O}.next`, o.next)}
            </div>${tools(`${S}.options`, k, st.options.length)}</div>`;
        }).join('')}
        <div class="tag-builtin">+ 자동: <b>off_topic</b> — 질문에 대한 대답이 아님 → 다른 문의로 넘어갔는지 보고, 아니면 다시 묻기</div>
        <div class="add-row"><button class="ghost" data-act="add-option" data-path="${S}.options">＋ 선택지</button></div>
      </div>`;
    }).join('') +
    `<div class="add-row"><button class="ghost" data-act="add-step" data-i="${i}">＋ 단계 추가</button></div>` +
    '<div class="section-title">마무리</div>' +
    field('마무리 문구', area(`${P}.done`, 3), '마지막 선택지의 말 뒤에 붙여 보냅니다') +
    field('완료 후', afterSelect(`${P}.after`));
}

function flowHtml(fl) {
  const nodes = [`<div class="node trigger"><b>고객 문의</b><span class="clip">${esc(fl.what || fl.examples[0] || '(의도 미정)')}</span></div>`];
  fl.steps.forEach((st, j) => {
    nodes.push('<span class="arrow">→</span>');
    nodes.push(`<div class="node"><b>${j + 1}단계 · ${esc(st.id)} · 선택지 ${st.options.length}</b><span class="clip">${esc(st.ask || '(비어 있음)')}</span></div>`);
  });
  nodes.push('<span class="arrow">→</span>');
  nodes.push(`<div class="node done ${fl.after}"><b>완료</b>${AFTER[fl.after]}</div>`);
  return nodes.join('');
}

function renderAll() {
  renderTop();
  renderNav();
  renderEditor();
  updateDirty();
}

/* 입력은 전체 재렌더 없이 값만 반영한다 — 타이핑 중 포커스를 잃지 않게 */
$('editor').addEventListener('input', onFieldInput);
$('editor').addEventListener('change', onFieldInput);
$('editor-actions').addEventListener('change', onFieldInput);

function onFieldInput(e) {
  const t = e.target;
  const path = t.dataset?.path;
  if (!path) return;
  let v;
  if (t.type === 'checkbox') v = t.checked;
  else if (t.dataset.kind === 'csv') v = t.value.split(',').map((s) => s.trim()).filter(Boolean);
  else if (t.dataset.kind === 'lines') v = t.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else if (t.dataset.kind === 'number') v = Number(t.value);
  else v = t.value;
  setPath(state.rules, path, v);

  const out = document.querySelector(`output[data-for="${path}"]`);
  if (out) out.textContent = v;
  if (path.startsWith('settings.')) {
    const g = $('gate-preview');
    if (g) g.innerHTML = gateHtml(state.rules.settings);
    renderTop();
  }
  if (state.sel.startsWith('flow:')) {
    const fl = state.rules.flows[Number(state.sel.split(':')[1])];
    const flow = $('flow-preview');
    if (flow) flow.innerHTML = flowHtml(fl);
    $('editor-title').textContent = `시나리오 · ${fl.name || '이름 없음'}`;
    if (/\.(name|enabled)$/.test(path)) renderNav();
    if (e.type === 'change' && /\.steps\.\d+\.id$/.test(path)) renderEditor(); // 다음 단계 선택 목록 갱신
  }
  if (state.sel.startsWith('faq:')) {
    const f = state.rules.faqs[Number(state.sel.split(':')[1])];
    $('editor-title').textContent = `FAQ · ${f.title || '이름 없음'}`;
    if (/\.(title|enabled|after)$/.test(path)) renderNav();
  }
  updateDirty();
}

/* 구조 변경(추가·삭제·이동)은 다시 그린다 */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const r = state.rules;
  const i = Number(b.dataset.i);
  switch (b.dataset.act) {
    case 'add-step': {
      const steps = r.flows[i].steps;
      steps.push({ id: `step${steps.length + 1}`, ask: '', judge: '', options: [
        { id: 'opt1', label: '', examples: [], say: '', next: '' },
        { id: 'opt2', label: '', examples: [], say: '', next: '' },
      ] });
      break;
    }
    case 'add-option': {
      const opts = getPath(r, b.dataset.path);
      opts.push({ id: `opt${opts.length + 1}`, label: '', examples: [], say: '', next: '' });
      break;
    }
    case 'dup-flow': {
      const copy = JSON.parse(JSON.stringify(r.flows[i]));
      copy.id = `${copy.id}-copy`;
      copy.name = `${copy.name} (복제)`;
      r.flows.splice(i + 1, 0, copy);
      state.sel = `flow:${i + 1}`;
      break;
    }
    case 'move': {
      const list = getPath(r, b.dataset.list);
      const j = i + Number(b.dataset.d);
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      break;
    }
    case 'remove': {
      const list = getPath(r, b.dataset.list);
      const top = b.dataset.list === 'faqs' || b.dataset.list === 'flows';
      if (top && !confirm(`"${list[i].title || list[i].name}" 을(를) 삭제할까요? (저장해야 반영됩니다)`)) return;
      list.splice(i, 1);
      if (top) clampSel();
      break;
    }
    default:
      return;
  }
  renderAll();
});

for (const id of ['nav-basic', 'nav-faqs', 'nav-flows']) {
  $(id).addEventListener('click', (e) => {
    const li = e.target.closest('li[data-sel]');
    if (!li) return;
    state.sel = li.dataset.sel;
    renderAll();
  });
}

$('btn-add-faq').addEventListener('click', () => {
  state.rules.faqs.push({ id: `faq-${Date.now().toString(36)}`, title: '새 FAQ', enabled: true, what: '', examples: [], notFor: '', answer: '', after: 'stay' });
  state.sel = `faq:${state.rules.faqs.length - 1}`;
  renderAll();
});

$('btn-add-flow').addEventListener('click', () => {
  state.rules.flows.push({
    id: `flow-${Date.now().toString(36)}`, name: `새 시나리오 ${state.rules.flows.length + 1}`, enabled: true, what: '', examples: [], notFor: '',
    steps: [{ id: 'step1', ask: '', judge: '', options: [
      { id: 'opt1', label: '', examples: [], say: '', next: '' },
      { id: 'opt2', label: '', examples: [], say: '', next: '' },
    ] }],
    done: '', after: 'stay',
  });
  state.sel = `flow:${state.rules.flows.length - 1}`;
  renderAll();
});

$('btn-reset-demo').addEventListener('click', async () => {
  if (!confirm('규칙을 데모(data/demo-bot.json)로 되돌릴까요?\n지금 규칙은 사라집니다.')) return;
  const { rules, warnings, ai } = await api('/api/bot/rules/reset', { method: 'POST' });
  state.ai = ai;
  state.sel = 'faq:0';
  applyRules(rules, warnings);
  flashHint('데모 규칙으로 초기화됨');
});

$('btn-save').addEventListener('click', saveRules);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (isDirty()) saveRules();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

/* 운영 스위치는 바로 저장한다 */
$('sw-enabled').addEventListener('change', async (e) => {
  state.rules.settings.enabled = e.target.checked;
  await saveRules();
});
$('sw-live').addEventListener('change', async (e) => {
  if (e.target.checked && !confirm('실발신을 켤까요?\n\n실제 고객 메시지에 봇 답장이 카카오로 발송되고, 상담 건수(하루 응대 고객 1명 = 1건)를 소진합니다.')) {
    e.target.checked = false;
    return;
  }
  state.rules.settings.live = e.target.checked;
  await saveRules();
});

/* ── 우: 시뮬레이터 + Jev 판정 패널 ───────────────────────────────── */

function simBubble(dir, html, meta = '', cls = '') {
  const box = $('sim-messages');
  box.querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${dir} ${cls}`;
  div.innerHTML = `<div class="bubble">${html}</div>${meta ? `<div class="msg-meta">${meta}</div>` : ''}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function barsHtml(top, winner) {
  return `<div class="bars">${(top || []).map((t) => `
    <span class="lbl" title="${esc(t.id)}">${esc(labelOf(t.id))}</span>
    <span class="bar ${t.id === winner ? 'win' : ''}"><i style="width:${Math.round(t.p * 100)}%"></i></span>
    <span class="val">${pct(t.p)}</span>`).join('')}</div>`;
}

/** 이번 턴에 Jev 가 준 판정 — 고른 답 · 확률 분포 · 확신도 · 게이지 */
function jevPanelHtml(action, d, st) {
  if (!d) return '';
  const j = d.jev;
  const s = state.rules.settings;
  const head = `<div class="jev-head"><span class="route ${esc(d.route)}">${esc(ROUTE[d.route] || d.route)}</span>
    ${action === 'handoff' ? '<span class="route handoff">상담원 연결 → 봇 정지</span>' : action === 'end' ? '<span class="route fallback">상담 종료</span>' : ''}
    <span class="jev-meta">${j ? `${j.ms}ms · in ${j.tokens.input ?? '-'} · 질문 ${j.questions.length}개 · ${esc(j.model)}` : 'Jev 호출 없음'}</span></div>
    <div>${esc(d.reason || '')}</div>`;
  if (!j) return head;
  const intent = j.intent ? `<div class="jev-q"><b>의도 (choice) — 확신도 ${pct(j.intent.confidence)}</b> <span class="thr">자동 ≥ ${pct(s.autoThreshold)} · 되묻기 ≥ ${pct(s.confirmThreshold)}</span>${barsHtml(j.intent.top, j.intent.choice)}</div>` : '';
  const step = j.step ? `<div class="jev-q"><b>단계 대답 (choice) — 확신도 ${pct(j.step.confidence)}</b>${barsHtml(j.step.top, j.step.choice)}</div>` : '';
  const pre = Object.entries(j.prefill || {}).map(([fid, a]) => `${esc(labelOf(fid).replace('시나리오 · ', ''))}: ${esc(labelOf(a.choice))} ${pct(a.confidence)}`).join(' · ');
  const gauges = `<div class="gauges">
    <span>상담원 요청 <b>${pct(j.human)}</b></span>
    <span>불만 <b>${j.frustration ? j.frustration.score.toFixed(2) : '-'}</b>/2</span>
    ${j.confirm != null ? `<span>확인(네) <b>${pct(j.confirm)}</b></span>` : ''}
  </div>`;
  const collected = Object.entries(st?.collected || {}).map(([k, v]) => `${k}=${v}`).join(' / ');
  return head + intent + step + gauges +
    (pre ? `<div class="jev-q"><b>미리 판정한 첫 단계 (speculative)</b><div>${pre}</div></div>` : '') +
    `<div class="jev-q"><b>상태</b><div>${esc(d.flow ? `진행 중: ${d.flow}` : '진행 중 시나리오 없음')}${collected ? ` · ${esc(collected)}` : ''}${st?.pendingConfirm ? ` · 확인 대기: ${esc(st.pendingConfirm.title)}` : ''}${st?.paused ? ` · 봇 정지 — ${esc(st.pausedReason)}` : ''}</div></div>`;
}

async function simSend(textValue) {
  const t = textValue.trim();
  if (!t || state.simBusy) return;
  state.simBusy = true;
  $('sim-send').disabled = true;

  if (isDirty()) await saveRules(); // 시뮬레이터는 저장된 규칙으로 돈다
  simBubble('in', renderText(t), hm(new Date()));
  const typing = simBubble('out', '판정 중…', '', 'typing');

  try {
    const r = await api('/api/sim/message', { method: 'POST', body: JSON.stringify({ simId: state.simId, text: t }) });
    typing.remove();
    if (r.skipped) {
      simBubble('system', esc(r.reason));
    } else {
      const d = r.detail || {};
      simBubble('out', renderText(r.reply), `${hm(new Date())} · ${esc(ROUTE[d.route] || d.route)}${d.jev ? ` · Jev ${d.jev.ms}ms` : ''}`);
      if (r.action !== 'reply') simBubble('system', r.action === 'handoff' ? '— 상담원 연결: 이후 메시지에는 봇이 답하지 않습니다 —' : '— 상담 종료(봇 전환) —');
      $('jev-panel').innerHTML = jevPanelHtml(r.action, d, r.state);
    }
  } catch (err) {
    typing.remove();
    simBubble('system', `오류: ${esc(err.message)}`);
  } finally {
    state.simBusy = false;
    $('sim-send').disabled = false;
    $('sim-input').focus();
  }
}

$('sim-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('sim-input').value;
  $('sim-input').value = '';
  simSend(v);
});
$('sim-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('sim-form').requestSubmit();
  }
});
$('btn-sim-reset').addEventListener('click', async () => {
  await api('/api/sim/reset', { method: 'POST', body: JSON.stringify({ simId: state.simId }) });
  $('sim-messages').innerHTML = '<div class="empty"><p>대화를 초기화했습니다.</p><p class="muted">새 고객으로 말을 걸어 보세요.</p></div>';
  $('jev-panel').innerHTML = '';
});

async function showRequest() {
  if (isDirty()) await saveRules();
  const sample = $('request-sample').value.trim() || '요금이 궁금해요';
  const { request } = await api(`/api/sim/request?simId=${encodeURIComponent(state.simId)}&text=${encodeURIComponent(sample)}`);
  $('request-text').textContent = JSON.stringify(request, null, 2);
}
$('btn-sim-request').addEventListener('click', async () => {
  await showRequest();
  $('request-dialog').showModal();
});
$('btn-request-refresh').addEventListener('click', showRequest);

/* ── 탭 ───────────────────────────────────────────────────────────── */

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $('view-rules').hidden = state.view !== 'rules';
  $('view-monitor').hidden = state.view !== 'monitor';
  if (state.view === 'monitor') {
    state.unseen = 0;
    renderMonitorBadge();
    loadRooms();
  }
}));

function renderMonitorBadge() {
  const b = $('tab-monitor-badge');
  b.hidden = !state.unseen;
  b.textContent = state.unseen;
  b.className = 'badge unread';
}

/* ── 실시간 모니터 ────────────────────────────────────────────────── */

function botBadge(userKey) {
  const b = state.bot[userKey];
  if (!b) return '';
  if (b.paused) return '<span class="badge paused">봇 정지</span>';
  if (b.flowId || b.turns) return '<span class="badge bot">봇 응대중</span>';
  return '';
}

function renderRooms() {
  const ul = $('room-list');
  ul.innerHTML = '';
  $('rooms-hint').textContent = state.rooms.length
    ? `${state.rooms.length}개 · CLI rooms 기준`
    : '상담방이 없습니다. 고객이 카카오톡에서 문의하면 나타납니다.';

  for (const r of state.rooms) {
    const li = document.createElement('li');
    li.className = 'room' + (r.userKey === state.active ? ' active' : '');
    li.innerHTML =
      `<div class="room-top">
         <span class="room-key">${esc(r.userKey)}</span>
         <span>${r.unread > 0 ? `<span class="badge unread">${r.unread}</span>` : ''}${botBadge(r.userKey)}<span class="badge ${r.ended ? '' : 'live'}">${esc(r.status || '')}</span></span>
       </div>
       <div class="room-last">${esc(r.lastText || '(내용 없음)')}</div>`;
    li.addEventListener('click', () => selectRoom(r.userKey));
    ul.appendChild(li);
  }
}

function renderBanner() {
  const el = $('bot-banner');
  const btn = $('btn-bot-toggle');
  if (!state.active) { el.hidden = true; btn.disabled = true; return; }
  const b = state.bot[state.active];
  btn.disabled = false;
  btn.textContent = b?.paused ? '봇 재개' : '봇 정지';
  if (!b) {
    el.hidden = false;
    el.className = 'bot-banner';
    el.textContent = state.rules?.settings.enabled ? '봇 대기 — 이 방에 새 고객 메시지가 오면 판정합니다' : '봇 꺼짐 (상단 스위치)';
    return;
  }
  const fl = state.rules?.flows.find((s) => s.id === b.flowId);
  const idx = fl ? fl.steps.findIndex((s) => s.id === b.stepId) + 1 : 0;
  const info = Object.entries(b.collected || {}).map(([k, v]) => `${k}=${v}`).join(' / ');
  el.hidden = false;
  el.className = `bot-banner ${b.paused ? 'paused' : ''}`;
  el.textContent = b.paused
    ? `봇 정지 — ${b.pausedReason}`
    : `봇 응대중 · ${fl ? `${fl.name} ${idx}/${fl.steps.length}단계` : `최근 판정: ${ROUTE[b.lastRoute] || b.lastRoute || '-'}`}${b.pendingConfirm ? ` · 확인 대기: ${b.pendingConfirm.title}` : ''}${info ? ` · ${info}` : ''}${b.lastError ? ` · 최근 오류: ${b.lastError}` : ''}`;
}

/** dry-run 답장은 카카오 이력에 없으므로 봇 활동에서 가져와 점선 말풍선으로 끼워 보여준다. */
function renderMessages() {
  if (!state.active) return;
  const box = $('messages');
  const shadows = state.activity
    .filter((a) => a.userKey === state.active && a.text && ['reply', 'handoff', 'end'].includes(a.type) && a.detail?.live === false)
    .map((a) => ({ direction: 'out', text: a.text, at: a.at, shadow: true }));
  const list = [...state.messages];
  for (const s of shadows) {
    const idx = list.findIndex((m) => m.at && m.at > s.at);
    if (idx < 0) list.push(s); else list.splice(idx, 0, s);
  }
  if (!list.length) { box.innerHTML = '<div class="empty"><p>아직 메시지가 없습니다.</p></div>'; return; }

  box.innerHTML = '';
  for (const m of list) {
    const dir = m.direction || (m.kind === 'agent' ? 'out' : 'in');
    const div = document.createElement('div');
    div.className = `msg ${dir}${m.pending ? ' pending' : ''}${m.shadow ? ' shadow' : ''}`;
    const meta = [m.seq != null ? `#${m.seq}` : '', m.at ? hm(m.at) : '', m.pending ? '전송중' : '', m.shadow ? 'dry-run · 발신 안 됨' : ''].filter(Boolean).join(' · ');
    div.innerHTML = `<div class="bubble">${renderText(m.text)}</div><div class="msg-meta">${esc(meta)}</div>`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function renderActivity() {
  const ul = $('activity');
  ul.innerHTML = '';
  if (!state.activity.length) {
    ul.innerHTML = '<li class="t-skip">아직 활동이 없습니다. 시뮬레이터나 실제 상담에서 봇이 답하면 쌓입니다.</li>';
    return;
  }
  const LABEL = { reply: '답장', handoff: '상담원 연결', end: '완료·종료', ended: 'end-with-bot', pause: '정지', resume: '재개', reset: '초기화', skip: '건너뜀', error: '오류' };
  for (const a of state.activity.slice(0, 120)) {
    const li = document.createElement('li');
    li.className = `t-${a.type}`;
    const who = a.simId ? '시뮬레이터' : a.userKey;
    const d = a.detail || {};
    const j = d.jev;
    const sub = [
      d.route ? ROUTE[d.route] || d.route : '',
      d.live === false && !d.simulator ? 'dry-run' : d.sent ? '발신됨' : '',
      j ? `Jev ${j.ms}ms` : '',
      j?.intent ? `의도 ${labelOf(j.intent.choice)} ${pct(j.intent.confidence)}` : '',
      j?.step ? `대답 ${labelOf(j.step.choice)} ${pct(j.step.confidence)}` : '',
      d.reason,
    ].filter(Boolean).join(' · ');
    li.innerHTML = `<time>${hm(a.at)}</time><b>${LABEL[a.type] || a.type}</b> <span class="who">${esc(who)}</span>` +
      `${a.text ? `<div>${esc(a.text)}</div>` : ''}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
    if (a.userKey) {
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => selectRoom(a.userKey));
    }
    ul.appendChild(li);
  }
}

function updateComposer() {
  const can = Boolean(state.active) && !state.sending;
  $('input').disabled = !can;
  $('btn-send').disabled = !can;
}

async function loadRooms() {
  try {
    const { rooms, bot } = await api('/api/rooms');
    state.rooms = rooms;
    state.bot = { ...state.bot, ...bot };
    renderRooms();
  } catch (err) {
    $('rooms-hint').textContent = `조회 실패: ${err.message}`;
  }
}

async function selectRoom(userKey) {
  if (state.view !== 'monitor') document.querySelector('.tab[data-view="monitor"]').click();
  state.active = userKey;
  $('thread-title').textContent = userKey;
  $('messages').innerHTML = '<div class="empty"><p>불러오는 중…</p></div>';
  renderRooms();
  renderBanner();
  updateComposer();
  try {
    const { messages, bot } = await api(`/api/rooms/${encodeURIComponent(userKey)}/messages`);
    state.messages = messages;
    if (bot) state.bot[userKey] = bot;
    const room = state.rooms.find((r) => r.userKey === userKey);
    if (room) room.unread = 0;
    renderRooms();
    renderBanner();
    renderMessages();
  } catch (err) {
    $('messages').innerHTML = `<div class="empty"><p>대화를 불러오지 못했습니다.</p><p class="muted">${esc(err.message)}</p></div>`;
  }
}

$('btn-refresh').addEventListener('click', loadRooms);

$('btn-bot-toggle').addEventListener('click', async () => {
  if (!state.active) return;
  const paused = state.bot[state.active]?.paused;
  const { state: st } = await api(`/api/bot/rooms/${encodeURIComponent(state.active)}/${paused ? 'resume' : 'pause'}`, { method: 'POST' });
  state.bot[state.active] = st;
  renderBanner();
  renderRooms();
});

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = $('input').value.trim();
  if (!t || !state.active) return;
  $('input').value = '';
  state.sending = true;
  updateComposer();
  state.messages.push({ seq: null, kind: 'agent', direction: 'out', text: t, at: new Date().toISOString(), pending: true });
  renderMessages();
  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify({ userKey: state.active, text: t }) });
  } catch (err) {
    state.messages = state.messages.filter((m) => !m.pending);
    renderMessages();
    alert(`발신 실패\n\n${err.message}`);
  } finally {
    state.sending = false;
    updateComposer();
  }
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

/* ── 실시간(SSE) ──────────────────────────────────────────────────── */

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('conn-dot').className = 'dot live'; };
  es.onerror = () => { $('conn-dot').className = 'dot down'; };

  es.addEventListener('inbound', (e) => {
    const d = JSON.parse(e.data);
    const i = state.rooms.findIndex((r) => r.userKey === d.userKey);
    if (i >= 0) state.rooms[i] = { ...state.rooms[i], ...d.room };
    else state.rooms.unshift(d.room);
    state.rooms.sort((a, b) => (b.lastSeq || 0) - (a.lastSeq || 0));
    if (d.userKey === state.active) {
      state.messages = d.messages;
      renderMessages();
    }
    if (d.kind === 'message' && state.view !== 'monitor') { state.unseen++; renderMonitorBadge(); }
    renderRooms();
  });

  es.addEventListener('bot', (e) => {
    const a = JSON.parse(e.data);
    state.activity.unshift(a);
    if (state.activity.length > 200) state.activity.length = 200;
    renderActivity();
    if (a.userKey && a.userKey === state.active) renderMessages();
  });

  es.addEventListener('bot-state', (e) => {
    const { userKey, state: st } = JSON.parse(e.data);
    state.bot[userKey] = st;
    renderRooms();
    if (userKey === state.active) renderBanner();
  });

  es.addEventListener('rules', async () => {
    // 다른 탭에서 저장했을 때 — 편집 중이 아니면 따라간다
    if (!isDirty()) await loadRules();
  });
}

/* ── 부팅 ─────────────────────────────────────────────────────────── */

async function boot() {
  try {
    await loadRules();
  } catch (err) {
    $('editor').innerHTML = `<div class="empty"><p>규칙을 불러오지 못했습니다.</p><p class="muted">${esc(err.message)}</p></div>`;
    return;
  }
  try {
    const { activity, rooms } = await api('/api/bot/activity');
    state.activity = activity;
    state.bot = rooms;
  } catch { /* 모니터는 탭을 열 때 다시 부른다 */ }
  renderActivity();
  connect();
  updateComposer();
}

boot();
