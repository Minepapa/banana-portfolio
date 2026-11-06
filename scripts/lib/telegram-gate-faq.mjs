// 텔레그램 창구 자주 묻는 질문 — LLM 없이 볼트 정본을 Node로 읽어 1~2초 안에 답한다(2026-11-06 오너 승인, 속도 개선 2차 A-1).
//
// 원칙:
// - 패턴은 보수적으로. 문장 전체가 정해진 모양과 정확히 맞을 때만 결정론으로 답하고, 조금이라도 다르면(덧붙인 말·조건·비교·판단)
//   null을 돌려 대화(LLM)로 보낸다. 잘못 답하는 것보다 LLM이 조금 늦게 답하는 게 낫다.
// - 담당 이름으로 시작하면 그 담당 질문일 때만 받는다("헤르메스 이번 주말 일정"). 다른 담당 이름이면 대화로.
// - 데이터가 없으면 없다고 쓴다(추측 금지). 답은 그 담당 이름표 + 가는 선(스크립트 사실)으로 나간다.
// - 표는 폰 한 줄 44칸(한글 2칸) 안. 숫자 칸을 앞에 오른쪽 정렬, 한글이 든 이름 칸은 맨 오른쪽.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentTitle, AGENT_IDS } from './agent-registry.mjs';
import { calendarDayPath, kstDate, nextDates } from './calendar-days.mjs';
import { spendingSummaryPath, formatTodaySpending } from './spending-daily.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';
import { escapeHtml } from './telegram.mjs';

export const FAQ_LINE_WIDTH = 44;
const ASK = '(?:뭐야|뭐\\s*있어|뭐\\s*있지|뭐가\\s*있어|있어|있나|있지|알려\\s*줘|알려\\s*주세요|보여\\s*줘|어떻게\\s*돼|어떤\\s*게\\s*있지|어떤게\\s*있지|어떤\\s*거\\s*있어|정리해\\s*줘|얼마야|얼마)?';
const DAY_WORD = '(오늘|내일|모레|이번\\s*주말|주말|이번\\s*주|다음\\s*주|(\\d{1,2})월\\s*(\\d{1,2})일|(\\d{1,2})\\/(\\d{1,2}))';
const CALENDAR_RE = new RegExp(`^(?:(?:내|우리|가족)\\s*)?${DAY_WORD}\\s*(?:(?:내|우리|가족)\\s*)?일정(?:은|이)?\\s*${ASK}$`, 'u');
const TRADES_RE = new RegExp(`^(?:오늘|금일)\\s*체결(?:\\s*내역)?(?:은|이)?\\s*${ASK}$`, 'u');
const CASH_RE = new RegExp(`^(?:계좌별\\s*)?예수금(?:은|이)?\\s*${ASK}$`, 'u');
const HOLDINGS_RE = new RegExp(`^(?:내\\s*)?보유\\s*(?:종목|현황|요약)(?:은|이)?\\s*${ASK}$`, 'u');
const SPENDING_RE = new RegExp(`^(오늘|이번\\s*달)\\s*(?:소비|지출|쓴\\s*돈)(?:은|이)?\\s*${ASK}$`, 'u');

