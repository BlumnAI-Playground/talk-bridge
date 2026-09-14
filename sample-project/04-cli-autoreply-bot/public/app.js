/*
 * TalkBridge 자동응대봇 샘플 — 프론트엔드 (프레임워크 없음, 바닐라 JS)
 *
 * 서버와의 계약:
 *   GET  /api/me                              CLI whoami + AI 상태(모델·추론 강도·키 출처 — 키는 마스킹)
 *   GET  /api/bot/rules                       자동응대 규칙
 *   PUT  /api/bot/rules                       규칙 저장 (서버가 정규화하고 warnings 를 돌려준다)
 *   POST /api/bot/rules/reset                 데모 규칙으로 초기화
 *   POST /api/sim/message  {simId, text}      시뮬레이터 한 턴 (카카오 발신 없음)
 *   POST /api/sim/reset    {simId}
 *   GET  /api/sim/prompt?simId=               모델에 보내는 지침 전문
 *   GET  /api/rooms · /api/rooms/:u/messages  실제 상담방 (CLI rooms --json)
 *   GET  /api/bot/activity                    최근 봇 활동 + 방별 봇 상태
 *   POST /api/bot/rooms/:u/pause|resume       방별 봇 정지·재개
 *   POST /api/send         {userKey, text}    상담원 직접 답장 (그 방의 봇은 정지)
 *   GET  /api/events                          SSE — inbound · bot · bot-state · rules
 */

'use strict';

const $ = (id) => document.getElementById(id);

const ON_COMPLETE = { stay: '계속 대화', handoff: '상담원 연결', end: '상담 종료(봇 전환)' };
const EFFORT_LABEL = { '': '(.env 기본값)', none: 'none', minimal: 'minimal', low: 'low', medium: 'medium (권장)', high: 'high' };

const state = {
  rules: null,
  savedJson: '',
  warnings: [],
  ai: null,
  sel: 'scenario:0',
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
  return html;
}

