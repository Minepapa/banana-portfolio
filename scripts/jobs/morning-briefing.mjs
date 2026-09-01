#!/usr/bin/env node
/**
 * 장 시작 전 아침 브리핑 자동발송 — ARCHITECTURE-V2.md 설계에 있었지만 미구현이던 것
 * (2026-08-23 오너 지시로 구현). 총자산 현황(State/Holdings 합산)·간밤 배당/체결 이벤트
 * (Facts/Ledger)·자산배분 밴드 상태(rebalance-gap.mjs, 자산분배 트랙 최소개입 자동화
 * 계획 Part 6)·거시 5신호(macro-overlay-facts.mjs)를 매일 아침 텔레그램으로 보낸다.
 *
 * ⚠️ 설계 판단 변경(2026-08-31, 오너 지적 — "숫자만 던지고 왜 중요한지·뭘 고민할지가
 * 없다") — 원래는 LLM 호출이 아예 없었다(비용·환각 위험 회피). 이제 "완전히 조용한
 * 날"(간밤 이벤트 없음 + 자산배분 밴드 내 정상 + 거시 5신호 전부 조용)엔 여전히 LLM을
 * 안 부르고 사실만 보낸다(비용 절감 + "할 말 없으면 짧게" 원칙, 오너 확정) — 하지만
 * 뭔가 하나라도 있으면 Hermes 헤드리스 판단으로 결론·맥락·의사결정을 붙인다. 부서 라벨은
 * 그대로 **운영실 Hermes**(현황 브리핑 영역, LLM 추가가 판단 소관을 바꾸지 않음 —
 * execute-quant-proposal.mjs·watch-order-fill.mjs를 Kairos에서 Hermes로 재배정한 것과
 * 동일 원칙).
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
import { computeRebalanceGaps } from '../lib/rebalance-gap.mjs';
import { loadEnv } from '../lib/auth.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage, parseDepartmentResponse, CONCLUSION_MARKER, CONTEXT_MARKER, DECISIONS_MARKER } from '../lib/telegram-messages.mjs';
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

// 순수함수 — computeRebalanceGaps 재사용해 조용한 "밴드 내 정상" 한 줄 또는 이탈
// 자산군만 짚는 한 줄을 만든다(2026-08-23, 자산분배 트랙 최소개입 자동화 계획 Part 6).
// 새 발송 채널을 늘리지 않고 이미 매일 나가는 아침 브리핑에 끼워 넣는다 — "조용하면
// 조용하다"는 신호 자체가 "손 안 대도 된다"는 안심을 준다(daily-asset-allocation-check.mjs
// 처럼 이탈 있을 때만 따로 알림 보내는 것과 별개로, 이건 매일 상태를 보여주는 용도).
export function buildAllocationSection(holdings) {
  const { gaps } = computeRebalanceGaps(holdings);
  const breached = gaps.filter((g) => g.breached);
  if (!breached.length) return '자산배분: 밴드 내 정상';
  return `자산배분: ${breached.length}개 자산군 이탈 중(${breached.map((g) => g.assetClass).join(', ')})`;
}

// 순수함수(2026-08-31 신설) — 네 섹션이 전부 "특별한 거 없음" 상태인지 판정. 이 경우만
// LLM 호출을 생략(비용 절감, 오너 확정) — 나머지 경우는 전부 Hermes 판단을 붙인다.
// hasSignals=false(거시신호 조회 자체가 실패)면 "조용함"이 아니라 "확인 필요"로 취급해
// 실패가 조용한 날 뒤에 조용히 묻히지 않게 한다.
// ⚠️ macroText.includes('[경고]')는 5개 신호 중 하나라도 개별 이탈이면 걸린다(코드리뷰
// 지적) — renderSignalsReport의 종합판정 "[정상] 5개 신호 전부 조용함"보다 더 민감한
// 기준이라, "완전히 조용한 날"이 이 설계 의도(daily-asset-allocation-check.mjs가 매일
// 16:30에 이미 잡아내는 것과 같은 기준)보다 드물게 나올 수 있다 — 안전한 방향(과소
// 발송보다 과다 호출)이라 의도적으로 이렇게 뒀다.
export function isFullyQuiet({ eventsText, allocationText, macroText, hasSignals }) {
  const eventsQuiet = eventsText === '간밤 배당·체결 이벤트 없음' || eventsText === '(첫 실행 — 비교 기준 없어 이벤트 생략)';
  const allocationQuiet = allocationText === '자산배분: 밴드 내 정상';
  const macroQuiet = hasSignals && !macroText.includes('[경고]');
  return eventsQuiet && allocationQuiet && macroQuiet;
}

// 순수함수 — 네 섹션을 formatFactsMessage용 facts 배열로. 각 섹션 자체가 이미 여러 줄일
// 수 있어(themis-risk-review.mjs·daily-asset-allocation-check.mjs와 동일 관례) fact
// 1개 = 섹션 1개로 묶는다.
export function buildMorningBriefingFacts({ assetText, eventsText, allocationText, macroText }) {
  return [
    `[자산현황]\n${assetText}`,
    `[간밤 이벤트]\n${eventsText}`,
    allocationText,
    macroText,
  ];
}

// 순수함수 — Hermes에게 줄 프롬프트. 네 섹션은 이미 위 facts로 불릿 처리돼 먼저
// 나가므로, LLM 출력은 숫자 재나열이 아니라 "오늘 뭘 신경 써야 하는지"에 집중한다.
export function buildMorningBriefingPrompt({ assetText, eventsText, allocationText, macroText }) {
  return `[아침 브리핑] 아래는 오늘 아침 시점의 검증된 사실이다(재조회·추정 금지, 이
숫자만 사용). 전부 텔레그램 메시지에 이미 불릿으로 따로 나간다 — 아래 출력에서 다시
나열하지 마라.

[자산현황]
${assetText}

[간밤 이벤트]
${eventsText}

[자산배분]
${allocationText}

[거시 전술 오버레이]
${macroText}

판단 요청:
1. 오늘 아침 시점에서 오너가 실제로 신경 써야 할 게 무엇인지 짚어라 — 위 네 섹션 중
   특별한 게 없는 건 언급하지 말고, 실제로 눈에 띄는 것(자산배분 이탈폭이 큰지, 거시
   경고가 있는지, 간밤 이벤트가 큰 금액인지 등)만 짚어라.
2. 오늘 하루 시장을 지켜볼 때 뭘 눈여겨봐야 할지 방향을 제시해라(구체적 매수·매도
   지시는 아님 — 이 잡은 순수 현황 브리핑이다).

형식(반드시 정확히 이 세 마커로 응답을 나눠라, 다른 마커·JSON·마크다운·이모지·
이모티콘·긴 하이픈(—) 없이 순수 텍스트만 — 문장은 마침표로 끊어라):
${CONCLUSION_MARKER}
오늘 한 줄로(예: "특별히 서두를 일 없는 하루입니다" / "달러 갭을 주시할 만합니다").

${CONTEXT_MARKER}
왜 그렇게 보는지 근거 1~3문장. 문장 사이는 줄바꿈으로 분리해라 — 한 문단에 몰아쓰지
마라.

${DECISIONS_MARKER}
오늘 신경 쓸 점을 "- "로 시작하는 줄로 1~3개.`;
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

  const allocationText = buildAllocationSection(holdings);
  const sections = { assetText: asset.text, eventsText, allocationText, macroText };

  console.log([
    '[자산현황]', asset.text,
    '', '[간밤 이벤트]', eventsText,
    '', allocationText,
    '', macroText,
  ].join('\n'));

  const facts = buildMorningBriefingFacts(sections);
  const quiet = isFullyQuiet({ ...sections, hasSignals: !!macroResult.signals });

  let conclusion = null;
  let context = null;
  let decisions = null;

  if (quiet) {
    console.log('ℹ️ morning-briefing: 완전히 조용한 날 — LLM 해석 생략, 사실만 발송');
  } else if (DRY_RUN) {
    console.log('(드라이런 — LLM 프롬프트만 확인, 실제 호출 없음)\n');
    console.log(buildMorningBriefingPrompt(sections));
  } else if (cooldownActive()) {
    // AGENTS.md "claude 호출 규칙" — 새 claude 호출 잡은 호출 전 cooldownActive() 가드
    // 필수(쿨다운 중이면 skip). 이 잡은 2026-08-31에 처음 LLM을 부르게 된 잡이라 이
    // 규칙 대상 — 사실만 발송(아래 catch와 동일하게 통째로 유실 안 함).
    console.log('⏳ 쿨다운 중 — Hermes 판단 생략, 사실만 발송');
  } else {
    loadEnv();
    const AGENT = loadAgent('hermes', { fallbackModel: 'sonnet' });
    if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
    const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;
    try {
      const judgment = (await runHeadlessClaude(buildMorningBriefingPrompt(sections), MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt })).trim();
      console.log(judgment);
      ({ conclusion, context, decisions } = parseDepartmentResponse(judgment));
    } catch (e) {
      // Hermes 판단 실패해도 브리핑 자체(사실)는 여전히 유용하니 잡을 죽이지 않는다 —
      // 사실만이라도 발송(conclusion·context·decisions는 null로 남음).
      console.error(`⚠ Hermes 헤드리스 판단 실패(사실만 발송): ${e.message}`);
    }
  }

  if (!DRY_RUN) {
    // 워터마크는 발송이 실제로 성공한 뒤에만 전진시킨다(위 헤더 주석 HIGH 지적 2번) —
    // 먼저 갱신하고 발송을 try/catch로 무시하면, 발송 실패 시 이번에 보고하려던 이벤트가
    // 다음 실행에서도 "이미 지난 워터마크"가 돼 영원히 안 나간다.
    try {
      await sendTelegram(formatFactsMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '안내', facts, conclusion, context, decisions }));
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
