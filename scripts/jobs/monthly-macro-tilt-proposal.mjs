#!/usr/bin/env node
/**
 * 월간 거시틸트 제안 — "자산분배 트랙 핵심 로직 설계" §4(2026-09-06, 오너 지시 "가장
 * 중요한 로직"). `daily-asset-allocation-check.mjs`는 거시 전술 오버레이 신호에 의미있는
 * 변화가 있으면 텔레그램 코멘터리만 보내고 끝난다 — `docs/ARCHITECTURE-V2.md`·
 * `athena.md`가 이미 약속한 "신호 발동 시 Themis 검증을 거친 실제 틸트 제안"은 지금까지
 * 코드에 전혀 없었다(daily 잡은 Decisions/Proposals를 아예 안 만듦). 이 잡이 "신호 →
 * 실제 제안"의 유일한 경로가 된다 — daily-asset-allocation-check.mjs는 그대로 둔다(빠르고
 * 저렴한 정보성 알림 채널로 계속 존재, Mon-Fri 16:30, 제안 없음).
 *
 * ⚠️ 독립 상태 필요 — daily-asset-allocation-check.mjs는 매 평일
 * State/MacroOverlay/faber-state.md를 갱신한다. 이 월간 잡이 같은 파일을 보면 "직전
 * 확인"이 어제(일별 알림 잡 기준)가 돼버려 크로스 감지 의미가 깨진다. 그래서
 * macro-overlay-facts.mjs의 readPreviousFaberState/writeFaberState를 stateDir
 * 파라미터로 이 잡 전용 디렉터리(State/MacroTiltProposal/)에 호출한다(vault-paths.mjs
 * macroTiltProposal 키).
 *
 * 틸트 규모 — 아직 5/25 밴드를 안 넘은 자산군엔 분기 리밸런싱의 "갭"이 없다. 대신
 * rebalance-gap.mjs computeBandEdgeDistance로 "밴드가 터지는 경계까지 남은 여유폭
 * (room)"을 계산해 그 50%(공유모듈 CAP_FRACTION)까지만 제안 가능하게 한다. 이미 이탈한
 * 자산군(room<=0)은 이 잡이 손 안 댐 — 분기 리밸런싱(rebalance-proposal.mjs) 소관.
 *
 * 2단계 검증 — Athena가 먼저 제안(신호 해석 + 틸트 방향·금액 판단), 그 다음 Themis가
 * "신호강도 대비 틸트 크기가 타당한지"만 2차 검증한다. Themis가 "보류"를 내려도 발송
 * 자체는 막지 않는다(오너 확정, §5) — 실시간 오너 세션이 없는 새벽 무인 실행이라 오너가
 * 텔레그램 승인/거부로 최종 게이트다. 대신 "보류" caveat를 reason에 이어붙여 오너가
 * Themis의 우려를 보고 판단하게 한다.
 *
 * 사용법:
 *   node scripts/jobs/monthly-macro-tilt-proposal.mjs            # 실제 판단+발송(월말 3일 창에서만)
 *   node scripts/jobs/monthly-macro-tilt-proposal.mjs --dry-run  # 신호·프롬프트까지, 발송 없음
 *   node scripts/jobs/monthly-macro-tilt-proposal.mjs --force    # 월 dedup 무시하고 강제 실행(수동 테스트용)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic, writeStateFile } from '../lib/state-writer.mjs';
import { computeMacroOverlaySignals } from '../lib/macro-overlay.mjs';
import { fetchCloses, TICKERS, readPreviousFaberState, writeFaberState, renderSignalsReport } from '../tools/macro-overlay-facts.mjs';
import { computeRebalanceGaps, computeBandEdgeDistance, normalizeAccount } from '../lib/rebalance-gap.mjs';
import { CAP_FRACTION, applyCappedAllocation, resolveAllocationPricing } from '../lib/allocation-proposal-shared.mjs';
import { ACCOUNT_ELIGIBLE_ASSET_CLASSES, findExistingInstruments } from '../lib/cash-allocation-candidates.mjs';
import { findCashBalance, resolveDesignatedCashBalance } from '../lib/cash-ledger.mjs';
import { rankAssetClassUniverse } from '../lib/instrument-scoring.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { createAndSendProposal } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { isProposalBlocked } from '../lib/proposal-mode.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DEPARTMENT_LABEL = '투자전략실 Athena';
const IN_SCOPE_ACCOUNTS = ['위탁', '연금저축'];
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'MacroTiltProposal');
const STATE_FILE = join(STATE_DIR, 'last-month.md');

// 순수함수 — KST 기준 "YYYY-MM" 라벨. 테스트 가능.
export function getMonthLabel(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// 순수함수 — 오늘 이 잡을 실제로 돌려야 하는지: 그 달의 마지막 3일(달력일 기준) 중
// 평일이고, 이번 달엔 아직 실행 기록이 없을 때만(quarterly-allocation-review.mjs
// shouldRunToday와 동일 원리 — 월말은 분기시작월처럼 고정 날짜가 아니라 28~31일로
// 달마다 다르므로, "이번 달 마지막 날에서 2일을 뺀 날짜 이후"로 계산한다).
export function shouldRunThisMonth(date, lastMonthLabel) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  if (date.getDate() < lastDayOfMonth - 2) return false;
  return getMonthLabel(date) !== lastMonthLabel;
}

function readLastMonth() {
  if (!existsSync(STATE_FILE)) return null;
  return parseFrontmatter(readFileSync(STATE_FILE, 'utf8')).month ?? null;
}

function writeLastMonth(month) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(STATE_FILE, buildFrontmatter({ type: 'monthly-macro-tilt-proposal-state', month, updatedAt: new Date().toISOString() }));
}

// 스코어링된 후보(rankInstruments 반환 모양) 상위 N개를 프롬프트 텍스트로(다른 두 잡의
// formatRankedUniverse와 동일 로직).
function formatRankedUniverse(ranked, topN = 3) {
  return ranked.slice(0, topN).map((r, i) => {
    const score = r.composite != null ? r.composite.toFixed(1) : '?';
    const gapNote = r.dataGaps.length ? `, 데이터 부족축: ${r.dataGaps.join('·')}` : '';
    return `        ${i + 1}. ${r.name} (점수 ${score}/100${gapNote})`;
  }).join('\n');
}

// 순수함수 — 아직 5/25 밴드를 안 넘은(room>0) 자산군만 골라 틸트 가능 여유폭·캡예산을
// 계산한다. 이미 이탈한 자산군은 분기 리밸런싱 소관이라 이 목록에서 제외한다.
// ⚠️ 알려진 한계(2026-09-06 코드리뷰 지적, MEDIUM) — 각 자산군의 room은 이 자산군
// "단독" 기준이다. 5개 자산군이 totalEval을 공유하므로, 한 자산군의 매수/매도가
// 다른 자산군의 currentPct를 (분모 변화로) 같이 움직여 room이 아슬아슬했던 다른
// 자산군을 실제로는 이탈시킬 수 있다 — 이 함수는 그 교차 효과를 재계산하지 않는다.
// 완전한 수정은 validateMacroTiltActions 이후 확정된 액션들을 반영한 가상
// holdings로 computeRebalanceGaps를 다시 돌려 재검증하는 것(별도 작업, 미착수).
export function computeTiltRoomFacts(gaps, totalEval) {
  return gaps.map((g) => {
    const { room } = computeBandEdgeDistance(g.targetPct, g.currentPct);
    return { assetClass: g.assetClass, targetPct: g.targetPct, currentPct: g.currentPct, room, capBudgetWon: room > 0 ? (room * CAP_FRACTION * totalEval) / 100 : 0 };
  }).filter((f) => f.room > 0);
}

// 순수함수 — Athena에게 줄 프롬프트. 거시신호 원문 + 틸트 가능 자산군별 여유폭·캡예산만
// 주고, "어느 자산군을 어느 방향으로 얼마나" 판단시킨다.
// cashByAccount({[account]: won}) — 코드리뷰 지적(2026-09-06, MEDIUM) 반영: 틸트
// 매수는 new-cash-allocation.mjs와 달리 실제 예수금 잔고를 참조하지 않아 "가용 현금
// 이상 매수" 제안이 생길 수 있었다(실주문 단계 order-gate가 최종 방어선이라 돈이
// 잘못 나가진 않지만, 오너가 승인 못 할 제안을 미리 보게 됨). 정보로 제공해 Athena가
// 스스로 반영하게 한다 — capBudget처럼 시스템이 강제로 캡하진 않는다(계좌별 캡까지
// 걸려면 applyCappedAllocation을 자산군 축 하나가 아니라 계좌×자산군 이중 축으로
// 확장해야 하는 별도 설계 작업이라 이번엔 정보 제공까지만).
export function buildMacroTiltPrompt({ signalsReport, roomFacts, rankedUniverseByClass = {}, cashByAccount = {} }) {
  const roomLines = roomFacts.map((r) => {
    const header = `[${r.assetClass}] 목표 ${r.targetPct}% / 현재 ${r.currentPct.toFixed(2)}% (밴드 여유폭 ${r.room.toFixed(2)}%p, 틸트 가능 최대 약 ${Math.round(r.capBudgetWon).toLocaleString('ko-KR')}원)`;
    const ranked = rankedUniverseByClass[r.assetClass];
    if (ranked && ranked.length) return `${header}\n  신규 매수 시 데이터 기반 순위 중에서만 골라라:\n${formatRankedUniverse(ranked)}`;
    return header;
  }).join('\n\n') || '(틸트 가능한 자산군 없음 — 전부 이미 이탈했거나 데이터 부족)';

  const cashLines = Object.entries(cashByAccount).map(([acc, won]) => `  ${acc}: ${Math.round(won).toLocaleString('ko-KR')}원`).join('\n') || '  (가용 예수금 데이터 없음)';

  return `[월간 거시틸트 제안] 거시 전술 오버레이 신호에 의미있는 변화가 감지됐다(재조회·
추정 금지, 이 숫자만 사용).

[거시 신호]
${signalsReport.trim()}

[아직 5/25 밴드를 안 넘은 자산군의 여유폭 — 이미 이탈한 자산군은 분기 리밸런싱 소관이라 여기 없음]
${roomLines}

[계좌별 가용 예수금 — 매수 제안은 이 금액을 넘지 않게 판단할 것, 넘으면 실제 주문
 단계에서 거부된다]
${cashLines}

판단 요청:
- 위 거시 신호가 어느 자산군에 어느 방향으로 영향을 주는지 판단해, 선제적으로 소폭
  조정("틸트")할 자산군·방향·금액을 제안해라. 신호와 무관해 보이는 자산군은 건드리지
  마라 — 모든 자산군을 매번 조정할 필요 없다.
- 제안 금액은 위에 표기된 "틸트 가능 최대" 금액과 가용 예수금 둘 다 넘지 말 것(전자는
  시스템이 강제로 캡한다, 후자는 실주문 단계에서 걸린다).
- instrumentName은 그 계좌·자산군의 기존 보유 종목을 최우선으로 재사용해라. 보유가
  전혀 없는 계좌에서 신규 매수를 제안할 땐 위 "데이터 기반 순위"가 제시된 자산군은
  반드시 그 목록 안에서만 골라라 — 스스로 다른 브랜드를 지어내지 마라.
- side는 "매수"(비중 확대) 또는 "매도"(비중 축소) — 매도는 실보유가 있는 계좌·종목만
  가능하다.
- reasoning은 네(아테나) 성격대로 — 왜 이 신호가 이 자산군·방향에 영향을 준다고
  보는지 1~2문장, Frank에게 텔레그램으로 그대로 전달된다.
- 특별히 조정할 만한 자산군이 없다고 판단되면 actions를 빈 배열로 둬라(빈 배열도
  정상 응답이다 — 억지로 뭔가 제안하지 마라).

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{
  "actions": [
    {"assetClass":"국내주식","side":"매수","account":"위탁","instrumentName":"...","amountWon":300000,"reasoning":"..."}
  ],
  "summary": "한줄 요약"
}
\`\`\``;
}

// 순수함수 — LLM 응답 검증(rebalance-proposal.mjs validateRebalanceActions와 동일 철학:
// 드롭이지 throw 아님) + 여유폭 50% 하드 캡(공유모듈 위임). rebalance-proposal과 다른
// 점: side가 자산군 방향에 고정되지 않는다(틸트는 Athena가 방향까지 판단) — 대신
// capBudgetByClass에 있는 자산군만 대상(이미 이탈한 자산군은 여기 없음).
export function validateMacroTiltActions(actions, { capBudgetByClass, holdings, rankedUniverseByClass = {} }) {
  // 중복/모순 방지(2026-09-06 코드리뷰 지적, LOW) — 같은 (계좌,자산군,종목,방향)이
  // 두 번 오거나, 같은 종목에 매수·매도가 동시에 오면 드롭한다. 유효 판정을 통과한
  // 액션만 기록(뒤에서 다른 사유로 드롭될 액션이 자리를 선점하지 않게 return 직전에만
  // 기록).
  const seenActionKeys = new Set();
  const sideByInstrument = new Map();
  return applyCappedAllocation(actions, {
    capBudget: capBudgetByClass,
    capLabel: '거시틸트 여유폭의 50%',
    validateItem: (a) => {
      const assetClass = String(a?.assetClass ?? '').trim();
      const side = String(a?.side ?? '').trim();
      const account = String(a?.account ?? '').trim();
      const instrumentName = String(a?.instrumentName ?? '').trim();
      let amountWon = Number(a?.amountWon);

      // Object.hasOwn(2026-09-06 코드리뷰 지적, LOW) — `in`은 Object.prototype 체인까지
      // 본다. LLM이 assetClass:"constructor"·"toString" 같은 이름을 주면 `in` 검사를
      // 통과해버린다(다음 캡 확인 단계에서 결국 걸리긴 하지만 사유가 "이미 소진"으로
      // 혼란스럽게 나옴 — rebalance-gap.mjs ACCOUNT_ALIASES가 이미 Object.create(null)로
      // 같은 부류 위험을 막아둔 전례가 있다).
      if (!Object.hasOwn(capBudgetByClass, assetClass)) return { ok: false, reason: `틸트 대상 밖 자산군(이미 이탈했거나 여유폭 없음): ${assetClass}` };
      if (side !== '매수' && side !== '매도') return { ok: false, reason: `side 값 이상: ${side}` };
      if (!IN_SCOPE_ACCOUNTS.includes(account)) return { ok: false, reason: `부적격 계좌: ${account}` };
      if (!instrumentName) return { ok: false, reason: '종목명 없음' };
      if (!Number.isFinite(amountWon) || amountWon <= 0) return { ok: false, reason: '금액 값 이상' };

      const instrumentKey = `${account}|${assetClass}|${instrumentName}`;
      if (seenActionKeys.has(`${instrumentKey}|${side}`)) {
        return { ok: false, reason: `같은 계좌·종목·방향 액션 중복: [${account}] ${side} ${instrumentName}` };
      }
      const opposingSide = sideByInstrument.get(instrumentKey);
      if (opposingSide && opposingSide !== side) {
        return { ok: false, reason: `같은 계좌·종목에 매수·매도 동시 제안(모순): [${account}] ${instrumentName}` };
      }

      if (side === '매수' && !ACCOUNT_ELIGIBLE_ASSET_CLASSES[account]?.includes(assetClass)) {
        return { ok: false, reason: `${account} 계좌가 담을 수 없는 자산군: ${assetClass}` };
      }
      if (side === '매수') {
        const existingCandidates = findExistingInstruments(holdings, account, assetClass);
        const ranked = rankedUniverseByClass[assetClass];
        if (existingCandidates.length === 0 && ranked && ranked.length) {
          const allowedNames = new Set(ranked.map((r) => r.name));
          if (!allowedNames.has(instrumentName)) {
            return { ok: false, reason: `신규 종목 후보 목록 밖(데이터 기반 순위에 없는 이름): [${account}] ${instrumentName}` };
          }
        }
      }
      if (side === '매도') {
        const held = holdings.find((h) => normalizeAccount(h.account) === normalizeAccount(account) && h.assetClass === assetClass && h.name === instrumentName);
        if (!held) return { ok: false, reason: `실보유 없음(매도 불가): [${account}] ${instrumentName}` };
        const heldEval = held.evalAmount ?? 0;
        if (heldEval <= 0) return { ok: false, reason: `보유평가액 0 이하(매도 불가): [${account}] ${instrumentName}` };
        if (amountWon > heldEval) amountWon = heldEval;
      }

      seenActionKeys.add(`${instrumentKey}|${side}`);
      sideByInstrument.set(instrumentKey, side);
      return { ok: true, key: assetClass, amountWon, normalized: { assetClass, side, account, instrumentName, reasoning: String(a?.reasoning ?? '') } };
    },
  });
}

// 순수함수 — Themis 2차 검증 프롬프트. 숫자 재도출 금지, "신호강도 대비 틸트 크기가
// 타당한지"만 판단. §5 결정(보류여도 발송은 막지 않음)은 main()의 후처리 몫이라 여기선
// 판정 요청만 한다.
export function buildThemisTiltReviewPrompt({ signalsReport, actions }) {
  const actionLines = actions.map((a) => `  - [${a.account}] ${a.side} ${a.instrumentName}(${a.assetClass}) 약 ${Math.round(a.amountWon).toLocaleString('ko-KR')}원 — ${a.reasoning}`).join('\n');
  return `[월간 거시틸트 2차 검증] 투자전략실 Athena가 아래 거시 신호를 근거로 제안한 틸트
액션을 검증해라(숫자 재도출 금지, 신호강도 대비 틸트 크기가 타당한지만 판단).

[거시 신호]
${signalsReport.trim()}

[Athena가 제안한 틸트 액션]
${actionLines}

판단 요청: 신호의 강도(크로스·볼린저 이탈 정도)에 비해 이 틸트 금액·방향이 과도하거나
부적절해 보이면 "보류"로, 타당하면 "통과"로 판정해라. "보류"여도 이 제안이 자동으로
막히진 않는다(오너가 텔레그램에서 최종 승인/거부한다) — 네 판정은 참고 caveat로 같이
전달될 뿐이니, 우려되는 지점을 구체적으로 짚어라.

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{"verdict":"통과 또는 보류","caveat":"우려 지점 1~2문장(통과면 빈 문자열 가능)"}
\`\`\``;
}

// 순수함수 — Themis 검증 결과를 액션 reason에 반영(§5 결정: 보류여도 발송 차단 안
// 함, caveat만 첨부). 코드리뷰 지적(2026-09-06, MEDIUM) 2건 반영:
//   ① verdict 형태를 검증 안 하면 LLM이 `{}`처럼 verdict 없는 JSON을 줬을 때
//      "통과"와 비교가 false가 돼 caveat(undefined)를 그대로 문자열 보간해 오너가
//      읽는 메시지에 "Themis undefined"가 나갈 뻔했다 — 항상 String()으로 방어.
//   ② 원래는 "통과"일 때 caveat를 무조건 버렸는데, 프롬프트 자체가 "통과면 빈 문자열
//      *가능*"이라고 caveat가 있을 수 있음을 명시한다 — caveat가 있으면 verdict와
//      무관하게 항상 붙인다(annual 잡과 달리 이 값 하나가 findings D·E를 동시에
//      닫는 지점이라 별도 함수로 분리해 테스트를 붙였다).
export function buildTiltReason(action, themisVerdict) {
  const verdict = String(themisVerdict?.verdict ?? '판정불명').trim();
  const caveat = String(themisVerdict?.caveat ?? '').trim();
  if (!caveat) return action.reasoning;
  return `${action.reasoning}\n\n[리스크관리실 Themis · ${verdict}] ${caveat}`;
}

// 매도/매수 제안 발송 결과가 전부 'created'여야 월 마커를 전진시킨다(rebalance-
// proposal.mjs allActionsSent와 동일 원칙 — 일부만 발송됐는데 마커를 전진시키면
// 나머지 액션은 다음 실행(다음 달)까지 영원히 유실된다).
export function allActionsSent(sendResults) {
  return sendResults.length > 0 && sendResults.every((r) => r.action === 'created');
}

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, filepath: join(dir, f), ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

function loadExistingProposals(dir) {
  return readMdDir(dir).map((p) => ({ ...p, ...parseProposal(readFileSync(p.filepath, 'utf8')) }));
}

async function main() {
  const now = new Date();
  const lastMonth = readLastMonth();
  if (!FORCE && !shouldRunThisMonth(now, lastMonth)) {
    console.log('ℹ️ 오늘은 월말 점검 대상 아님(이번 달 이미 실행됐거나 월말 3일/평일이 아님) — 건너뜀');
    return;
  }

  loadEnv();

  console.log('🌐 monthly-macro-tilt-proposal — 월간 거시틸트 제안 점검');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const proposalsBlocked = isProposalBlocked(existsSync(VAULT_PATHS.state.proposalMode) ? readFileSync(VAULT_PATHS.state.proposalMode, 'utf8') : null);
  if (proposalsBlocked) {
    console.log('  🚫 제안금지 모드 — 점검 자체를 건너뜀("제안요청"으로 해제 전까지, 월 마커도 안 건드림)');
    return;
  }

  let raw;
  try {
    raw = fetchCloses();
  } catch (e) {
    console.error(`  ❌ 거시지표 조회 실패: ${e.message} — 다음 실행 재시도`);
    return;
  }
  const previousFaberState = readPreviousFaberState(VAULT_PATHS.state.macroTiltProposal);
  const signals = computeMacroOverlaySignals({
    kospiCloses: raw[TICKERS.KOSPI], sp500Closes: raw[TICKERS.SP500],
    tnxCloses: raw[TICKERS.TNX], irxCloses: raw[TICKERS.IRX],
    dxyCloses: raw[TICKERS.DXY], vixCloses: raw[TICKERS.VIX], wtiCloses: raw[TICKERS.WTI],
    previousFaberState,
  });
  const signalsReport = renderSignalsReport(signals);
  console.log(signalsReport);

  // commitMonth() — Faber 상태 + 월 마커를 항상 같이 커밋한다(2026-09-06 코드리뷰
  // 지적, HIGH). 예전엔 Faber 상태를 신호 계산 직후 먼저 써버려서, 그 다음 Athena
  // 호출이 실패해 월 마커가 안 갱신돼도 Faber crossover는 이미 "소비"된 상태가 됐다
  // — 재시도 때 readPreviousFaberState가 방금 쓴 값을 "직전"으로 보고
  // detectFaberCrossover가 항상 false를 반환해(macro-overlay.mjs) 그 달의 진짜 크로스
  // 신호가 조용히 사라졌다(정확히 macro-overlay-facts.mjs의 --json 경로가 이미
  // 문서화해둔 "조회 한 번이 크로스를 소비한다" 함정과 같은 클래스). 이제 두 마커는
  // 이 함수를 통해서만, 항상 같은 시점에만 전진한다 — 이 함수를 안 거치는 모든 조기
  // return(거시조회 실패·Athena 실패/한도)은 둘 다 그대로 남아 다음 실행이 신호
  // 계산부터 정확히 다시 한다. DRY_RUN에선 호출 자체를 안 한다(쓰기 없음 원칙).
  const commitMonth = () => {
    writeFaberState(
      signals.faberDomestic?.aboveMA ?? previousFaberState.domestic,
      signals.faberForeign?.aboveMA ?? previousFaberState.foreign,
      VAULT_PATHS.state.macroTiltProposal,
    );
    writeLastMonth(getMonthLabel(now));
  };

  if (!signals.anyMeaningfulChange) {
    console.log('  ✅ 의미있는 변화 없음 — 이번 달 틸트 제안 불필요, 조용히 종료');
    if (!DRY_RUN) commitMonth();
    return;
  }

  const holdings = readMdDir(VAULT_PATHS.state.holdings);
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const roomFacts = computeTiltRoomFacts(gaps, totalEval);
  if (!roomFacts.length) {
    console.log('  ℹ️ 틸트 가능한 자산군 없음(전부 이미 5/25 밴드 이탈 — 분기 리밸런싱 소관) — 조용히 종료');
    if (!DRY_RUN) commitMonth();
    return;
  }

  const rankedUniverseByClass = {};
  for (const f of roomFacts) {
    const hasEmptyAccount = IN_SCOPE_ACCOUNTS.some((acc) => ACCOUNT_ELIGIBLE_ASSET_CLASSES[acc]?.includes(f.assetClass) && !findExistingInstruments(holdings, acc, f.assetClass).length);
    if (!hasEmptyAccount) continue;
    const ranked = await rankAssetClassUniverse(f.assetClass);
    if (ranked.length) rankedUniverseByClass[f.assetClass] = ranked;
  }

  // 계좌별 가용 예수금(new-cash-allocation.mjs와 동일 집계 — 금현물은 위탁에 합산) —
  // 정보 제공용(코드리뷰 지적, 2026-09-06). 값 없으면(update-cash-from-ledger.mjs
  // 아직 안 돌았거나 실패) 그 계좌는 목록에서 빠짐(0으로 추정 안 함).
  const wtCash = findCashBalance(holdings, '위탁');
  const goldCash = findCashBalance(holdings, '금현물');
  const pensionCash = findCashBalance(holdings, '연금저축');
  const cashByAccount = {};
  if (wtCash != null) cashByAccount['위탁'] = resolveDesignatedCashBalance({ wtCash, goldCash: goldCash ?? 0 });
  if (pensionCash != null) cashByAccount['연금저축'] = pensionCash;

  const ATHENA = loadAgent('athena', { fallbackModel: 'sonnet' });
  if (ATHENA.warning) console.log(`⚠ ${ATHENA.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || ATHENA.model;

  const prompt = buildMacroTiltPrompt({ signalsReport, roomFacts, rankedUniverseByClass, cashByAccount });
  if (DRY_RUN) { console.log(`\n┌─── 프롬프트(Athena) ───┐\n${prompt}\n└──────────────────┘`); return; }

  const capBudgetByClass = Object.fromEntries(roomFacts.map((f) => [f.assetClass, f.capBudgetWon]));
  let actions;
  try {
    const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: ATHENA.systemPrompt }));
    const { kept, dropped } = validateMacroTiltActions(r.actions, { capBudgetByClass, holdings, rankedUniverseByClass });
    dropped.forEach((d) => console.log(`  ⚠️ 액션 드롭: ${d.reason}`));
    actions = kept;
  } catch (e) {
    if (e.isLimit) { console.log('  ⏳ 사용량 한도 → 판단 보류(다음 실행 재시도, 월 마커 미전진).'); return; }
    console.error(`  ❌ Athena 틸트 판단 실패: ${e.message} — 다음 실행 재시도(월 마커 미전진)`);
    return;
  }
  if (!actions.length) {
    console.log('  ℹ️ Athena가 제안한 유효 액션 없음 — 이번 달 틸트 없음');
    commitMonth();
    return;
  }

  const THEMIS = loadAgent('themis', { fallbackModel: 'sonnet' });
  if (THEMIS.warning) console.log(`⚠ ${THEMIS.warning}`);
  let themisVerdict = { verdict: '통과', caveat: '' };
  try {
    const themisPrompt = buildThemisTiltReviewPrompt({ signalsReport, actions });
    themisVerdict = parseJsonBlock(await runHeadlessClaude(themisPrompt, THEMIS.model, 'Read', { appendSystemPrompt: THEMIS.systemPrompt }));
  } catch (e) {
    // Themis 검증 실패해도 발송 자체는 막지 않는다(§5와 같은 정신 — 실시간 오너 세션이
    // 없는 무인 실행이라 검증 단계 하나가 죽었다고 액션 전체가 유실되면 안 됨). 검증을
    // 못 받았다는 사실 자체를 caveat로 남긴다.
    console.error(`  ⚠️ Themis 2차 검증 실패(발송은 진행): ${e.message}`);
    themisVerdict = { verdict: '검증실패', caveat: `2차 검증 실행 자체가 실패함(${e.message.slice(0, 100)})` };
  }
  console.log(`  🔍 Themis 검증: ${themisVerdict.verdict}${themisVerdict.caveat ? ` — ${themisVerdict.caveat}` : ''}`);

  const existingProposals = loadExistingProposals(VAULT_PATHS.decisions.proposals);
  const sendResults = [];
  for (const action of actions) {
    const pricing = resolveAllocationPricing(holdings, { account: action.account, assetClass: action.assetClass, instrumentName: action.instrumentName, amountWon: action.amountWon });
    const reason = buildTiltReason(action, themisVerdict);
    try {
      const result = await createAndSendProposal({
        track: '자산분배', account: action.account, assetKey: pricing.assetKey, name: action.instrumentName,
        side: action.side, quantity: pricing.quantity, proposedPrice: pricing.proposedPrice,
        amountWon: action.amountWon,
        reason, departmentLabel: DEPARTMENT_LABEL,
        existingProposals,
        writeProposalFile: (filename, content) => writeStateFile(join(VAULT_PATHS.decisions.proposals, filename), content),
        sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r),
      });
      console.log(`  📤 [${action.account}] ${action.side} ${action.instrumentName}(${action.assetClass}): ${result.action}${result.reason ? ` (${result.reason})` : ''}`);
      // 코드리뷰 지적(2026-09-06, HIGH) — 성공한 제안을 existingProposals에 되먹이지
      // 않으면 같은 실행 안에서 다른 액션이 같은 (track,assetKey,side)를 다시 만들 때
      // 단일활성제안 판정이 방금 만든 제안을 못 보고 중복 제안을 또 만든다
      // (rebalance-proposal.mjs·new-cash-allocation.mjs는 이미 이렇게 함).
      if (result.action === 'created') {
        existingProposals.push({ filename: result.filename, ...parseProposal(readFileSync(join(VAULT_PATHS.decisions.proposals, result.filename), 'utf8')) });
      }
      sendResults.push(result);
    } catch (e) {
      console.error(`  ❌ [${action.account}] ${action.instrumentName} 제안 발송 실패: ${e.message} — 다음 실행 재시도`);
      sendResults.push({ action: 'failed' });
    }
  }

  // allActionsSent 가드(2026-09-06 코드리뷰 지적) — 일부 액션만 발송됐는데 월 마커를
  // 전진시키면 나머지 액션은 다음 달까지 영원히 유실된다(rebalance-proposal.mjs와
  // 동일 원칙). Faber 상태도 이 시점에만 같이 커밋(commitMonth)한다.
  if (allActionsSent(sendResults)) {
    commitMonth();
    console.log('  🔄 월 마커 갱신 — 이번 달은 완료');
  } else {
    console.log('  ⚠️ 일부 액션 발송 실패/차단 — 월 마커·Faber 상태 미전진(다음 실행 재시도)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ monthly-macro-tilt-proposal 오류:', e.message); process.exit(1); });
}
