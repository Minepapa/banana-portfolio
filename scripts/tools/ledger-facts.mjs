#!/usr/bin/env node
// ledger-facts.mjs — 운영실 Hermes 대화형 보고용 Node 결정론 사실 조립기.
//
// 앱 최우선 원칙(LLM 숫자 날조 금지)의 Hermes 확장. Hermes는 "시트 쓰기 단일 창구"라 실제
// 쓰기는 헤드리스 잡(record-heartbeat·parse-notifications 등)이 담당 — 이 파일은 보고(읽기)
// 전용이다. 예수금 앵커 갱신(resolveCashBase) 같은 쓰기 경로 로직은 여기서 재현하지 않고,
// 예수금기준 시트에 이미 확정된 현재 값을 그대로 읽는다(읽기·쓰기 경로 분리 — Karpathy #2).
//
// /hermes 커맨드가 Hermes 스폰 전에 이 CLI를 실행해 factsText를 주입한다.
// (하드 보장의 나머지 절반은 hermes.md frontmatter의 도구 제한.)

import { loadEnv, hasServiceAccount, getToken, getRange } from '../lib/sheets-common.mjs';
import { EXEC_COL } from '../lib/sheet-contracts.mjs';

const SECTIONS = ['all', 'cash', 'trades', 'jobs'];

export function parseArgs(argv) {
  let section = 'all', name = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--section') {
      section = argv[++i];
      if (!SECTIONS.includes(section)) throw new Error(`--section 값은 ${SECTIONS.join('|')} 여야 함: "${section}"`);
    } else if (a === '--name') name = argv[++i];
  }
  return { section, name, json };
}

const won = (n) => Math.round(n).toLocaleString('ko-KR');
const pn = (v) => parseFloat(String(v ?? '').replace(/[,%]/g, '')) || 0;
// 체결가는 US 종목이면 소수(예: $342.5)라 won()으로 반올림하면 실제 체결가를 왜곡한다
// (stock-facts.mjs price() 패턴 재사용 — Phase 1에서 막았던 결함 클래스).
const price = (n) => Number.isInteger(n) ? n.toLocaleString('ko-KR') : n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
// 잡상태 detail은 잡의 마지막 로그 줄 전체가 들어와 수백자에 달할 수 있다(실증: risk-b 401 메시지).
// 대화형 주입 토큰·가독성 보호를 위해 자른다 — 원문은 시트에 그대로 있으니 필요하면 직접 확인 가능.
const clamp = (s, max = 80) => (s.length <= max ? s : s.slice(0, max - 1) + '…');

// 예수금기준!A2:E: 계좌0 기준액1 기준일2 소스3 갱신시각4
// 4계좌(위탁·연금저축·ISA·IRP)엔 항상 기준행이 있어야 하므로, 전부 빈 응답은 "예수금 없음"이
// 아니라 시트 읽기 이상이다(stock-facts.mjs holdingsFromRows와 동일 원칙 — 무결성 기능 안에서
// 빈 응답을 정상 상태로 오인하면 안 된다).
export function assembleCash(rows) {
  if (!rows?.length) return { text: '(예수금 데이터 부족: 전 계좌 빈 응답 — 시트 읽기 이상 의심, 추정 금지)', byAcct: {} };
  const byAcct = {};
  const lines = [];
  for (const r of rows) {
    const acct = String(r[0] ?? '').trim();
    if (!acct) continue;
    const base = pn(r[1]);
    const date = String(r[2] ?? '').trim();
    const source = String(r[3] ?? '').trim();
    byAcct[acct] = { base, date, source };
    lines.push(`  ${acct}: ${won(base)}원 (기준일 ${date || '?'}, 소스 ${source || '?'})`);
  }
  return { text: lines.length ? lines.join('\n') : '(예수금 데이터 부족)', byAcct };
}

