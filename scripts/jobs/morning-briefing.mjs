#!/usr/bin/env node
/**
 * 장 시작 전 아침 브리핑 자동발송 — ARCHITECTURE-V2.md 설계에 있었지만 미구현이던 것
 * (2026-08-23 오너 지시로 구현). 총자산 현황(State/Holdings 합산)·간밤 배당/체결 이벤트
 * (Facts/Ledger)·거시 5신호(macro-overlay-facts.mjs)를 매일 아침 텔레그램으로 보낸다.
 *
 * ⚠️ 설계 판단 — LLM 호출 없음(Node 전용). 매일 도는 잡에서 "간밤 이벤트 요약"을 LLM
 * 서술로 만들면 비용·환각 위험이 매일 누적된다. 이 잡의 세 섹션은 전부 이미 존재하는
 * 순수 Node 계산(buildHomeMirror·Facts/Ledger 읽기·macro-overlay-facts.mjs)의 재조립일
 * 뿐이라 판단(department reasoning)이 필요한 지점이 없다 — 그래서 daily-asset-allocation-
 * check.mjs·job-alerts.mjs와 같은 카테고리(순수 Node 인프라 알림)로 분류해 **운영실
 * Hermes**로 라벨링한다(execute-quant-proposal.mjs·watch-order-fill.mjs를 Kairos에서
 * Hermes로 재배정한 것과 동일 원칙, 같은 날 결정).
 *
 * 전일 대비 총자산 변화는 update-monthly-balance-snapshot.mjs의 MonthlyBalances 파일을
 * 재사용하지 않는다 — 그 파일은 "이번 달"을 매일 덮어써 어제 값이 남지 않는다(설계
 * 자체가 그렇게 되어 있음, 헤더 주석 참고). 대신 macro-overlay-facts.mjs의 Faber
 * "직전 확인 상태" 패턴과 동일하게, 이 잡 전용 State 캐시(State/MorningBriefing/
 * previous-total.md)에 매 실행마다 마지막 총자산·실행시각을 남겨 다음 실행이 비교 기준으로
 * 쓴다.
 *
 * ⚠️ 버그 수정(2026-08-23, 독립 코드리뷰 HIGH 지적 2건) — 처음엔 이 캐시가 "날짜만"
 * (YYYY-MM-DD)을 기억했는데, 이 잡이 그날 아침 실행된 "이후"(당일 낮~저녁)에 생긴 배당·
 * 체결은 다음날 실행 시점에 `날짜 > 날짜` 비교가 항상 거짓이라 영원히 보고에서 빠지는
 * 구조적 누락이 있었다(당일치가 통째로 사라짐, "마지막 실행 이후 누적분 전부 포함"이라는
 * 이 파일의 원래 설명과도 모순). Facts/Ledger 레코드는 전부 `recordedAt`(Node가 실제로
 * Vault에 쓴 시각, UTC ISO)을 갖고 있어 이걸 그대로 워터마크로 쓴다 — 날짜만이 아니라
 * 전체 타임스탬프로 비교해야 당일 이벤트도 안 빠진다.
 * 두 번째: 텔레그램 발송이 실패해도(네트워크 오류 등) 워터마크를 먼저 갱신해버리면 그
 * 실행에서 보고하려던 이벤트가 다음 실행에서도 "이미 지난 워터마크 이전"이 돼 영원히
 * 안 나간다 — 이제 발송이 실제로 성공한 뒤에만 워터마크를 전진시킨다(실패하면 다음
 * 실행이 이번 것까지 포함해서 다시 시도).
 *
 * 사용법: node scripts/jobs/morning-briefing.mjs [--dry-run]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { buildHomeMirror } from '../lib/firestore-mirror.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { renderSignalsReport } from '../tools/macro-overlay-facts.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const HERE = dirname(fileURLToPath(import.meta.url));
const DEPARTMENT_LABEL = '운영실 Hermes';
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'MorningBriefing');
const STATE_FILE = join(STATE_DIR, 'previous-total.md');

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

function readPreviousState() {
  if (!existsSync(STATE_FILE)) return { total: null, lastRunAt: null };
  const fm = parseFrontmatter(readFileSync(STATE_FILE, 'utf8'));
  return { total: fm.total ?? null, lastRunAt: fm.lastRunAt ?? null };
}

function writePreviousState(total, lastRunAt) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(STATE_FILE, buildFrontmatter({ type: 'morning-briefing-state', total, lastRunAt }));
}

// 순수함수 — holdings·직전 총자산을 받아 오늘 총자산·전일대비 텍스트를 만든다. 테스트 가능.
export function buildAssetSection(holdings, previousTotal) {
  const { totalEval } = buildHomeMirror({ holdings });
  const total = Math.round(totalEval);
  const lines = [`총자산: ${total.toLocaleString()}원`];
  if (previousTotal != null) {
    const delta = total - previousTotal;
    const pct = previousTotal > 0 ? (delta / previousTotal) * 100 : 0;
    const sign = delta >= 0 ? '+' : '';
    lines.push(`직전 대비: ${sign}${delta.toLocaleString()}원 (${sign}${pct.toFixed(2)}%)`);
  } else {
    lines.push('직전 대비: (첫 실행 — 비교 기준 없음)');
  }
  return { total, text: lines.join('\n') };
}

// 순수함수 — dividends/executions(Facts/Ledger 원본 배열)와 하한 타임스탬프(exclusive,
// 이전 실행의 lastRunAt — UTC ISO)를 받아 그 이후 이벤트만 골라 텍스트로 만든다.
// `recordedAt`(Node가 실제로 Vault에 쓴 시각, 모든 Ledger 레코드가 공통으로 가짐)으로
// 비교한다 — `date`/`tradeDate`는 KST 날짜/시각 문자열이라 UTC 워터마크와 직접 비교하면
// 시차만큼 어긋난다(위 헤더 주석 참고). sinceTimestamp가 null이면(첫 실행) 전부 "간밤"
// 으로 보지 않고 빈 결과를 반환한다 — 과거 전체 이력을 "간밤"이라고 잘못 보고하지 않기
// 위함(추정 금지 원칙).
export function buildEventsSection(dividends, executions, sinceTimestamp) {
  if (!sinceTimestamp) return '(첫 실행 — 비교 기준 없어 이벤트 생략)';
  const divs = (dividends || []).filter((d) => String(d.recordedAt ?? '') > sinceTimestamp);
  const execs = (executions || []).filter((e) => String(e.recordedAt ?? '') > sinceTimestamp);
  if (!divs.length && !execs.length) return '간밤 배당·체결 이벤트 없음';
  const lines = [];
  for (const d of divs) {
    lines.push(`  [배당] ${String(d.date).slice(0, 10)} ${d.stockName} ${Math.round(d.afterTaxAmount || 0).toLocaleString()}원`);
  }
  for (const e of execs) {
    lines.push(`  [체결] ${String(e.tradeDate).slice(0, 10)} ${e.tradeType} ${e.stockName} ${e.quantity}주`);
  }
  return lines.join('\n');
}

function fetchMacroText() {
  try {
    const raw = execFileSync('node', [join(HERE, '..', 'tools', 'macro-overlay-facts.mjs'), '--json'], {
      encoding: 'utf8', timeout: 120000,
    });
    return { signals: JSON.parse(raw) };
  } catch (e) {
    return { error: e.message.slice(0, 300) };
  }
}

async function main() {
  const holdings = readVaultDir(VAULT_PATHS.state.holdings);
  if (!holdings.length) { console.log('ℹ️ State/Holdings 비어있음 — 아침 브리핑 건너뜀(추정 안 함)'); return; }

  const previous = readPreviousState();
  const asset = buildAssetSection(holdings, previous.total);

  const dividends = readVaultDir(VAULT_PATHS.facts.ledger.dividends);
  const executions = readVaultDir(VAULT_PATHS.facts.ledger.executions);
  const eventsText = buildEventsSection(dividends, executions, previous.lastRunAt);

  const macroResult = fetchMacroText();
  const macroText = macroResult.signals
    ? renderSignalsReport(macroResult.signals)
    : `(거시신호 조회 실패: ${macroResult.error})`;

  const body = [
    '[자산현황]', asset.text,
    '', '[간밤 이벤트]', eventsText,
    '', macroText,
  ].join('\n');

  console.log(body);

  if (!DRY_RUN) {
    // 워터마크는 발송이 실제로 성공한 뒤에만 전진시킨다(위 헤더 주석 HIGH 지적 2번) —
    // 먼저 갱신하고 발송을 try/catch로 무시하면, 발송 실패 시 이번에 보고하려던 이벤트가
    // 다음 실행에서도 "이미 지난 워터마크"가 돼 영원히 안 나간다.
    try {
      await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '안내', body }));
      writePreviousState(asset.total, new Date().toISOString());
    } catch (e) { console.error('텔레그램 알림 실패(워터마크 미전진, 다음 실행에서 재시도):', e.message); }
  }
}

// import.meta.url 가드 — 이 파일은 morning-briefing.test.js가 buildAssetSection·
// buildEventsSection(순수함수)만 가져다 쓰려고 직접 import한다. 가드 없이 최상위에서
// main()을 그냥 부르면 테스트가 이 모듈을 import하는 순간 실제 Vault 쓰기·실제 텔레그램
// 발송까지 실행돼버린다(2026-08-23 실측 — 테스트 1회 실행으로 실제 브리핑이 나감,
// State/MorningBriefing/previous-total.md도 실제로 갱신됨). 다른 *-facts.mjs 도구들이
// 전부 이 가드를 쓰는 이유와 동일 — CLI로 직접 실행될 때만 main()이 돈다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ morning-briefing 오류:', e.message); process.exit(1); });
}
