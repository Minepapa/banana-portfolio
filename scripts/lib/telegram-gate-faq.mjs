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
const label = (date) => `${date.slice(5)}(${WEEKDAYS[weekday(date)]})`;

// 순수 함수: 날짜 말 → [from, to](KST 날짜). 이번 주말은 다가오는(오늘 포함) 토·일, 일요일이면 오늘 하루.
export function resolveRange(range, today) {
  if (typeof range === 'object') {
    const year = Number(today.slice(0, 4));
    const date = `${year}-${String(range.month).padStart(2, '0')}-${String(range.day).padStart(2, '0')}`;
    if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).getUTCDate() !== range.day) return null;
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

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// 볼트 읽기(시험은 가짜를 넣는다).
export function defaultFaqReaders() {
  return {
    calendarDay: (date) => { const p = calendarDayPath(date); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
    executions: () => readDir(VAULT_PATHS.facts.ledger.executions),
    holdings: () => readDir(VAULT_PATHS.state.holdings),
    spendingSummary: (date) => { const p = spendingSummaryPath(date); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; },
  };
}

const kstClock = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? new Date(t + 9 * 3_600_000).toISOString().slice(11, 16) : '?';
};

function answerCalendar(q, today, read) {
  const range = resolveRange(q.range, today);
  if (!range) return null;
  const [from, to] = range;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const lines = [];
  for (const date of nextDates(from, days)) {
    const day = read.calendarDay(date);
    lines.push(`■ ${label(date)}`);
    if (!day) { lines.push('- 일정 파일 없음(아직 조회 전)', ''); continue; }
    const events = Array.isArray(day.events) ? day.events : [];
    if (!events.length) { lines.push('- 일정 없음', ''); continue; }
    for (const e of events) {
      const when = e.allDay ? '종일' : `${kstClock(e.start)}~${kstClock(e.end)}`;
      lines.push(`- ${when} ${e.person ? `[${escapeHtml(e.person)}] ` : ''}${escapeHtml(e.title ?? '(제목 없음)')}${e.location ? ` @${escapeHtml(e.location)}` : ''}`);
    }
    lines.push('');
  }
  lines.push('출처: 볼트 일정 정본(15분마다 갱신)');
  return { topic: '일정', body: lines.join('\n') };
}

function answerTrades(today, read) {
  const rows = read.executions().filter((e) => String(e.tradeDate ?? '').startsWith(today))
    .sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate)));
  if (!rows.length) return { topic: '오늘 체결', body: `오늘(${label(today)}) 체결 기록이 없습니다.\n출처: 볼트 체결 장부` };
  const table = ['  수량       단가 계좌 종목', ...rows.map((e) => {
    const qty = `${e.tradeType === '매도' ? '-' : '+'}${Number(e.quantity) || 0}`;
    const unit = e.currency === 'USD' ? '$' : '';
    const p = Number(e.price) || 0;
    return tableRow([qty, `${unit}${Number.isInteger(p) ? won(p) : p.toFixed(2)}`], [6, 10], `${e.account ?? '?'} ${e.stockName ?? '?'}`);
  })];
  return { topic: '오늘 체결', body: `오늘(${label(today)}) 체결 ${rows.length}건(+매수·-매도)\n${pre(table)}\n출처: 볼트 체결 장부` };
}

function answerCash(read) {
  const rows = read.holdings().filter((h) => h.isCashLike && h.name === '예수금');
  if (!rows.length) return { topic: '예수금', body: '예수금 기록을 찾지 못했습니다(볼트 보유 파일 확인 필요).' };
  const table = rows.map((h) => tableRow([won(h.evalAmount)], [14], `${h.account ?? '?'} ${String(h.anchorTs ?? '').slice(5, 10)}`));
  return { topic: '예수금', body: `계좌별 예수금(원, 끝은 기준일)\n${pre(table)}\n출처: 볼트 보유 파일` };
}

function answerHoldings(read) {
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
  return { topic: '보유 요약', body: `계좌별 평가액(원, 현금성 포함)·종목 수\n${pre(table)}\n출처: 볼트 보유 파일` };
}

function answerSpending(q, today, read) {
  if (q.scope === 'today') {
    const s = read.spendingSummary(today);
    if (!s) return { topic: '오늘 소비', body: '오늘 소비 요약 파일이 아직 없습니다(수집 잡이 만들기 전).' };
    return { topic: '오늘 소비', body: `${formatTodaySpending(s)}\n\n출처: 볼트 소비 요약` };
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
    ...(table.length ? [pre(table)] : []), ...(missing ? [`알림 기록이 없는 날 ${missing}일(합계에 없음)`] : []), '출처: 볼트 하루 소비 요약 합산'].join('\n') };
}

// q(parseFaq 결과) → { agent, topic, body } 또는 null(답할 수 없으면 대화로).
export function answerFaq(q, { now = new Date(), read = defaultFaqReaders() } = {}) {
  const today = kstDate(now);
  let out = null;
  if (q.kind === 'calendar') out = answerCalendar(q, today, read);
  else if (q.kind === 'trades') out = answerTrades(today, read);
  else if (q.kind === 'cash') out = answerCash(read);
  else if (q.kind === 'holdings') out = answerHoldings(read);
  else if (q.kind === 'spending') out = answerSpending(q, today, read);
  return out ? { agent: q.agent, ...out } : null;
}