// 순수 함수: 질문 문장 → { kind, agent, ... } 또는 null(대화로). 날짜 계산은 답할 때(시계 주입) 한다.
export function parseFaq(text) {
  let t = String(text ?? '').trim().replace(/[?？.!~]+$/u, '').trim();
  let calledAgent = null;
  const call = t.match(/^(\S+)[,\s]+(.+)$/u);
  const callId = call ? AGENT_IDS.find((id) => agentTitle(id) === call[1]) : null;
  if (callId) { calledAgent = callId; t = call[2].trim(); }
  const pick = (agent, q) => (calledAgent && calledAgent !== agent ? null : { ...q, agent });
  const cal = t.match(CALENDAR_RE);
  if (cal) {
    const word = cal[1].replace(/\s+/g, ' ');
    const month = cal[2] ?? cal[4];
    const day = cal[3] ?? cal[5];
    // 없는 날짜(2월 30일 등)는 대화로. 윤년(2024)으로 재서 2월 29일은 받는다.
    if (month && new Date(Date.UTC(2024, Number(month) - 1, Number(day))).getUTCMonth() !== Number(month) - 1) return null;
    return pick('hermes', { kind: 'calendar', range: month ? { month: Number(month), day: Number(day) } : word });
  }
  if (TRADES_RE.test(t)) return pick('plutus', { kind: 'trades' });
  if (CASH_RE.test(t)) return pick('plutus', { kind: 'cash' });
  if (HOLDINGS_RE.test(t)) return pick('plutus', { kind: 'holdings' });
  const spend = t.match(SPENDING_RE);
  if (spend) return pick('hermes', { kind: 'spending', scope: spend[1].startsWith('오늘') ? 'today' : 'month' });
  return null;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const label = (date, today = null) => `${today && date.slice(0, 4) !== today.slice(0, 4) ? `${date.slice(0, 4)}-` : ''}${date.slice(5)}(${WEEKDAYS[weekday(date)]})`;
export const RECENT_PAST_DAYS = 31;

// 순수 함수: 날짜 말 → [from, to](KST 날짜). 이번 주말은 다가오는(오늘 포함) 토·일, 일요일이면 오늘 하루.
export function resolveRange(range, today) {
  if (typeof range === 'object') {
    // "N월 N일"은 올해로 보되, 이미 지난 날짜면 다음 해로 본다(리뷰 MEDIUM: 12월에 묻는 1월 5일).
    // 다만 지난 지 RECENT_PAST_DAYS일 안이면 방금 지난 날을 묻는 것으로 보고 올해로 둔다("11월 1일 일정 어땠지").
    // 해가 바뀐 답은 날짜 칸에 연도를 붙여 보인다(label).
    const make = (y) => `${y}-${String(range.month).padStart(2, '0')}-${String(range.day).padStart(2, '0')}`;
    let date = make(Number(today.slice(0, 4)));
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).getUTCDate() !== range.day) return null;
    const pastDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
    if (pastDays > RECENT_PAST_DAYS) date = make(Number(today.slice(0, 4)) + 1);
    if (new Date(`${date}T00:00:00Z`).getUTCDate() !== range.day) return null; // 다음 해 2월 29일 같은 경우
    return [date, date];
  }
  const dow = weekday(today);
  switch (range) {
    case '오늘': return [today, today];
    case '내일': return [addDays(today, 1), addDays(today, 1)];
    case '모레': return [addDays(today, 2), addDays(today, 2)];
    case '이번 주말': case '주말':
      return dow === 0 ? [today, today] : [addDays(today, 6 - dow), addDays(today, 7 - dow)];
    case '이번 주': return [today, addDays(today, dow === 0 ? 0 : 7 - dow)];
    case '다음 주': { const monday = addDays(today, dow === 0 ? 1 : 8 - dow); return [monday, addDays(monday, 6)]; }
    default: return null;
  }
}

// 폰 고정폭 칸 수(한글·전각 2칸).
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(ch) ? 2 : 1;
  return w;
}
export function fitWidth(s, width) {
  let out = '';
  for (const ch of String(s)) {
    if (displayWidth(out + ch) > width) return `${out.slice(0, -1)}…`;
    out += ch;
  }
  return out;
}
// 숫자 칸들(오른쪽 정렬) + 맨 끝 이름 칸. 한 줄이 44칸을 넘으면 이름을 자른다.
function tableRow(numbers, widths, name) {
  const head = numbers.map((n, i) => String(n).padStart(widths[i])).join(' ');
  return `${head} ${fitWidth(name, FAQ_LINE_WIDTH - displayWidth(head) - 1)}`;
}
const won = (n) => Math.round(Number(n) || 0).toLocaleString('ko-KR');
const pre = (lines) => `<pre>${escapeHtml(lines.join('\n'))}</pre>`;

