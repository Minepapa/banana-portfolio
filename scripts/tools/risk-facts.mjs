#!/usr/bin/env node
// risk-facts.mjs — 리스크관리실 Themis 대화형 보고용 Node 결정론 사실 조립기.
//
// 앱 최우선 원칙(LLM 숫자 날조 금지)의 Themis 확장(Phase 1 Athena·Phase 2 Hermes와 동일 패턴).
// Themis는 이미 read-only(Write/Edit 차단)였으나 숫자 fetch(Bash·MCP)는 막혀 있지 않았다 —
// 이 CLI + hermes.md와 같은 frontmatter tools 제한으로 하드 보장을 완성한다.
//
// /themis 커맨드가 스폰 전 이 CLI를 실행해 factsText를 주입한다.

import { loadEnv, hasServiceAccount, getToken, getRange } from '../lib/sheets-common.mjs';
import { RISK_COL, BASELINE_COL } from '../lib/sheet-contracts.mjs';
import { fetchMacroIndicators } from '../lib/fundamentals.mjs';
import { assembleJobs } from './ledger-facts.mjs';

const SECTIONS = ['all', 'signals', 'baseline', 'macro', 'jobs'];
const RISK_JOBS = ['risk-b', 'risk-d'];

export function parseArgs(argv) {
  let section = 'all', target = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--section') {
      section = argv[++i];
      if (!SECTIONS.includes(section)) throw new Error(`--section 값은 ${SECTIONS.join('|')} 여야 함: "${section}"`);
    } else if (a === '--target') target = argv[++i];
  }
  return { section, target, json };
}

const clamp = (s, max = 100) => (s.length <= max ? s : s.slice(0, max - 1) + '…');
// 정확일치 또는 선행 단어 매칭("알파벳"→"알파벳 Class A") — stock-facts.mjs findHolding과 동일
// 원칙(공백 경계로 과매칭 방지).
const nameMatch = (nm, target) => nm === target || nm.startsWith(target + ' ');

// 리스크모니터!A2:H(RISK_COL). target 지정 시 필터, 항상 날짜 내림차순(시트 append 순서는
// 시간순이 아니므로 — ledger-facts.mjs assembleTrades와 동일 교훈).
export function assembleSignals(rows, { target = null, limit = 10 } = {}) {
  const all = rows || [];
  if (!all.length) return { rows: [], text: '(리스크 신호 데이터 부족: 빈 응답)' };
  const filtered = target ? all.filter((r) => nameMatch(String(r[RISK_COL.TARGET] ?? '').trim(), target)) : all;
  if (!filtered.length) return { rows: [], text: `(리스크 신호 없음: "${target}" 매칭 없음)` };
  const sorted = [...filtered].sort((a, b) => String(b[RISK_COL.DATE] ?? '').localeCompare(String(a[RISK_COL.DATE] ?? '')));
  const recent = sorted.slice(0, limit);
  // clamp 400 — risk-monitor.mjs가 쓰기 시 clampLen(detail, 400)으로 저장하는 계약과 정합.
  // 더 짧게 자르면 Themis의 "걸린 트리거 원문 인용" 원칙이 실제 저장된 근거보다 먼저 잘려나간다.
  const lines = recent.map((r) =>
    `  ${r[RISK_COL.DATE]} [${r[RISK_COL.TYPE]}] ${r[RISK_COL.TARGET]} ${r[RISK_COL.SIGNAL]} ${r[RISK_COL.SUMMARY]} — ${clamp(String(r[RISK_COL.DETAIL] ?? ''), 400)}`
  );
  return { rows: recent, text: lines.join('\n') };
}

// 리스크기준선!A2:K(BASELINE_COL). target 지정 시 선행단어 매칭.
export function assembleBaseline(rows, { target = null } = {}) {
  const all = rows || [];
  if (!all.length) return { rows: [], text: '(기준선 데이터 부족: 빈 응답)' };
  const filtered = target ? all.filter((r) => nameMatch(String(r[BASELINE_COL.NAME] ?? '').trim(), target)) : all;
  if (!filtered.length) return { rows: [], text: `(기준선 없음: "${target}" 매칭 없음)` };
  const lines = filtered.map((r) =>
    `  ${r[BASELINE_COL.NAME]}(${r[BASELINE_COL.TICKER]}) 기준일 ${r[BASELINE_COL.DATE]}: 매출총이익률 ${r[BASELINE_COL.GROSS_MARGIN]}, 영업이익률 ${r[BASELINE_COL.OP_MARGIN]}, ROE ${r[BASELINE_COL.ROE]}, 부채비율 ${r[BASELINE_COL.DEBT_RATIO]}, EPS ${r[BASELINE_COL.EPS]}, PBR ${r[BASELINE_COL.PBR]}`
  );
  return { rows: filtered, text: lines.join('\n') };
}