const pad = (n) => String(n).padStart(2, '0');
function hm(at) {
  if (!at) return '';
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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

/* ── 규칙 로드·저장 ───────────────────────────────────────────────── */

function applyRules(rules, warnings = []) {
  state.rules = rules;
  state.savedJson = JSON.stringify(rules);
  state.warnings = warnings;
  const n = rules.scenarios.length;
  if (state.sel.startsWith('scenario:') && Number(state.sel.split(':')[1]) >= n) state.sel = n ? `scenario:${n - 1}` : 'persona';
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
  const el = $('save-hint');
  el.textContent = `${text} · ${hm(new Date())}`;
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
  const model = s.model || ai.defaultModel;
  const effort = s.reasoningEffort || ai.defaultEffort;
  chip.className = `chip ${ai.ready ? 'ok' : 'bad'}`;
  chip.textContent = ai.ready ? `${model} · 추론 ${effort || '기본'}` : 'OpenAI 키 없음';
  chip.title = ai.ready ? `키 ${ai.keyMasked} (${ai.keySource})\n${ai.baseUrl}` : ai.keyError;
}

/* ── 좌: 내비 ─────────────────────────────────────────────────────── */

function renderNav() {
  $('cnt-knowledge').textContent = state.rules.knowledge.length;
  for (const li of $('nav-basic').children) li.classList.toggle('active', li.dataset.sel === state.sel);

  const ul = $('nav-scenarios');
  ul.innerHTML = '';
  state.rules.scenarios.forEach((sc, i) => {
    const li = document.createElement('li');
    li.dataset.sel = `scenario:${i}`;
    li.className = state.sel === li.dataset.sel ? 'active' : '';
    li.innerHTML = `<span class="sdot ${sc.enabled ? '' : 'off'}"></span><span class="sname">${esc(sc.name || '이름 없음')}</span><span class="count">${sc.steps.length}단계</span>`;
    ul.appendChild(li);
  });
  if (!state.rules.scenarios.length) ul.innerHTML = '<li class="muted" style="cursor:default">시나리오가 없습니다</li>';
}

/* ── 중: 편집기 ───────────────────────────────────────────────────── */

const field = (label, inner, help = '') =>
  `<div class="field"><label>${label}</label>${inner}${help ? `<div class="help">${help}</div>` : ''}</div>`;
const text = (path, ph = '') => `<input type="text" data-path="${path}" value="${esc(getPath(state.rules, path))}" placeholder="${esc(ph)}">`;
const area = (path, rows = 3, ph = '') => `<textarea rows="${rows}" data-path="${path}" placeholder="${esc(ph)}">${esc(getPath(state.rules, path))}</textarea>`;
const csv = (path, ph = '') => `<input type="text" data-path="${path}" data-kind="csv" value="${esc(getPath(state.rules, path).join(', '))}" placeholder="${esc(ph)}">`;

function warningsBox() {
  if (!state.warnings.length) return '';
  return `<div class="warn-box"><ul>${state.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
}

function renderEditor() {
  const ed = $('editor');
  const actions = $('editor-actions');
  actions.innerHTML = '';
  const r = state.rules;

  if (state.sel === 'persona') {
    $('editor-title').textContent = '봇 페르소나';
    ed.innerHTML = warningsBox() +
      field('봇 이름', text('persona.name', '브릿지봇')) +
      field('말투', text('persona.tone', '친절한 해요체, 짧고 분명하게'), '모든 답장에 적용됩니다.') +
      field('기본 지침', area('persona.instructions', 6, '이 봇이 누구를 응대하고 무엇까지 처리하는지'),
        '역할과 범위를 적습니다. 사실 정보는 [대응 지식]에, 절차는 [시나리오]에 두는 편이 관리하기 쉽습니다.');
    return;
  }

  if (state.sel === 'knowledge') {
    $('editor-title').textContent = `대응 지식 (${r.knowledge.length})`;
    actions.innerHTML = '<button class="ghost" data-act="add-knowledge">＋ 지식 추가</button>';
    ed.innerHTML = warningsBox() +
      '<p class="help" style="margin-top:0">모든 답장의 근거입니다. 봇은 여기와 시나리오 지식에 있는 사실만 말하고, 없으면 지어내지 않고 확인이 필요하다고 답합니다.</p>' +
      `<div class="cards">${r.knowledge.map((k, i) => `
        <div class="card k">
          <div class="card-body">
            ${text(`knowledge.${i}.title`, '제목 (예: 환불 규정)')}
            ${area(`knowledge.${i}.content`, 4, '내용')}
          </div>
          <div class="card-tools">
            <button class="icon" data-act="move" data-list="knowledge" data-i="${i}" data-d="-1" title="위로" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="icon" data-act="move" data-list="knowledge" data-i="${i}" data-d="1" title="아래로" ${i === r.knowledge.length - 1 ? 'disabled' : ''}>▼</button>
            <button class="icon danger" data-act="remove" data-list="knowledge" data-i="${i}" title="삭제">✕</button>
          </div>
        </div>`).join('')}</div>
      <div class="add-row"><button class="ghost" data-act="add-knowledge">＋ 지식 추가</button></div>`;
    return;
  }

  if (state.sel === 'handoff') {
    $('editor-title').textContent = '상담원 연결';
    ed.innerHTML = warningsBox() +
      field('연결 키워드', csv('handoff.keywords', '상담원, 사람, 직원'),
        '고객 메시지에 포함되면 <b>모델을 부르지 않고</b> 바로 아래 안내를 보내고 그 방의 봇을 멈춥니다. 쉼표로 구분.') +
      field('연결 안내 문구', area('handoff.message', 2)) +
      field('AI 오류 시 안내 문구', area('handoff.errorMessage', 2, '비우면 오류 때 아무것도 보내지 않습니다'),
        'OpenAI 호출이 실패하면 이 문구를 보내고 상담원에게 넘깁니다 — 고객을 답 없이 기다리게 두지 않기 위해서입니다.') +
      '<p class="help">모델도 스스로 연결을 판단합니다 (사람을 원함 · 강한 불만 · 상담원이 직접 처리해야 하는 요청). 시나리오의 "완료 후 → 상담원 연결" 도 같은 동작입니다. 정지된 방은 [실시간 모니터] 에서 재개합니다.</p>';
    return;
  }

  if (state.sel === 'settings') {
    const ai = state.ai || {};
    $('editor-title').textContent = '모델 · 동작 설정';
    ed.innerHTML = warningsBox() +
      '<div class="section-title">모델</div>' +
      `<div class="row">
        ${field('모델', `<input type="text" data-path="settings.model" list="model-list" value="${esc(r.settings.model)}" placeholder="${esc(ai.defaultModel || '')}">
          <datalist id="model-list"><option value="gpt-5.6-terra"><option value="gpt-5.5"><option value="gpt-5.4-mini"><option value="gpt-4.1-mini"></datalist>`,
          `비우면 .env <code>OPENAI_MODEL</code> (${esc(ai.defaultModel || '-')})`)}
        ${field('추론 강도', `<select data-path="settings.reasoningEffort">${(ai.efforts ? ['', ...ai.efforts] : ['']).map((e) =>
          `<option value="${e}" ${r.settings.reasoningEffort === e ? 'selected' : ''}>${EFFORT_LABEL[e] || e}</option>`).join('')}</select>`,
          `비우면 .env <code>OPENAI_REASONING_EFFORT</code> (${esc(ai.defaultEffort || '-')}). 높을수록 판단이 꼼꼼하지만 느립니다.`)}
      </div>` +
      `<p class="help">키: ${ai.ready ? `${esc(ai.keyMasked)} · ${esc(ai.keySource)}` : `<span style="color:var(--danger)">${esc(ai.keyError || '없음')}</span>`} · ${esc(ai.baseUrl || '')}</p>` +
      '<div class="section-title">답장</div>' +
      `<div class="row">
        ${field('최대 글자 수', `<input type="number" min="80" max="1000" data-path="settings.maxReplyChars" data-kind="number" value="${r.settings.maxReplyChars}">`, '카카오톡 말풍선 하나 기준 (80~1000)')}
        ${field('맥락 메시지 수', `<input type="number" min="4" max="60" data-path="settings.historyLimit" data-kind="number" value="${r.settings.historyLimit}">`, '같은 상담 세션의 최근 N개를 매 턴 모델에 보냅니다 (4~60)')}
      </div>` +
      '<div class="section-title">운영</div>' +
      '<p class="help" style="margin-top:0">[봇 켜기]·[실발신] 은 상단 스위치로 바꿉니다 (바로 저장). 실발신을 끄면 dry-run — 실제 상담방 메시지에 답장을 만들어 모니터에만 보여 주고 카카오로 보내지 않습니다.</p>';
    return;
  }

  // 시나리오
  const i = Number(state.sel.split(':')[1]);
  const sc = r.scenarios[i];
  if (!sc) {
    $('editor-title').textContent = '시나리오';
    ed.innerHTML = '<div class="empty" style="margin-top:40px"><p>시나리오가 없습니다.</p><p class="muted">왼쪽 [＋ 추가] 로 만드세요.</p></div>';
    return;
  }
  const P = `scenarios.${i}`;
  $('editor-title').textContent = `시나리오 · ${sc.name || '이름 없음'}`;
  actions.innerHTML = `
    <label class="switch" title="끄면 모델이 이 시나리오를 고르지 않습니다"><input type="checkbox" data-path="${P}.enabled" ${sc.enabled ? 'checked' : ''}><span class="slider"></span><span>사용</span></label>
    <button class="ghost" data-act="dup-scenario" data-i="${i}">복제</button>
    <button class="ghost danger" data-act="remove" data-list="scenarios" data-i="${i}">삭제</button>`;

  ed.innerHTML = warningsBox() +
    `<div class="flow" id="flow-preview">${flowHtml(sc)}</div>` +
    `<div class="row">
      ${field('이름', text(`${P}.name`, '요금제 안내'))}
      ${field('id', text(`${P}.id`, 'pricing'), '영문 소문자·숫자·- (로그와 모델 응답에 쓰입니다)')}
    </div>` +
    field('언제 (문의 의도)', area(`${P}.when`, 2, '가격·요금·플랜이 궁금할 때'),
      '모델이 첫 응대와 주제 전환 때 이 설명으로 시나리오를 고릅니다.') +
    field('키워드', csv(`${P}.keywords`, '요금, 가격, 플랜') + `<div class="kw-chips" id="kw-chips">${sc.keywords.map((k) => `<span>${esc(k)}</span>`).join('')}</div>`,
      '고객 메시지에 있으면 모델에게 "후보" 로 알려 줍니다. 확정은 맥락으로 합니다.') +
    '<div class="section-title">플로우 — 위에서부터 한 단계씩 진행</div>' +
    `<div class="cards">${sc.steps.map((st, j) => `
      <div class="card">
        <div class="num">${j + 1}</div>
        <div class="card-body">
          ${area(`${P}.steps.${j}.instruction`, 2, '이 단계에서 봇이 할 일 (예: 한 달 예상 고객 수를 묻는다)')}
          <input type="text" data-path="${P}.steps.${j}.collect" value="${esc(st.collect)}" placeholder="받아낼 정보 이름 (선택 · 예: 월예상고객수)">
        </div>
        <div class="card-tools">
          <button class="icon" data-act="move" data-list="${P}.steps" data-i="${j}" data-d="-1" title="위로" ${j === 0 ? 'disabled' : ''}>▲</button>
          <button class="icon" data-act="move" data-list="${P}.steps" data-i="${j}" data-d="1" title="아래로" ${j === sc.steps.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="icon danger" data-act="remove" data-list="${P}.steps" data-i="${j}" title="삭제">✕</button>
        </div>
      </div>`).join('')}</div>
    <div class="add-row"><button class="ghost" data-act="add-step" data-i="${i}">＋ 단계 추가</button></div>` +
    field('완료 후', `<select data-path="${P}.onComplete">${Object.entries(ON_COMPLETE).map(([v, l]) =>
      `<option value="${v}" ${sc.onComplete === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`,
      '상담원 연결 = 봇 정지(사람이 이어받음) · 상담 종료 = 실발신일 때 end-with-bot 호출') +
    field('시나리오 지식', area(`${P}.knowledge`, 3, '이 시나리오에서만 쓰는 판단 기준·예외'),
      '공통 [대응 지식] 과 함께 모델에 전달됩니다.');
}

function flowHtml(sc) {
  const nodes = [`<div class="node trigger"><b>고객 문의</b><span class="clip">${esc(sc.when || sc.keywords.join(', ') || '(의도 미정)')}</span></div>`];
  sc.steps.forEach((st, j) => {
    nodes.push('<span class="arrow">→</span>');
    nodes.push(`<div class="node"><b>${j + 1}단계${st.collect ? ` · ${esc(st.collect)}` : ''}</b><span class="clip">${esc(st.instruction || '(비어 있음)')}</span></div>`);
  });
  nodes.push('<span class="arrow">→</span>');
  nodes.push(`<div class="node done ${sc.onComplete}"><b>완료</b>${ON_COMPLETE[sc.onComplete]}</div>`);
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
  else if (t.dataset.kind === 'number') v = Number(t.value);
  else v = t.value;
  setPath(state.rules, path, v);

  if (state.sel.startsWith('scenario:')) {
    const sc = state.rules.scenarios[Number(state.sel.split(':')[1])];
    const flow = $('flow-preview');
    if (flow) flow.innerHTML = flowHtml(sc);
    const chips = $('kw-chips');
    if (chips) chips.innerHTML = sc.keywords.map((k) => `<span>${esc(k)}</span>`).join('');
    $('editor-title').textContent = `시나리오 · ${sc.name || '이름 없음'}`;
    if (/\.(name|enabled)$/.test(path)) renderNav();
  }
  if (path.startsWith('settings.')) renderTop();
  updateDirty();
}

/* 구조 변경(추가·삭제·이동)은 다시 그린다 */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const r = state.rules;
  const i = Number(b.dataset.i);
  switch (b.dataset.act) {
    case 'add-knowledge':
      r.knowledge.push({ id: `k${Date.now().toString(36)}`, title: '', content: '' });
      break;
    case 'add-step':
      r.scenarios[i].steps.push({ id: `step${r.scenarios[i].steps.length + 1}`, instruction: '', collect: '' });
      break;
    case 'dup-scenario': {
      const copy = JSON.parse(JSON.stringify(r.scenarios[i]));
      copy.id = `${copy.id}-copy`;
      copy.name = `${copy.name} (복제)`;
      r.scenarios.splice(i + 1, 0, copy);
      state.sel = `scenario:${i + 1}`;
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
      const what = b.dataset.list === 'scenarios' ? `시나리오 "${list[i].name}"` : '이 항목';
      if (b.dataset.list !== `scenarios.${state.sel.split(':')[1]}.steps` && !confirm(`${what} 을(를) 삭제할까요? (저장해야 반영됩니다)`)) return;
      list.splice(i, 1);
      if (b.dataset.list === 'scenarios') state.sel = list.length ? `scenario:${Math.max(0, i - 1)}` : 'persona';
      break;
    }
    default:
      return;
  }
  renderAll();
});