function readDir(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f.startsWith(prefix)).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// 볼트 읽기(시험은 가짜를 넣는다).
export function defaultFaqReaders() {
  return {
    calendarDay: (date) => { const p = calendarDayPath(date); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
    // 체결 파일 이름은 'YYYY-MM-DD-HHMMSS-…'라 날짜 접두사로 먼저 거른다(리뷰 LOW: 전부 읽지 않게).
    executions: (date) => readDir(VAULT_PATHS.facts.ledger.executions, date ? `${date}-` : ''),
    // 데이터 신선도: 잡 상태 머리말(lastRun·status·failStreak, 있으면 lastSuccess) 또는 null.
    jobHealth: (job) => {
      const p = join(VAULT_PATHS.state.jobHealth, `${job}.md`);
      return existsSync(p) ? (parseFrontmatter(readFileSync(p, 'utf8')) ?? null) : null;
    },
    holdings: () => readDir(VAULT_PATHS.state.holdings),
    spendingSummary: (date) => { const p = spendingSummaryPath(date); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
  };
}

const kstClock = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? new Date(t + 9 * 3_600_000).toISOString().slice(11, 16) : '?';
};

// 데이터 신선도 한 줄(리뷰 MEDIUM). 기준 시간보다 오래됐으면 "갱신 지연"을 붙인다. 시각을 모르면 모른다고 쓴다.
export const FRESHNESS_MAX_MIN = Object.freeze({ calendar: 60, trades: 26 * 60, holdings: 24 * 60, spending: 120 });
const FRESHNESS_JOBS = Object.freeze({
  calendar: ['calendar-days'],
  // 체결은 NH 체결 대조 잡 하나를 기준으로 한다: 알림 파싱은 수시로 돌아 "가장 최근"을 쓰면 API로 확인되지 않은 시점까지 0건이라고
  // 말하게 되고(재리뷰 LOW), 세 잡 중 "가장 오래된"은 하루 한 번 도는 대조 잡과 같아진다. 그래서 대조 잡 시각 + 기준 26시간(하루 1회 + 여유).
  trades: ['reconcile-nh-executions'],
  spending: ['ingest-spending-inbox', 'argos-forward'],
});
function kstStamp(ms, nowMs) {
  const d = new Date(ms + 9 * 3_600_000).toISOString();
  return d.slice(0, 10) === new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10) ? d.slice(11, 16) : `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}
// 잡의 마지막 "성공" 시각(ms). lastSuccess(있으면)를 쓰고, 없으면 상태가 OK일 때만 lastRun을 쓴다 — 실패한 실행은 갱신이 아니다(재리뷰 LOW).
export function jobSuccessMs(health) {
  if (!health) return null;
  const explicit = Date.parse(health.lastSuccess ?? health.lastSuccessAt ?? '');
  if (Number.isFinite(explicit)) return explicit;
  return health.status === 'OK' ? (Date.parse(health.lastRun ?? '') || null) : null;
}
export function latestJobRun(kind, read) {
  const times = (FRESHNESS_JOBS[kind] ?? []).map((job) => jobSuccessMs(read.jobHealth?.(job))).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}
// 마지막 실행이 실패한 잡 표시(" · 마지막 실행 실패(연속 N회)"), 없으면 ''.
export function jobFailNote(kind, read) {
  const failing = (FRESHNESS_JOBS[kind] ?? []).map((job) => read.jobHealth?.(job)).filter((h) => h && h.status && h.status !== 'OK');
  if (!failing.length) return '';
  const streak = Math.max(...failing.map((h) => Number(h.failStreak) || 1));
  return ` · 마지막 실행 실패(연속 ${streak}회)`;
}
export function freshnessLine(kind, lastMs, nowMs, what = '갱신') {
  if (!Number.isFinite(lastMs)) return `${what} 시각을 알 수 없음(잡 상태 확인 필요)`;
  const ageMin = Math.round((nowMs - lastMs) / 60_000);
  const stale = ageMin > FRESHNESS_MAX_MIN[kind];
  return `마지막 ${what} ${kstStamp(lastMs, nowMs)}${stale ? ` · 갱신 지연(${ageMin >= 120 ? `${Math.round(ageMin / 60)}시간` : `${ageMin}분`} 전)` : ''}`;
}

function answerCalendar(q, today, read, nowMs) {
  const range = resolveRange(q.range, today);
  if (!range) return null;
  const [from, to] = range;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const lines = [];
  for (const date of nextDates(from, days)) {
    const day = read.calendarDay(date);
    lines.push(`■ ${label(date, today)}`);
    if (!day) { lines.push('- 일정 파일 없음(아직 조회 전)', ''); continue; }
    const events = Array.isArray(day.events) ? day.events : [];
    if (!events.length) { lines.push('- 일정 없음', ''); continue; }
    for (const e of events) {
      const when = e.allDay ? '종일' : `${kstClock(e.start)}~${kstClock(e.end)}`;
      lines.push(`- ${when} ${e.person ? `[${escapeHtml(e.person)}] ` : ''}${escapeHtml(e.title ?? '(제목 없음)')}${e.location ? ` @${escapeHtml(e.location)}` : ''}`);
    }
    lines.push('');
  }
  lines.push(`출처: 볼트 일정 정본 · ${freshnessLine('calendar', latestJobRun('calendar', read), nowMs)}${jobFailNote('calendar', read)}`);
  return { topic: '일정', body: lines.join('\n') };
}

function answerTrades(today, read, nowMs) {
  const rows = read.executions(today).filter((e) => String(e.tradeDate ?? '').startsWith(today))
    .sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate)));
  const sync = latestJobRun('trades', read);
  const fresh = `${freshnessLine('trades', sync, nowMs, '동기화')}${jobFailNote('trades', read)}`;
  // 0건은 "없다"가 아니라 "마지막 동기화 기준 0건"이다(장중·동기화 전일 수 있음, 리뷰 MEDIUM).
  if (!rows.length) {
    return { topic: '오늘 체결', body: `오늘(${label(today)}) ${Number.isFinite(sync) ? `마지막 동기화 ${kstStamp(sync, nowMs)} 기준` : '동기화 시각 모름 ·'} 체결 0건\n출처: 볼트 체결 장부 · ${fresh}` };
  }
  const table = ['  수량       단가 계좌 종목', ...rows.map((e) => {
    const qty = `${e.tradeType === '매도' ? '-' : '+'}${Number(e.quantity) || 0}`;
    const unit = e.currency === 'USD' ? '$' : '';
    const p = Number(e.price) || 0;
    return tableRow([qty, `${unit}${Number.isInteger(p) ? won(p) : p.toFixed(2)}`], [6, 10], `${e.account ?? '?'} ${e.stockName ?? '?'}`);
  })];
  return { topic: '오늘 체결', body: `오늘(${label(today)}) 체결 ${rows.length}건(+매수·-매도)\n${pre(table)}\n출처: 볼트 체결 장부 · ${fresh}` };
}

// 보유 파일 신선도: 가장 오래된·최근 updatedAt. 기준일(가장 오래된 것)을 함께 보인다.
function holdingsFreshness(rows, nowMs) {
  const times = rows.map((h) => Date.parse(h.updatedAt ?? '')).filter(Number.isFinite);
  if (!times.length) return '갱신 시각을 알 수 없음';
  const oldest = Math.min(...times);
  return `${freshnessLine('holdings', Math.max(...times), nowMs)}(가장 오래된 항목 기준 ${kstStamp(oldest, nowMs)})`;
}

function answerCash(read, nowMs) {
  const rows = read.holdings().filter((h) => h.isCashLike && h.name === '예수금');
  if (!rows.length) return { topic: '예수금', body: '예수금 기록을 찾지 못했습니다(볼트 보유 파일 확인 필요).' };
  const table = rows.map((h) => tableRow([won(h.evalAmount)], [14], `${h.account ?? '?'} ${String(h.anchorTs ?? '').slice(5, 10)}`));
  return { topic: '예수금', body: `계좌별 예수금(원, 끝은 기준일)\n${pre(table)}\n출처: 볼트 보유 파일 · ${holdingsFreshness(rows, nowMs)}` };
}

function answerHoldings(read, nowMs) {
  const all = read.holdings();
  if (!all.length) return { topic: '보유 요약', body: '보유 기록을 찾지 못했습니다(볼트 보유 파일 확인 필요).' };
  const byAcct = new Map();
  for (const h of all) {
    const a = byAcct.get(h.account ?? '?') ?? { total: 0, count: 0 };
    a.total += Number(h.evalAmount) || 0;
    if (!h.isCashLike) a.count += 1;
    byAcct.set(h.account ?? '?', a);
  }
  const rows = [...byAcct.entries()].sort((a, b) => b[1].total - a[1].total);
  const sum = rows.reduce((s, [, a]) => s + a.total, 0);
  const table = ['       평가액 종목 계좌', ...rows.map(([acct, a]) => tableRow([won(a.total), a.count], [13, 4], acct)), tableRow([won(sum), ''], [13, 4], '합계')];
  return { topic: '보유 요약', body: `계좌별 평가액(원, 현금성 포함)·종목 수\n${pre(table)}\n출처: 볼트 보유 파일 · ${holdingsFreshness(all, nowMs)}` };
}

function answerSpending(q, today, read, nowMs) {
  const fresh = `${freshnessLine('spending', latestJobRun('spending', read), nowMs, '수집')}${jobFailNote('spending', read)}`;
  if (q.scope === 'today') {
    const s = read.spendingSummary(today);
    if (!s) return { topic: '오늘 소비', body: '오늘 소비 요약 파일이 아직 없습니다(수집 잡이 만들기 전).' };
    return { topic: '오늘 소비', body: `${formatTodaySpending(s)}\n\n출처: 볼트 소비 요약 · ${fresh}` };
  }
  const first = `${today.slice(0, 8)}01`;
  const days = Number(today.slice(8, 10));
  let total = 0;
  let count = 0;
  let missing = 0;
  const byCategory = {};
  for (const date of nextDates(first, days)) {
    const s = read.spendingSummary(date);
    if (!s || !s.hasSource) { missing += 1; continue; }
    total += Number(s.total) || 0;
    count += Number(s.expenseCount) || 0;
    for (const [k, v] of Object.entries(s.byCategory ?? {})) byCategory[k] = (byCategory[k] ?? 0) + (Number(v) || 0);
  }
  const table = Object.entries(byCategory).filter(([, v]) => v).map(([k, v]) => tableRow([won(v)], [12], k));
  return { topic: '이번 달 소비', body: [`${today.slice(0, 7)} 1일~오늘 확인된 지출 ${won(total)}원(${count}건)`,
    ...(table.length ? [pre(table)] : []), ...(missing ? [`알림 기록이 없는 날 ${missing}일(합계에 없음)`] : []), `출처: 볼트 하루 소비 요약 합산 · ${fresh}`].join('\n') };
}

// q(parseFaq 결과) → { agent, topic, body } 또는 null(답할 수 없으면 대화로).
export function answerFaq(q, { now = new Date(), read = defaultFaqReaders() } = {}) {
  const today = kstDate(now);
  const nowMs = now.getTime();
  let out = null;
  if (q.kind === 'calendar') out = answerCalendar(q, today, read, nowMs);
  else if (q.kind === 'trades') out = answerTrades(today, read, nowMs);
  else if (q.kind === 'cash') out = answerCash(read, nowMs);
  else if (q.kind === 'holdings') out = answerHoldings(read, nowMs);
  else if (q.kind === 'spending') out = answerSpending(q, today, read, nowMs);
  return out ? { agent: q.agent, ...out } : null;
}

// ── 재료 미리 붙이기(속도 개선 2차 B-5) ─────────────────────────────────────────────
// LLM으로 가는 질문에도 날짜·낱말로 종류를 고르고, 해당 사실을 Node로 미리 읽어 프롬프트에 [창구 사실]로 붙인다.
// 모델이 같은 사실을 도구로 다시 찾지 않게 한다. 넓게 붙이지 않는다: 낱말이 분명할 때만, 블록당 길이 제한.
const PREFETCH_MAX = 1800;

const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// 순수 함수: 오너 글 → 미리 읽을 사실 종류 목록(시험용으로 따로 둔다).
export function prefetchPlan(text) {
  const t = String(text ?? '');
  const plan = [];
  const day = t.match(new RegExp(DAY_WORD, 'u'));
  if (day && /(일정|약속|캘린더|가족|스케줄)/u.test(t)) {
    const month = day[2] ?? day[4];
    const d = day[3] ?? day[5];
    const valid = !month || new Date(Date.UTC(2024, Number(month) - 1, Number(d))).getUTCMonth() === Number(month) - 1;
    if (valid) plan.push({ kind: 'calendar', range: month ? { month: Number(month), day: Number(d) } : day[1].replace(/\s+/g, ' ') });
  }
  if (/체결/u.test(t)) plan.push({ kind: 'trades' });
  if (/예수금/u.test(t)) plan.push({ kind: 'cash' });
  if (/보유/u.test(t)) plan.push({ kind: 'holdings' });
  if (/(소비|지출|쓴\s*돈|결제)/u.test(t)) {
    if (/이번\s*달/u.test(t)) plan.push({ kind: 'spending', scope: 'month' });
    else if (/오늘/u.test(t)) plan.push({ kind: 'spending', scope: 'today' });
  }
  return plan;
}

export function prefetchFacts(text, { now = new Date(), read = defaultFaqReaders() } = {}) {
  const blocks = [];
  for (const q of prefetchPlan(text)) {
    try {
      const a = answerFaq({ ...q, agent: 'zeus' }, { now, read });
      if (a) blocks.push(`· ${a.topic}\n${plain(a.body).slice(0, PREFETCH_MAX)}`);
    } catch { /* 미리 읽기 실패는 붙이지 않는다 — 모델이 도구로 찾는다 */ }
  }
  return blocks.length ? blocks.join('\n\n') : null;
}