// macroData: fetchMacroIndicators() 반환 형태({KEY: {value, change5d, source}}) — 이 함수는
// 순수(IO 없음), 실 조회는 main()에서 fetchMacroIndicators()로 수행해 주입한다(테스트 용이성).
// yfinance 원본은 부동소수점 그대로(예: 1487.4599609375) — 값을 바꾸는 게 아니라 반올림 표기만.
const round2 = (n) => Math.round(n * 100) / 100;

export function assembleMacro(macroData) {
  const entries = Object.entries(macroData || {});
  if (!entries.length) return '(거시지표 데이터 부족)';
  const lines = entries.map(([key, d]) => {
    if (d?.value == null) return `  ${key}: 데이터없음`;
    const chg = d.change5d != null ? `${d.change5d > 0 ? '+' : ''}${round2(d.change5d)}%` : '?';
    // §4 가드레일(checkGuardrails)은 종점 변동(change5d)이 아니라 저점대비 상승(rally5d)·고점대비
    // 낙폭(drawdown5d)으로 D신호를 발동한다 — 있으면 반드시 같이 노출해야 Themis 판정이 실제
    // 트리거 근거와 어긋나지 않는다(리뷰 지적).
    const extra = [];
    if (d.drawdown5d != null) extra.push(`고점대비 ${round2(d.drawdown5d)}%`);
    if (d.rally5d != null) extra.push(`저점대비 +${round2(d.rally5d)}%`);
    const extraText = extra.length ? `, ${extra.join(', ')}` : '';
    return `  ${key}: ${round2(d.value)} (5일 ${chg}${extraText}, 출처 ${d.source || '?'})`;
  });
  return lines.join('\n');
}

export function renderRiskFacts({ signals, baseline, macro, jobs }, { json = false } = {}) {
  if (json) {
    return JSON.stringify({
      signals: { rows: signals?.rows ?? [], text: signals?.text ?? '' },
      baseline: { rows: baseline?.rows ?? [], text: baseline?.text ?? '' },
      macro: macro ?? '',
      jobs: { failing: jobs?.failing ?? [], text: jobs?.text ?? '' },
    });
  }
  const lines = ['[Node 검증 숫자 — 리스크관리실] (Google Sheets·yfinance 결정론 조회 — 재조회·수정 금지)'];
  if (signals) lines.push('', '[리스크 신호 — 리스크모니터]', signals.text);
  if (baseline) lines.push('', '[펀더멘털 기준선]', baseline.text);
  if (macro) lines.push('', '[거시지표]', macro);
  if (jobs) lines.push('', '[감시 잡 상태 — risk-b·risk-d]', jobs.text);
  lines.push('', '⚠️ 위 숫자만 사용하라. 어떤 수치도 직접 fetch·추정하지 말 것 — 걸린 트리거는 원문 그대로 인용하라.');
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
  try {
    const want = (s) => opts.section === 'all' || opts.section === s;
    const sheetTasks = [];
    if (want('signals') || want('baseline') || want('jobs')) {
      if (!hasServiceAccount()) throw new Error('서비스계정 없음 — 시트 조회 불가');
      const token = await getToken(null, { allowBrowser: false });
      sheetTasks.push(
        want('signals') ? getRange(token, '리스크모니터!A2:H').catch(() => []) : Promise.resolve(null),
        want('baseline') ? getRange(token, '리스크기준선!A2:K').catch(() => []) : Promise.resolve(null),
        want('jobs') ? getRange(token, '잡상태!A2:F').catch(() => []) : Promise.resolve(null),
      );
    } else {
      sheetTasks.push(Promise.resolve(null), Promise.resolve(null), Promise.resolve(null));
    }
    const macroTask = want('macro')
      ? Promise.resolve().then(() => fetchMacroIndicators()).catch((e) => { console.error(`⚠️ 거시지표 조회 실패: ${e.message}`); return null; })
      : Promise.resolve(null);

    const [signalRows, baselineRows, jobRows, macroData] = await Promise.all([...sheetTasks, macroTask]);
    const facts = {
      signals: signalRows ? assembleSignals(signalRows, { target: opts.target }) : null,
      baseline: baselineRows ? assembleBaseline(baselineRows, { target: opts.target }) : null,
      macro: macroData ? assembleMacro(macroData) : (want('macro') ? '(거시지표 데이터 부족: 조회 실패)' : null),
      jobs: jobRows ? assembleJobs(jobRows.filter((r) => RISK_JOBS.includes(String(r[0] ?? '').trim()))) : null,
    };
    process.stdout.write(renderRiskFacts(facts, { json: opts.json }) + '\n');
  } catch (e) {
    console.error(`⚠️ risk facts 조립 실패: ${e.message} — 데이터 부족으로 처리(추정 금지)`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