// 체결내역!A2:M(EXEC_COL). name 지정 시 정확일치 필터, 아니면 최근 limit건.
// 리뷰 지적: 시트 append 순서는 시간순이 아니다(parse-notifications가 같은 실행 내 금현물을 시각
// 무관하게 나중에 push, 백필·수동편집 등) — ExecutionsTab.jsx도 날짜로 재정렬해 보여준다. "최근"을
// 시트 순서로 대체하면 무결성 기능 안에서 거짓("최근"이 아닌 걸 최근이라 주장)이 되므로 명시 정렬한다.
export function assembleTrades(rows, { name = null, limit = 10 } = {}) {
  const all = rows || [];
  // 정확일치 또는 선행 단어 매칭("알파벳"→"알파벳 Class A") — stock-facts.mjs findHolding과 동일
  // 원칙(공백 경계로 과매칭 방지, "삼성"이 "삼성전자"를 잡지 않음). 라이브 검증 중 정확일치만으론
  // 실재 체결을 "없음"으로 오보하는 걸 발견해 반영.
  const filtered = name
    ? all.filter((r) => { const nm = String(r[EXEC_COL.NAME] ?? '').trim(); return nm === name || nm.startsWith(name + ' '); })
    : all;
  if (!filtered.length) {
    return { rows: [], text: name ? `(체결 없음: "${name}" 매칭 행 없음)` : '(체결 데이터 부족: 빈 응답)' };
  }
  const sorted = [...filtered].sort((a, b) => String(b[EXEC_COL.DATE] ?? '').localeCompare(String(a[EXEC_COL.DATE] ?? '')));
  const recent = sorted.slice(0, limit);
  const lines = recent.map((r) =>
    `  ${r[EXEC_COL.DATE]} ${r[EXEC_COL.SIDE]} [${r[EXEC_COL.ACCT]}] ${r[EXEC_COL.NAME]} ${r[EXEC_COL.QTY]}주 @${price(pn(r[EXEC_COL.PRICE]))} = ${won(pn(r[EXEC_COL.AMOUNT]))}원`
  );
  return { rows: recent, text: lines.join('\n') };
}

// 잡상태!A2:F: job0 lastRun1 status2 detail3 durationSec4 failStreak5
export function assembleJobs(rows) {
  const all = rows || [];
  if (!all.length) return { text: '(잡상태 데이터 부족: 빈 응답)', failing: [] };
  const failing = [];
  const lines = all.map((r) => {
    const job = String(r[0] ?? '').trim();
    const status = String(r[2] ?? '').trim();
    const detail = String(r[3] ?? '').trim();
    if (status && status !== 'OK') failing.push({ job, status, detail });
    return `  ${job}: ${status || '?'} (마지막 실행 ${r[1] || '?'}${detail ? `, ${clamp(detail)}` : ''}, 연속실패 ${r[5] || 0}회)`;
  });
  return { text: lines.join('\n'), failing };
}

export function renderLedgerFacts({ cash, trades, jobs }, { json = false } = {}) {
  if (json) {
    return JSON.stringify({
      cash: { byAcct: cash?.byAcct ?? {}, text: cash?.text ?? '' },
      trades: { rows: trades?.rows ?? [], text: trades?.text ?? '' },
      jobs: { failing: jobs?.failing ?? [], text: jobs?.text ?? '' },
    });
  }
  const lines = ['[Node 검증 숫자 — 운영실] (Google Sheets 결정론 조회 — 재조회·수정 금지)'];
  if (cash) lines.push('', '[예수금 — 계좌별]', cash.text);
  if (trades) lines.push('', '[체결내역]', trades.text);
  if (jobs) {
    lines.push('', '[잡상태]', jobs.text);
    // clamp된 요약 줄은 가독성용 — FAIL 사유(예: 실패 종목명·오류코드)가 잘려 안 보이면 실제 원인을
    // 놓친다. 여기 실패 잡의 전체 detail을 그대로 붙여 clamp로 인한 정보 손실을 막는다.
    if (jobs.failing?.length) {
      lines.push('', '[실패 상세 — 잘리지 않은 원문]');
      for (const f of jobs.failing) lines.push(`  ${f.job} (${f.status}): ${f.detail || '(상세 없음)'}`);
    }
  }
  lines.push('', '⚠️ 위 숫자만 사용하라. 어떤 수치도 직접 fetch·추정하지 말 것 — 역할은 사실만 보고하는 것뿐이다.');
  return lines.join('\n');
}

async function main() {
  loadEnv();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!hasServiceAccount()) {
    console.error('⚠️ 서비스계정 없음 — 시트 조회 불가(데이터 부족으로 처리, 추정 금지)');
    process.exit(1);
  }
  try {
    const token = await getToken(null, { allowBrowser: false });
    const want = (s) => opts.section === 'all' || opts.section === s;
    const [cashRows, tradeRows, jobRows] = await Promise.all([
      want('cash') ? getRange(token, '예수금기준!A2:E').catch(() => []) : Promise.resolve(null),
      want('trades') ? getRange(token, '체결내역!A2:M').catch(() => []) : Promise.resolve(null),
      want('jobs') ? getRange(token, '잡상태!A2:F').catch(() => []) : Promise.resolve(null),
    ]);
    const facts = {
      cash: cashRows ? assembleCash(cashRows) : null,
      trades: tradeRows ? assembleTrades(tradeRows, { name: opts.name }) : null,
      jobs: jobRows ? assembleJobs(jobRows) : null,
    };
    process.stdout.write(renderLedgerFacts(facts, { json: opts.json }) + '\n');
  } catch (e) {
    console.error(`⚠️ ledger facts 조립 실패: ${e.message} — 데이터 부족으로 처리(추정 금지)`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
