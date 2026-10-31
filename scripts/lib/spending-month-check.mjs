// 월간 지출 점검(결정 `월별-지출-정본`): 닫힌 달의 뱅크샐러드 내보내기가 들어오면 spending_month.py로
// 월 합계와 거래별 알림 커버리지를 내고, 헤르메스가 보낼 메시지 본문을 만든다.
// - 새 잡을 두지 않고 헤르메스 아침 브리핑이 날마다 조건을 본다. 지난달 결과 파일이 이미 있으면 아무것도 안 한다.
// - 결과 파일은 메시지가 실제로 나간 뒤에만 볼트에 둔다(발송 실패 → 다음 아침 다시). 그래서 python은
//   임시 경로에 쓰고, 호출부가 발송 성공 뒤 commitMonthReport로 옮긴다.
// - 발신(agent)은 이 파일에서 정하지 않는다. 헤르메스 발신은 hermes-briefing만 한다(형식 준수 테스트).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from './vault-paths.mjs';
import { escapeHtml } from './telegram.mjs';
import { writeAtomic } from './state-writer.mjs';
import { summarizeMonthPlaces, MOVE_PLACE, NO_PLACE } from './spending-places.mjs';

// 알림 수집이 2026-10-10에 시작돼 그 전 달은 대조할 알림이 없다. 첫 점검 달.
export const FIRST_CHECK_MONTH = '2026-10';
// 빠진 결제수단을 질문 큐에 올리는 문턱(그 달 알림 없는 지출 건수).
export const GAP_QUESTION_MIN_COUNT = 3;
// 폰 고정폭(<pre>) 한 줄 폭(themis-risk-review의 2026-10-26 실측과 같은 값).
const PHONE_PRE_COLS = 44;
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'spending_month.py');
// 이름이 "시작일_종료일"인 내보내기 폴더(banksalad_audit.EXPORT_DATE_RANGE와 같은 형식).
const EXPORT_FOLDER_RE = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/;

const spendingDir = (root) => join(root, ...VAULT_REL.spending.split('/'));

export function previousMonth(date) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

function monthEnd(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

export function monthReportPath(month, root = VAULT_PATHS.root) {
  return join(root, ...VAULT_REL.spendingMonthly.split('/'), `${month}.json`);
}

// spending_month.find_export(closed_month=True)와 같은 기준: 그 달 1일 이전에 시작하고 말일 "뒤"에 끝나는
// 내보내기(말일 당일에 받은 내보내기는 그날 저녁 거래가 빠질 수 있다).
export function findClosedMonthExport(month, root = VAULT_PATHS.root) {
  const dir = join(spendingDir(root), 'Banksalad');
  if (!existsSync(dir)) return null;
  const start = `${month}-01`;
  const end = monthEnd(month);
  const covering = readdirSync(dir).filter((name) => {
    const match = EXPORT_FOLDER_RE.exec(name);
    return match && match[1] <= start && match[2] > end && existsSync(join(dir, name, 'source.xlsx'));
  });
  return covering.sort().at(-1) ?? null;
}

// 반환 status:
// - none: 점검할 달이 아님(첫 점검 달 이전) 또는 이미 끝남(결과 파일 있음)
// - waiting: 지난달 내보내기가 아직 없음 → 브리핑에 대기 한 줄
// - ready: 내보내기 있음 → runMonthReport
export function planMonthCheck({ date, root = VAULT_PATHS.root }) {
  const month = previousMonth(date);
  if (month < FIRST_CHECK_MONTH || existsSync(monthReportPath(month, root))) return { status: 'none', month };
  const exportName = findClosedMonthExport(month, root);
  return exportName ? { status: 'ready', month, exportName } : { status: 'waiting', month };
}

// 임시 폴더에 결과를 쓰게 하고 읽어 온다. 실패는 숨기지 않고 던진다(조용한 폴백 금지).
export function runMonthReport(month, { root = VAULT_PATHS.root, python = 'python3', spawn = spawnSync } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'spending-month-'));
  const output = join(work, `${month}.json`);
  try {
    const args = [SCRIPT, '--spending-dir', spendingDir(root), '--month', month, '--output', output];
    const eventsDir = join(root, ...VAULT_REL.argosEvents.split('/'));
    if (existsSync(eventsDir)) args.push('--events-dir', eventsDir);
    const result = spawn(python, args, { encoding: 'utf8', timeout: 180_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim().split('\n');
      // 원인 추적용으로 끝 몇 줄을 잡 로그에 남긴다(텔레그램 본문으로는 나가지 않는다).
      if (stderr.length > 1) console.error(stderr.slice(-8).join('\n'));
      const reason = stderr.at(-1) || `종료 코드 ${result.status}`;
      throw new Error(`spending_month.py 실패: ${reason}`);
    }
    const text = readFileSync(output, 'utf8');
    return { report: JSON.parse(text), text };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export function commitMonthReport(month, text, { root = VAULT_PATHS.root, write = writeAtomic } = {}) {
  write(monthReportPath(month, root), text);
}

// 발송이 실패했을 때 저장해 둔 결과 파일을 되돌린다(다음 아침 다시 보내게).
export function removeMonthReport(month, root = VAULT_PATHS.root) {
  const path = monthReportPath(month, root);
  if (existsSync(path)) unlinkSync(path);
}

export function readMonthReport(month, root = VAULT_PATHS.root) {
  const path = monthReportPath(month, root);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// ── 본문 렌더 ──────────────────────────────────────────────

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115F) || (code >= 0x2E80 && code <= 0xA4CF)
      || (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0xFF00 && code <= 0xFF60) || (code >= 0xFFE0 && code <= 0xFFE6);
    width += wide ? 2 : 1;
  }
  return width;
}