$('nav-basic').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-sel]');
  if (!li) return;
  state.sel = li.dataset.sel;
  renderAll();
});
$('nav-scenarios').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-sel]');
  if (!li) return;
  state.sel = li.dataset.sel;
  renderAll();
});

$('btn-add-scenario').addEventListener('click', () => {
  const n = state.rules.scenarios.length + 1;
  state.rules.scenarios.push({
    id: `scenario-${Date.now().toString(36)}`, name: `새 시나리오 ${n}`, enabled: true, when: '', keywords: [],
    steps: [{ id: 'step1', instruction: '', collect: '' }], knowledge: '', onComplete: 'stay',
  });
  state.sel = `scenario:${n - 1}`;
  renderAll();
});

$('btn-reset-demo').addEventListener('click', async () => {
  if (!confirm('규칙을 데모(data/demo-bot.json)로 되돌릴까요?\n지금 규칙은 사라집니다.')) return;
  const { rules, warnings, ai } = await api('/api/bot/rules/reset', { method: 'POST' });
  state.ai = ai;
  state.sel = 'scenario:0';
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

/* ── 우: 시뮬레이터 ───────────────────────────────────────────────── */

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

function renderSimState(st, d) {
  const dl = $('sim-state');
  if (!st) { dl.innerHTML = ''; return; }
  const sc = state.rules.scenarios.find((s) => s.id === st.scenarioId);
  const rows = [
    ['시나리오', sc ? `${sc.name} · ${st.stepIndex}/${sc.steps.length}단계${st.completed ? ' · 완료' : ''}` : '없음'],
    ['받은 정보', Object.entries(st.collected || {}).map(([k, v]) => `${k}=${v}`).join(' / ') || '없음'],
  ];
  if (st.paused) rows.push(['봇', `정지 — ${st.pausedReason}`]);
  if (d?.reason) rows.push(['근거', d.reason]);
  if (d?.ms != null) rows.push(['모델', `${d.model} · ${d.effort || '기본'} · ${(d.ms / 1000).toFixed(1)}s · in ${d.tokens?.input ?? '-'} / out ${d.tokens?.output ?? '-'} (추론 ${d.tokens?.reasoning ?? 0})`]);
  dl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

async function simSend(textValue) {
  const t = textValue.trim();
  if (!t || state.simBusy) return;
  state.simBusy = true;
  $('sim-send').disabled = true;

  if (isDirty()) await saveRules(); // 시뮬레이터는 저장된 규칙으로 돈다
  simBubble('in', renderText(t), hm(new Date()));
  const typing = simBubble('out', '입력 중…', '', 'typing');

  try {
    const r = await api('/api/sim/message', { method: 'POST', body: JSON.stringify({ simId: state.simId, text: t }) });
    typing.remove();
    if (r.skipped) {
      simBubble('system', esc(r.reason));
    } else {
      const d = r.detail || {};
      const tag = r.action === 'handoff' ? ' · 상담원 연결 → 봇 정지' : r.action === 'end' ? ' · 상담 종료' : '';
      simBubble('out', renderText(r.reply), `${hm(new Date())} · ${esc(d.scenario || '시나리오 없음')}${d.switched ? ' (전환)' : ''}${tag}`);
      if (r.action !== 'reply') simBubble('system', r.action === 'handoff' ? '— 상담원 연결: 이후 메시지에는 봇이 답하지 않습니다 —' : '— 상담 종료(봇 전환) —');
    }
    renderSimState(r.state, r.detail);
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
  renderSimState(null);
});
$('btn-sim-prompt').addEventListener('click', async () => {
  if (isDirty()) await saveRules();
  const { instructions } = await api(`/api/sim/prompt?simId=${encodeURIComponent(state.simId)}`);
  $('prompt-text').textContent = instructions;
  $('prompt-dialog').showModal();
});

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
  if (b.scenarioId) return '<span class="badge bot">봇 응대중</span>';
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
    el.textContent = state.rules?.settings.enabled ? '봇 대기 — 이 방에 새 고객 메시지가 오면 응답합니다' : '봇 꺼짐 (상단 스위치)';
    return;
  }
  const sc = state.rules?.scenarios.find((s) => s.id === b.scenarioId);
  const info = Object.entries(b.collected || {}).map(([k, v]) => `${k}=${v}`).join(' / ');
  el.hidden = false;
  el.className = `bot-banner ${b.paused ? 'paused' : ''}`;
  el.textContent = b.paused
    ? `봇 정지 — ${b.pausedReason}`
    : `봇 응대중 · ${sc ? `${sc.name} ${b.stepIndex}/${sc.steps.length}단계` : '시나리오 없음'}${info ? ` · ${info}` : ''}${b.lastError ? ` · 최근 오류: ${b.lastError}` : ''}`;
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
    const sub = [
      d.scenario,
      d.live === false && !d.simulator ? 'dry-run' : d.sent ? '발신됨' : '',
      d.ms != null ? `${(d.ms / 1000).toFixed(1)}s` : '',
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
