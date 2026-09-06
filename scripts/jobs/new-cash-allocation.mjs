#!/usr/bin/env node
/**
 * 신규 현금 배분 — ARCHITECTURE-V2.md "신규 현금 배분 원칙" 절(2026-08-04 확정)의
 * Vault-native 구현. 구현계획서 Phase 8이 "신규 현금 배분(누적 50만원 트리거) 미구현"
 * 으로 열어둔 채 남겨뒀던 부분(2026-08-16 신설, 2026-08-18 실잔고 기반으로 전면 재작성).
 *
 * ⚠️ 재설계 경위(2026-08-18) — 원래(2026-08-16)는 Facts/Ledger/Dividends·Profits의
 * "돈이 들어온 이벤트"만 계좌별로 누적하는 방식이었다. 신설 다음날(08-17) 첫 자동
 * 실행에서 실제 예수금(위탁 1,164,516원)보다 약 10배 부풀려진 금액(11,598,305원)으로
 * 매수 제안이 나가는 사고가 났다 — "들어온 돈"만 더하고 "그 돈으로 오너가 이미 직접
 * 재투자한 것"을 빼지 않는 구조적 결함(근본 원인은 v2에 예수금앵커 → Vault 배선이
 * 아직 없어 진짜 현금 잔고를 실시간 추적할 방법 자체가 없었다는 것). 예수금앵커 배선
 * 완료(State/Holdings/{계좌}-예수금.md, update-cash-from-ledger.mjs) 후 이 잡을
 * 전면 재작성 — 이벤트를 추측으로 누적하는 대신, **매번 그 계좌의 실제 예수금 잔고를
 * 그대로 읽는다.** "미투자 현금"이 곧 실잔고이므로 이중계상·누락 자체가 구조적으로
 * 불가능하다(update-cash-from-ledger.mjs와 동일 철학 — 완전 재계산, 증분 누적 아님).
 * cash-accumulator.mjs(이벤트 누적 모듈)는 이 재작성으로 완전히 폐기·삭제됐다.
 *
 * 흐름:
 *   1. State/Holdings에서 각 계좌의 "예수금" 보유(isCashLike)를 읽어 실잔고를 얻는다.
 *      위탁은 금현물 잔고까지 합산한 값을 쓴다(오너 확정, 2026-08-18 — "금현물의 대기
 *      현금은 위탁과 합쳐서 같이 취급", cash-ledger.mjs resolveDesignatedCashBalance).
 *      실제 매수는 위탁 계좌에서 나가므로, 합산액이 위탁 단독 잔고보다 크면 금현물→위탁
 *      이체가 먼저 필요할 수 있다는 걸 오너가 알아서 판단한다(제안 문구에 명시).
 *   2. 계좌당(위탁·연금저축) 실잔고가 50만원 이상이고, 직전에 이 잔고로 이미 판단을
 *      트리거한 적이 없으면(State/CashAccumulator/{계좌}.md의 lastTriggeredBalance와
 *      다르면): computeRebalanceGaps(전체 보유)로 갭을 계산(rebalance-gap.mjs 재사용) →
 *      그 계좌가 세금상 담을 수 있는 자산군만 후보로 필터(cash-allocation-candidates.mjs)
 *      → Athena 헤드리스 판단(갭 크기·후보만 주고 "어디에 얼마씩"은 재량 — 고정공식
 *      금지, [[feedback-no-hardcoded-judgment]]) → Decisions/Proposals + 텔레그램 제안
 *      (proposal-flow.mjs 재사용, 트랙 무관 공용 함수라 새로 안 만듦).
 *   3. 배분 라인 전부 발송 성공 시에만 lastTriggeredBalance를 이번 잔고값으로 갱신한다
 *      — 실패(LLM 한도·일부 차단 등)하면 그대로 둬 다음 실행이 자연히 재시도한다(잔고가
 *      안 바뀌었으니 트리거 조건도 그대로 유지됨). 리셋할 "누적치" 자체가 이제 없다 —
 *      다음 실행은 그때의 실잔고를 새로 읽을 뿐이다(매수가 실제 체결되면 잔고 자체가
 *      자연히 줄어든다, parse-notifications-to-vault→update-holdings-from-executions→
 *      update-cash-from-ledger 루프로).
 *
 * ⚠️ 개별종목 배분 금지 — 위탁 레거시 개별종목(삼성전자 등) 전환은 오너 직접 판단
 * 영역(ARCHITECTURE-V2.md "정리된 항목과 그 이유" 표, 2026-08-02 확정). Athena 에이전트
 * 정의(athena.md)에 이미 "자산분배 트랙은 개별종목 신규 매수를 하지 않는다"가 있어
 * 시스템프롬프트로 1차 방어, 이 잡의 태스크 프롬프트에서도 명시적으로 재확인한다.
 * 2026-08-29부터 `cash-allocation-candidates.mjs`의 `findExistingInstruments`가
 * `rebalance-gap.mjs` `LEGACY_INDIVIDUAL_STOCKS`로 이 8종목을 후보 자체에서 Node
 * 레벨로 걸러내 — 프롬프트는 이제 이중 방어(자산분배 트랙 감사에서 발견·해소).
 *
 * 승인·체결: 이 잡은 제안 생성·발송까지만 한다. 자산분배 트랙엔 자동 브로커 실행이
 * 없다 — Frank가 텔레그램 승인 답장 후 본인이 직접 브로커 앱에서 주문하고, 그 체결이
 * 카카오 알림으로 다시 Vault에 들어오는 루프로 닫힌다.
 *
 * ⚠️ launchd 재활성화는 이 재작성만으로 자동으로 하지 않는다 — 실데이터 dry-run
 * 검증과 오너의 명시적 확인을 거친 뒤에 별도로 진행할 것(2026-08-17 사고 재발 방지 원칙).
 *
 * 사용법:
 *   node scripts/jobs/new-cash-allocation.mjs            # 실제 반영+제안 발송
 *   node scripts/jobs/new-cash-allocation.mjs --dry-run   # 잔고·프롬프트만 확인, 쓰기 없음
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { NEW_CASH_THRESHOLD_WON, CASH_ELIGIBLE_ACCOUNTS, resolveDesignatedCashBalance, findCashBalance } from '../lib/cash-ledger.mjs';
import { rankEligibleGaps, findExistingInstruments, ACCOUNT_ELIGIBLE_ASSET_CLASSES } from '../lib/cash-allocation-candidates.mjs';
import { rankAssetClassUniverse } from '../lib/instrument-scoring.mjs';
import { computeRebalanceGaps } from '../lib/rebalance-gap.mjs';
import { CAP_FRACTION, applyCappedAllocation, resolveAllocationPricingByName } from '../lib/allocation-proposal-shared.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { createAndSendProposal } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { isProposalBlocked } from '../lib/proposal-mode.mjs';

loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');
const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;
const DEPARTMENT_LABEL = '투자전략실 Athena';

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, filepath: join(dir, f), ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

// findCashBalance는 2026-08-30에 cash-ledger.mjs로 이전(코드리뷰 지적 — report-
// facts.mjs가 "그 계좌의 현금이 뭔지" 선택 규칙을 독립적으로 재구현하다 이 잡의
// 실제 정의와 갈라질 뻔했다). 여기서는 위 import로 그대로 받아쓰고, 기존
// import 경로(`from './new-cash-allocation.mjs'`)를 쓰던 테스트가 안 깨지게
// re-export만 유지한다.
export { findCashBalance };

// 스코어링된 후보(scripts/lib/instrument-scoring.mjs computeInstrumentScore 반환 모양)
// 상위 N개를 프롬프트용 텍스트 블록으로 렌더. 순수함수(rebalance-proposal.mjs
// formatRankedUniverse와 동일 로직 — 두 잡이 공유하는 프롬프트 관용구라 파일마다
// 따로 두되 형식은 맞춘다).
function formatRankedUniverse(ranked, topN = 3) {
  return ranked.slice(0, topN).map((r, i) => {
    const score = r.composite != null ? r.composite.toFixed(1) : '?';
    const gapNote = r.dataGaps.length ? `, 데이터 부족축: ${r.dataGaps.join('·')}` : '';
    return `    ${i + 1}. ${r.name} (점수 ${score}/100${gapNote})`;
  }).join('\n');
}

// Athena에게 줄 프롬프트 — 갭·후보(실존 보유)만 주고 "어디에 얼마씩"은 판단시킨다.
// 순수 함수(테스트 가능) — candidatesByClass: { [assetClass]: [{name,ticker,curPrice}] }.
// rankedUniverseByClass: { [assetClass]: rankInstruments 반환 배열 } — 그 자산군에 보유
// 후보가 전혀 없을 때만 채워짐(§2, 2026-09-06 신설, rebalance-proposal.mjs와 동일 설계).
export function buildCashAllocationPrompt({ account, availableCash, rankedGaps, candidatesByClass, rankedUniverseByClass = {} }) {
  const gapLines = rankedGaps.map((g) =>
    `  ${g.assetClass}: 목표 ${g.targetPct}% / 현재 ${g.currentPct.toFixed(2)}% (갭 ${g.absDeltaPct.toFixed(2)}%p, 부족)`,
  ).join('\n') || '  (이 계좌가 담을 수 있는 자산군 중 언더웨이트 없음)';

  const candLines = Object.entries(candidatesByClass).map(([cls, insts]) => {
    if (!insts.length) {
      const ranked = rankedUniverseByClass[cls];
      if (ranked && ranked.length) return `  [${cls}] 현재 이 계좌에 보유 없음 — 아래 데이터 기반 순위 중에서만 골라라:\n${formatRankedUniverse(ranked)}`;
      return `  [${cls}] 현재 이 계좌에 보유 없음 — 신규 ETF 제안 가능(가격 미확인, 아래 "신규 종목 선정 기준" 참고)`;
    }
    const lines = insts.map((h) => `    - ${h.name}${h.ticker ? `(${h.ticker})` : ''} 현재가 ${h.curPrice ?? '데이터 부족'}원`).join('\n');
    return `  [${cls}]\n${lines}`;
  }).join('\n');

  return `[신규 현금 배분 판단] ${account} 계좌의 현재 실제 예수금 잔고가 ${availableCash.toLocaleString('ko-KR')}원(문턱 ${NEW_CASH_THRESHOLD_WON.toLocaleString('ko-KR')}원 이상)이다. 어디에 얼마씩 배분할지 "판단"해줘.

[검증된 갭 — 시스템이 위탁+연금저축 합산 5/25 밴드 기준으로 계산한 값. 이 계좌가 세금상
 담을 수 있는 자산군만 후보로 이미 걸러져 있다. 재계산·재조회 금지, 이 숫자만 사용할 것]
${gapLines}

[이 계좌의 실존 보유 후보 — 새 종목을 지어내지 말고 최대한 이 목록 안에서 고를 것.
 마땅한 후보가 없는 자산군만 예외적으로 신규 ETF명을 제안할 수 있다(그 경우 quantity는
 시스템이 계산 못하니 amountWon만 명시)]
${candLines}

판단 규칙:
- 개별 회사 주식(삼성전자·엔비디아 등 레거시 전환 대상)에는 절대 배분하지 말 것 — ETF만.
- 갭이 가장 큰 자산군 하나에 몰아줘도 되고, 여러 자산군에 나눠도 된다(고정 비율 없음).
- **가용 예수금 전액을 한 번에 배분하려 하지 마라.** 이번엔 최대 절반 정도만 배분
  계획을 세우고, 나머지는 다음 현금 발생 시 이어가라 — 이 잡은 잔고가 바뀔 때마다
  다시 도니 "지금 다 써야 한다"는 압박을 가질 필요 없다.
- allocations의 amountWon 합계는 ${availableCash}원을 넘지 말 것.
- instrumentName은 위 후보 목록의 이름을 정확히 그대로 쓸 것(새로 짓지 말 것) — 신규
  제안일 때만 새 ETF명 사용 가능.
- **이미 보유 중인 종목이 후보에 있으면 그걸 최우선으로 재사용해라** — 새 브랜드를
  또 고르지 마라(같은 자산군에 매번 다른 ETF를 새로 제안하면 "같은 안건"으로 인식이
  안 돼 승인 대기 목록에 중복으로 쌓인다, 2026-08-29 오너 지적으로 실제로 발생한 문제).
- **신규 종목 선정 기준(보유 후보가 전혀 없을 때만)**: "데이터 기반 순위"가 제시된
  자산군은 **반드시 그 목록 안에서만** 골라라 — 스스로 다른 브랜드를 지어내지 마라
  (2026-09-06부터 이 목록 밖 이름은 시스템이 자동으로 드롭한다). 순위가 제시되지
  않은 자산군(아직 후보 데이터가 없음)은 기존대로 보수율(총보수)·유동성(거래대금·
  괴리율)·추적오차를 고려해 판단해라. 그리고 이후에도 이 계좌·이 자산군에 다시
  배분할 일이 생기면, 이번에 고른 이름과 일관되게 유지해라(매번 다른 브랜드를
  새로 짓지 말 것).
- reasoning은 시스템 프롬프트에 이미 주어진 네(아테나) 성격대로 써라 — 근거 없는
  낙관·비관 없이, 왜 이 자산군·종목을 골랐는지 침착하고 위엄 있게 1~2문장으로 풀어
  설명할 것. "갭이 커서"처럼 사실을 그대로 반복하는 기계적 문장 대신, 그 갭이 왜
  지금 채울 만한지에 대한 네 판단을 담아라. 이 reasoning은 Frank에게 텔레그램으로
  그대로 전달된다.

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{
  "allocations": [
    {"assetClass":"국내주식","instrumentName":"...","amountWon":300000,"reasoning":"왜 이 자산군·종목인지, 아테나의 말투로"}
  ],
  "summary": "한줄 요약"
}
\`\`\``;
}

// 분할매수 하드 캡(2026-08-23 오너 지적, rebalance-proposal.mjs validateRebalanceActions와
// 동일 원칙) — 프롬프트 지시("절반 정도만")를 Athena가 어겨도 한 번에 전액 배분이
// 물리적으로 불가능하게 만든다. 이 잡은 잔고가 바뀔 때마다 다시 돌기 때문에(트리거
// 상태가 실잔고 그대로라 캡을 걸어도 "다음 기회"가 자동으로 온다) 새 상태관리 없이
// 캡만 추가하면 된다.
//
// LLM 응답 검증 — 후보에 없는 자산군·개별종목은 드롭(THROW 아님, 나머지 유효한 라인은
// 살린다 — 부분 오염이 전체 제안을 막지 않게). 합계초과는 드롭이 아니라 캡까지 축소
// (rebalance-proposal.mjs와 동일 철학 — 초과분만 깎아 "일부라도 진행"이 되게 함).
// 공유모듈(allocation-proposal-shared.mjs) 위임 — 순수 함수. 여긴 자산군별이 아니라
// "가용잔고 전체" 단일 버킷이라 capBudget 키를 고정 문자열 하나로 둔다.
// candidatesByClass·rankedUniverseByClass가 있으면(buildCashAllocationPrompt와 동일
// 데이터) "보유 후보가 전혀 없던" 자산군의 instrumentName이 그 순위 목록 밖이면 드롭한다
// (2026-09-06 신설, rebalance-proposal.mjs validateRebalanceActions와 동일 설계 —
// Athena가 순위 목록을 무시하고 브랜드를 지어내도 물리적으로 막히게).
export function validateAllocations(allocations, { account, availableCash, eligibleClasses, candidatesByClass = {}, rankedUniverseByClass = {} }) {
  const capBudget = { ALL: availableCash * CAP_FRACTION };
  return applyCappedAllocation(allocations, {
    capBudget,
    capLabel: '가용잔고의 50%',
    validateItem: (a) => {
      const assetClass = String(a?.assetClass ?? '').trim();
      const amountWon = Number(a?.amountWon);
      const instrumentName = String(a?.instrumentName ?? '').trim();
      if (!eligibleClasses.includes(assetClass)) return { ok: false, reason: `${account} 계좌가 담을 수 없는 자산군: ${assetClass}` };
      if (!instrumentName) return { ok: false, reason: '종목명 없음' };
      if (!Number.isFinite(amountWon) || amountWon <= 0) return { ok: false, reason: '금액 값 이상' };
      const existingCandidates = candidatesByClass[assetClass] ?? [];
      const ranked = rankedUniverseByClass[assetClass];
      if (existingCandidates.length === 0 && ranked && ranked.length) {
        const allowedNames = new Set(ranked.map((r) => r.name));
        if (!allowedNames.has(instrumentName)) {
          return { ok: false, reason: `신규 종목 후보 목록 밖(데이터 기반 순위에 없는 이름): ${instrumentName}` };
        }
      }
      return { ok: true, key: 'ALL', amountWon, normalized: { assetClass, instrumentName, reasoning: String(a?.reasoning ?? '') } };
    },
  });
}

// 후보 보유 중 이름이 정확히 일치하는 것 찾아 가격 정보를 붙인다 — 없으면(신규 제안)
// quantity·proposedPrice는 null(order-gate.checkPriceDeviation이 null을 "적용 대상 아님"
// 으로 이미 처리하므로 안전). candidates는 호출부(main())가 이미 계좌+자산군으로 걸러
// 넘기므로 여긴 이름으로만 재확인(resolveAllocationPricingByName — account/assetClass
// 축을 아예 안 받는 별도 함수, 2026-09-06 코드리뷰 지적으로 optional-필터 설계에서
// 분리: "일부러 생략"과 "실수로 안 넘김"을 구분 못 하는 위험을 없앰). 순수 함수.
export function resolveInstrumentPricing(allocation, candidates) {
  return resolveAllocationPricingByName(candidates, { instrumentName: allocation.instrumentName, amountWon: allocation.amountWon });
}

// 배분 라인 발송 결과가 전부 'created'(실제 발송 성공)여야 트리거 상태를 갱신한다 —
// 'blocked'(거부 재상정 쿨다운 등)도 미발송이므로 갱신 대상이 아니다.
export function allAllocationsSent(sendResults) {
  return sendResults.length > 0 && sendResults.every((r) => r.action === 'created');
}

function loadExistingProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const content = readFileSync(join(dir, f), 'utf8');
    return { filename: f, content, ...parseProposal(content) };
  });
}

// State/CashAccumulator/{계좌}.md — "직전에 어느 실잔고 값으로 이미 배분판단을
// 트리거했는가"만 기억한다(2026-08-18 재작성 — 예전엔 이벤트 dedupKey를 누적했지만
// 이제 실잔고 자체를 매번 새로 읽으므로 그런 상태가 필요 없다). 잔고가 그대로면
// (오너가 아직 제안에 응답 안 함, 새 배당·매도도 없음) 매일 같은 제안을 반복 발송하지
// 않기 위한 최소한의 dedup — 잔고가 바뀌면(새 돈 유입 또는 매수 체결로 감소) 다시 트리거.
function readTriggerState(account) {
  const p = join(VAULT_PATHS.state.cashAccumulator, `${account}.md`);
  if (!existsSync(p)) return null;
  const parsed = parseFrontmatter(readFileSync(p, 'utf8'));
  return Number.isFinite(parsed.lastTriggeredBalance) ? parsed.lastTriggeredBalance : null;
}

async function writeTriggerState(account, lastTriggeredBalance) {
  const content = buildFrontmatter({
    type: 'cash-allocation-trigger', account, lastTriggeredBalance,
    updatedAt: new Date().toISOString(),
  });
  if (!DRY_RUN) {
    mkdirSync(VAULT_PATHS.state.cashAccumulator, { recursive: true });
    await writeStateFile(join(VAULT_PATHS.state.cashAccumulator, `${account}.md`), content);
  }
}

// 잔고가 문턱 아래로 내려갈 때 트리거 상태를 지운다(코드리뷰 지적, 2026-08-18) — 안
// 지우면 나중에 잔고가 "정확히 그 트리거값"으로 우연히 재상승했을 때 === 비교가 이미
// 처리한 걸로 착각해 영원히 재트리거를 못 하는 사각지대가 생긴다.
function clearTriggerState(account) {
  if (DRY_RUN) return;
  const p = join(VAULT_PATHS.state.cashAccumulator, `${account}.md`);
  if (existsSync(p)) rmSync(p, { force: true });
}

async function main() {
  console.log('💰 new-cash-allocation — 신규 현금 배분 점검(실잔고 기반)');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const proposalsBlocked = isProposalBlocked(existsSync(VAULT_PATHS.state.proposalMode) ? readFileSync(VAULT_PATHS.state.proposalMode, 'utf8') : null);
  if (proposalsBlocked) {
    console.log('  🚫 제안금지 모드 — 점검 자체를 건너뜀("제안요청"으로 해제 전까지)');
    return;
  }

  const holdings = readMdDir(VAULT_PATHS.state.holdings);

  const wtCash = findCashBalance(holdings, '위탁');
  const goldCash = findCashBalance(holdings, '금현물');
  const pensionCash = findCashBalance(holdings, '연금저축');

  // ⚠️ goldCash만 예외적으로 0 폴백(코드리뷰 지적, 2026-08-18 — wtCash==null은 아래서
  // 계좌 전체를 건너뛰는데 이건 왜 다른지 설명 필요). 금현물은 "위탁 잔고에 추가로 더
  // 합산되는 보조 입력"이라, 아직 계산된 적 없어도(update-cash-from-ledger.mjs가 그
  // 계좌를 아직 못 돌았을 때 등) 위탁 자체 잔고만으로 진행하는 쪽이 안전하다 — 잘못된
  // 방향(실제보다 과소평가)이지 과대평가(원래 사고 클래스)가 아니다. wtCash==null은
  // "이 계좌 자체를 아예 모른다"는 뜻이라 성격이 다르다(추정할 기준 자체가 없음).
  const availableCashByAccount = {
    위탁: wtCash != null ? resolveDesignatedCashBalance({ wtCash, goldCash: goldCash ?? 0 }) : null,
    연금저축: pensionCash,
  };

  let existingProposals = null;
  // 자산군별 순위는 계좌와 무관(같은 자산군이면 위탁·연금저축이 같은 순위를 공유) —
  // 계좌 루프 안에서 반복 계산·중복 KRX 조회를 피하려고 이번 실행 동안 캐시한다.
  const rankedUniverseCache = {};
  for (const account of CASH_ELIGIBLE_ACCOUNTS) {
    const availableCash = availableCashByAccount[account];
    if (availableCash == null) {
      console.log(`  ⚠️  ${account}: 예수금 잔고 없음(update-cash-from-ledger.mjs 아직 안 돌았거나 실패) — 건너뜀(0으로 추정 안 함)`);
      continue;
    }

    const lastTriggeredBalance = readTriggerState(account);
    console.log(`  ${account}: 실잔고 ${availableCash.toLocaleString('ko-KR')}원${account === '위탁' ? `(금현물 ${(goldCash ?? 0).toLocaleString('ko-KR')}원 합산)` : ''} (직전 트리거 ${lastTriggeredBalance != null ? lastTriggeredBalance.toLocaleString('ko-KR') + '원' : '없음'})`);

    if (availableCash < NEW_CASH_THRESHOLD_WON) {
      // ⚠️ 코드리뷰 지적(2026-08-18) — 트리거 상태를 그대로 두면, 나중에 잔고가 다시
      // "정확히 그 값"으로 돌아왔을 때(예: 문턱 밑으로 내려갔다가 우연히 같은 원 단위로
      // 재상승) === 비교가 "이미 처리함"으로 착각해 영원히 재트리거를 못 하는 사각지대가
      // 있었다. 문턱 아래로 내려가는 순간 상태를 지워서, 다음에 뭘로 다시 올라오든
      // "처음 보는 값"으로 취급되게 한다.
      if (lastTriggeredBalance != null) clearTriggerState(account);
      continue;
    }
    if (availableCash === lastTriggeredBalance) { console.log(`    → 직전과 동일 잔고 — 재트리거 안 함(오너 응답 대기 또는 신규 유입 없음)`); continue; }

    console.log(`\n💡 ${account} 실잔고 ${availableCash.toLocaleString('ko-KR')}원 — 배분 판단 시작`);

    const { gaps } = computeRebalanceGaps(holdings);
    const rankedGaps = rankEligibleGaps(gaps, account);
    const eligibleClasses = ACCOUNT_ELIGIBLE_ASSET_CLASSES[account];
    const candidatesByClass = Object.fromEntries(eligibleClasses.map((c) => [c, findExistingInstruments(holdings, account, c)]));

    const rankedUniverseByClass = {};
    for (const cls of eligibleClasses) {
      if (candidatesByClass[cls].length) continue; // 보유 후보가 있으면 순위 불필요(재사용 우선)
      if (!(cls in rankedUniverseCache)) rankedUniverseCache[cls] = await rankAssetClassUniverse(cls);
      if (rankedUniverseCache[cls].length) rankedUniverseByClass[cls] = rankedUniverseCache[cls];
    }

    const prompt = buildCashAllocationPrompt({ account, availableCash, rankedGaps, candidatesByClass, rankedUniverseByClass });
    if (DRY_RUN) { console.log(`\n┌─── 프롬프트 [${account}] ───┐\n${prompt}\n└──────────────────┘`); continue; }

    let allocations;
    try {
      const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));
      const { kept, dropped } = validateAllocations(r.allocations, { account, availableCash, eligibleClasses, candidatesByClass, rankedUniverseByClass });
      dropped.forEach((d) => console.log(`  ⚠️ 배분 라인 드롭: ${d.reason}`));
      allocations = kept;
    } catch (e) {
      if (e.isLimit) { console.log(`  ⏳ 사용량 한도 → 배분 판단 보류(다음 실행 재시도).`); continue; }
      console.error(`  ❌ ${account} 배분 판단 실패: ${e.message} — 다음 실행 재시도`);
      continue;
    }
    if (!allocations.length) { console.log(`  ⚠️ 유효한 배분 라인 없음 — 다음 실행 재시도`); continue; }

    existingProposals ??= loadExistingProposals(VAULT_PATHS.decisions.proposals);
    const sendResults = [];
    for (const alloc of allocations) {
      const candidates = candidatesByClass[alloc.assetClass] ?? [];
      const pricing = resolveInstrumentPricing(alloc, candidates);
      try {
        const result = await createAndSendProposal({
          track: '자산분배', account, assetKey: pricing.assetKey, name: alloc.instrumentName,
          side: '매수', quantity: pricing.quantity, proposedPrice: pricing.proposedPrice,
          amountWon: alloc.amountWon,
          reason: alloc.reasoning, departmentLabel: DEPARTMENT_LABEL,
          existingProposals,
          writeProposalFile: (filename, content) => writeStateFile(join(VAULT_PATHS.decisions.proposals, filename), content),
          sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r),
        });
        if (result.action === 'blocked') {
          console.log(`  ⛔ ${alloc.instrumentName} 제안 차단: ${result.reason}`);
          sendResults.push({ action: 'blocked' });
          continue;
        }
        console.log(`  ✅ 제안 발송: ${alloc.assetClass} → ${alloc.instrumentName} ${alloc.amountWon.toLocaleString('ko-KR')}원`);
        existingProposals.push({ filename: result.filename, ...parseProposal(readFileSync(join(VAULT_PATHS.decisions.proposals, result.filename), 'utf8')) });
        sendResults.push({ action: 'created' });
      } catch (e) {
        console.error(`  ❌ ${alloc.instrumentName} 제안 발송 실패: ${e.message}`);
        sendResults.push({ action: 'failed' });
      }
    }
    if (allAllocationsSent(sendResults)) {
      await writeTriggerState(account, availableCash);
      console.log(`  🔄 ${account} 트리거 상태 갱신(잔고 ${availableCash.toLocaleString('ko-KR')}원) — 이 잔고로는 재트리거 안 함`);
    } else {
      console.log(`  ⚠️ 일부 미발송(차단·실패) — 트리거 상태 유지(다음 실행 재시도, 이미 보낸 제안은 단일활성제안 원칙으로 중복 방지됨)`);
    }
  }

  console.log('\n🏁 완료');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ new-cash-allocation 오류:', e.message); process.exit(1); });
}