// 칸보다 길면 잘라 끝에 '~'를 붙인다(폰에서 두 줄로 밀리지 않게).
function fitDisplay(text, width) {
  const value = String(text);
  if (displayWidth(value) <= width) return value + ' '.repeat(width - displayWidth(value));
  let out = '';
  for (const char of value) {
    if (displayWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}~${' '.repeat(width - 1 - displayWidth(out))}`;
}

const padStartDisplay = (text, width) => ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
const won = (value) => `${Math.round(Number(value)).toLocaleString('ko-KR')}원`;
const comma = (value) => Math.round(Number(value)).toLocaleString('ko-KR');

// 열 정의: [제목, 폭, 정렬]. 합이 PHONE_PRE_COLS를 넘으면 렌더 단계에서 막는다.
function preTable(columns, rows) {
  const total = columns.reduce((sum, [, width]) => sum + width, 0) + columns.length - 1;
  if (total > PHONE_PRE_COLS) throw new Error(`표 폭 ${total}칸 > ${PHONE_PRE_COLS}칸`);
  const line = (cells) => cells.map((cell, index) => {
    const [, width, align] = columns[index];
    return align === 'right' ? padStartDisplay(fitDisplay(cell, width).trimEnd(), width) : fitDisplay(cell, width);
  }).join(' ').trimEnd();
  return `<pre>${escapeHtml([line(columns.map(([title]) => title)), ...rows.map(line)].join('\n'))}</pre>`;
}

const outflow = (item) => Number(item.signed_amount) < 0;
// python coverage_groups는 빈 결제수단을 '(없음)'으로 묶지만 missed[]에는 None 그대로 온다.
export const NO_INSTRUMENT = '(없음)';
const instrumentOf = (item) => String(item.payment_instrument ?? '').trim() || NO_INSTRUMENT;
// 알림 원문·뱅크샐러드 설명은 줄바꿈·길이가 제멋대로라 한 줄로 줄인다(메시지 분할이 표를 자르지 않게).
const oneLine = (value, max = 40) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}~` : text;
};

// 알림 없는 지출을 결제수단별로(건수 많은 순). 수입·이체 받은 돈은 알림 빈칸 대상이 아니라 뺀다.
export function missingInstruments(report) {
  const groups = new Map();
  for (const item of report.missed ?? []) {
    if (item.alert_coverage !== 'no_alert' || !outflow(item)) continue;
    const instrument = instrumentOf(item);
    const current = groups.get(instrument) ?? { instrument, count: 0, amount: 0 };
    current.count += 1;
    current.amount += -Number(item.signed_amount);
    groups.set(instrument, current);
  }
  return [...groups.values()].sort((first, second) => second.count - first.count || second.amount - first.amount);
}

function coverageRatio(coverage) {
  const judged = coverage.transactions - coverage.no_source;
  return judged > 0 ? Math.round((coverage.parsed / judged) * 100) : null;
}

function totalsSection(monthly, previous) {
  const lines = [`- 전체 지출 ${won(monthly.total_expense)}`, `- 생활비 ${won(monthly.everyday_expense)}`];
  for (const [field, label] of [['one_off_tax', '세금·과태료'], ['confirmed_prepayment', '선납'],
    ['unverified_usage_spending', '사용처 미확인 출금']]) {
    if (Number(monthly[field])) lines.push(`- ${label} ${won(monthly[field])}`);
  }
  if (Number(monthly.total_expense_offset)) {
    lines.push(`- 환불·정산 차감 ${won(monthly.total_expense_offset)} → 순지출 ${won(monthly.net_expense)}`);
  }
  lines.push(`- 수입 ${won(monthly.total_income)}`);
  if (previous?.monthly) {
    const diff = Number(monthly.total_expense) - Number(previous.monthly.total_expense);
    lines.push(`- 지난달 대비 전체 지출 ${diff >= 0 ? '+' : '-'}${won(Math.abs(diff))}`);
  }
  return `■ 합계(뱅크샐러드 기준)\n${lines.join('\n')}`;
}

function coverageSection(report, previous) {
  const coverage = report.coverage;
  const lines = [`- 거래 ${coverage.transactions}건: 잡힘 ${coverage.parsed} · 못 읽음 ${coverage.raw_unparsed} · 알림 없음 ${coverage.no_alert}`];
  if (coverage.no_source) lines.push(`- 알림 수집이 없던 날 거래 ${coverage.no_source}건(판단 제외)`);
  const ratio = coverageRatio(coverage);
  const previousRatio = previous?.coverage ? coverageRatio(previous.coverage) : null;
  if (ratio !== null) lines.push(`- 잡힘 비율 ${ratio}%${previousRatio !== null ? ` (지난달 ${previousRatio}%)` : ''}`);
  return `■ 알림 커버리지\n${lines.join('\n')}`;
}

function gapSection(report) {
  const groups = missingInstruments(report).slice(0, 8);
  if (!groups.length) return '■ 알림 없는 지출\n- 없음';
  const table = preTable([['결제수단', 24, 'left'], ['건', 4, 'right'], ['금액', 12, 'right']],
    groups.map((group) => [group.instrument, String(group.count), comma(group.amount)]));
  return `■ 알림 없는 지출(결제수단별)\n${table}`;
}

function unparsedSection(report) {
  const items = (report.missed ?? []).filter((item) => item.alert_coverage === 'raw_unparsed');
  if (!items.length) return null;
  const lines = items.slice(0, 8).map((item) => `- ${escapeHtml(instrumentOf(item))} · ${escapeHtml(oneLine(item.description))} ${won(Math.abs(Number(item.signed_amount)))} (${escapeHtml(oneLine((item.alert_raw_sources ?? []).join(', ')))})`);
  if (items.length > 8) lines.push(`- 외 ${items.length - 8}건`);
  return `■ 파서 보강 후보(알림은 왔는데 못 읽음)\n${lines.join('\n')}`;
}

function alertOnlySection(report) {
  const items = report.alert_only ?? [];
  if (!items.length) return null;
  const lines = items.slice(0, 5).map((item) => `- ${escapeHtml(item.at.slice(5, 10))} ${escapeHtml(oneLine(item.merchant ?? item.card ?? '가맹점 없음'))} ${won(item.amount)}`);
  if (items.length > 5) lines.push(`- 외 ${items.length - 5}건`);
  return `■ 알림에만 있는 결제(뱅크샐러드에 없음)\n${lines.join('\n')}`;
}

// 카드별·항목별·고정비(요청 "소비 보고 카드별·항목별·고정비" 2단계). 옛 결과 파일에는 breakdown이 없어 칸을 뺀다.
function instrumentSection(report) {
  if (report.breakdown?.error) return '■ 결제수단별·항목별·고정비\n- 표 만들기 실패(소비 설정 확인, 합계·커버리지는 위와 같음)';
  const groups = report.breakdown?.by_instrument ?? [];
  if (!groups.length) return null;
  const table = preTable([['결제수단', 24, 'left'], ['건', 4, 'right'], ['금액', 12, 'right']],
    groups.slice(0, 8).map((group) => [group.instrument, String(group.count), comma(group.amount)]));
  const routes = groups.slice(0, 8).flatMap((group) => Object.entries(group.routes ?? {})
    .map(([via, amount]) => `- ${escapeHtml(group.instrument)} 중 ${escapeHtml(via)} 경유 ${won(amount)}`));
  const rest = groups.length > 8 ? [`- 외 ${groups.length - 8}개 결제수단`] : [];
  return [`■ 결제수단별 지출`, table, ...routes, ...rest].join('\n');
}

function categorySection(report) {
  const groups = report.breakdown?.by_category ?? [];
  if (!groups.length) return null;
  const top = groups.slice(0, 8);
  const restAmount = groups.slice(8).reduce((sum, group) => sum + Number(group.amount), 0);
  const rows = top.map((group) => [group.category, String(group.count), comma(group.amount)]);
  if (groups.length > 8) rows.push(['나머지', String(groups.slice(8).reduce((sum, group) => sum + group.count, 0)), comma(restAmount)]);
  const owner = groups.reduce((sum, group) => sum + (group.owner_override ?? 0), 0);
  return `■ 항목별 지출(뱅크샐러드 분류${owner ? `, 오너 지정 ${owner}건 포함` : ''})\n${preTable([['항목', 24, 'left'], ['건', 4, 'right'], ['금액', 12, 'right']], rows)}`;
}

function fixedSection(report) {
  const items = report.breakdown?.fixed ?? [];
  if (!items.length) return null;
  const change = (item) => {
    if (item.status === 'missing') return '안 나감';
    if (item.change === null || item.change === undefined) return '-';
    const value = Number(item.change);
    return value === 0 ? '같음' : `${value > 0 ? '+' : '-'}${comma(Math.abs(value))}`;
  };
  const table = preTable([['고정비', 14, 'left'], ['날', 3, 'right'], ['금액', 10, 'right'], ['전월대비', 10, 'right']],
    items.map((item) => [item.name, item.payments?.length ? String(Number(item.payments[0].date.slice(8, 10))) : '-',
      item.status === 'missing' ? '0' : comma(item.amount), change(item)]));
  const total = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return `■ 고정비(자동납부)\n${table}\n- 합계 ${won(total)}`;
}

function placesSection(places) {
  if (places?.failed) return '■ 장소별 소비\n- 읽기 실패(잡 로그 확인)';
  if (!places?.recordedDays) return '■ 장소별 소비\n- 기록 없음(동선이 확정된 날부터 쌓인다)';
  const top = places.places.slice(0, 5);
  const parts = ['■ 장소별 소비(알림으로 잡힌 결제)'];
  if (top.length) {
    parts.push(preTable([['장소', 22, 'left'], ['일', 3, 'right'], ['건', 3, 'right'], ['금액', 12, 'right']],
      top.map((place) => [place.place, String(place.days), String(place.count), comma(place.amount)])));
  }
  const extra = [];
  if (places.moveAmount) extra.push(`${MOVE_PLACE} ${won(places.moveAmount)}`);
  if (places.noneAmount) extra.push(`${NO_PLACE} ${won(places.noneAmount)}`);
  parts.push(`- 기록 ${places.recordedDays}일(${places.firstDay}부터)${extra.length ? ` · ${extra.join(' · ')}` : ''}`);
  return parts.join('\n');
}

export function renderMonthCheck(report, { previous = null, places = null } = {}) {
  const month = report.period?.closed_month;
  if (!month || !report.monthly) throw new Error('닫힌 달 결과가 아님');
  const sections = [
    `${month} 지출 마감 (내보내기 ${escapeHtml(report.source.export)})`,
    totalsSection(report.monthly, previous),
    coverageSection(report, previous),
    gapSection(report),
    unparsedSection(report),
    alertOnlySection(report),
    instrumentSection(report),
    categorySection(report),
    fixedSection(report),
    placesSection(places),
  ].filter(Boolean);
  return sections.join('\n\n');
}

export function monthPlaces(month, root = VAULT_PATHS.root) {
  return summarizeMonthPlaces(month, root);
}

// 질문 큐에 올릴 빈칸 결제수단. 질문 문구는 달마다 같게 둔다(dedupeKey로 한 번만 묻는다).
export function gapQuestions(report) {
  return missingInstruments(report).filter((group) => group.instrument !== NO_INSTRUMENT
    && group.count >= GAP_QUESTION_MIN_COUNT).map((group) => ({
    kind: 'manual-change',
    dedupeKey: `spending-alert-gap:${group.instrument}`,
    question: `${group.instrument} 결제는 폰 알림이 없어 일일 지출 기록에서 빠집니다(뱅크샐러드 월 대조로 확인). 이 결제수단의 앱 푸시(은행·카드·지역화폐 앱)를 아르고스 허락 목록에 올려 받을까요? 등록하면 받을 앱을 정해 개발 요청으로 남깁니다.`,
    urgent: false,
  }));
}
