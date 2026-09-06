#!/usr/bin/env node
/**
 * 자동 리밸런싱 제안 — 자산분배 트랙 최소개입 자동화 계획 Part 3(2026-08-23, 오너 지시).
 *
 * ⚠️ 메꾸는 공백 — daily-asset-allocation-check.mjs는 원래 평일 16:30마다 5/25 밴드
 * 이탈을 점검하고 텔레그램 알림만 보내고 끝났다(Proposal 생성 없음). 이탈 알림을 받은
 * 뒤 오너가 직접 "리밸런싱안 줘"라고 물어야만 실제 매수/매도 제안이 나왔다 — 신규현금
 * 배분(new-cash-allocation.mjs)은 이미 완전 자동인데 순수 밴드이탈만 이 구멍이 있었다.
 * 이 잡이 그 구멍을 메운다 — new-cash-allocation.mjs와 같은 골격(Node 사실계산 →
 * Athena 헤드리스 판단 → createAndSendProposal)이지만 별도 파일이다.
 *
 * ⚠️ 트리거를 매일→분기로 전환(2026-08-29, 오너 지적+Athena 검토) — 원래는 매일
 * 검사하고 "이탈 자산군 집합의 지문"이 지난번과 같으면 스킵하는 dedup을 썼는데, 이건
 * `docs/ARCHITECTURE-V2.md`의 "리밸런싱 규칙 — Swedroe 5/25 룰" 절(정본, 확정됨)이
 * 이미 명시한 "분기 1회 점검"(Vanguard 60/40 연구 근거 — 더 자주 리밸런싱해도 성과
 * 개선 없이 거래비용만 증가, 위탁은 과세 계좌라 회전 최소화가 더 중요)을 구현 단계에서
 * 조용히 어긴 것이었다. 오너가 자산 축적기엔 매일 밴드체크가 안 맞는다고 직접 지적했고,
 * Athena 검토 결과도 일치 — 이제 `quarterly-allocation-review.mjs`와 정확히 같은
 * 트리거 패턴(`getQuarterLabel`·`shouldRunToday` 재사용)을 쓴다: 분기 시작월(1·4·7·10월)
 * 1~3일 중 첫 평일에만 실행, `State/RebalanceProposal/last-quarter.md`로 같은 분기
 * 중복실행 방지. 5/25 밴드 이탈 자체가 "시세 이벤트라 방치 위험"이라는 옛 근거는, 이미
 * 매일 도는 거시 전술 오버레이(daily-asset-allocation-check.mjs)가 시장 급변을 별도로
 * 잡아내므로 여기서 떠안을 필요가 없다는 게 이번 검토 결론이다(그 잡 헤더 주석 참고).
 * 옛 지문 기반 dedup(computeBreachFingerprint)은 매일 재검사 전제였던 장치라 분기
 * 트리거에선 구조적으로 불필요해져 제거했다.
 *
 * 분할매수(오너 지적 반영, 2026-08-23) — Athena가 프롬프트 지시를 어겨도 "갭 전체를
 * 한 번에 채우기"가 물리적으로 불가능하도록 validateRebalanceActions가 각 자산군 갭의
 * 최대 50%로 하드 캡을 건다. ⚠️ 분기 전환 이후 이 캡의 의미가 달라졌다 — 원래는 "내일
 * 다시 검사해 나머지를 이어서 채운다"는 전제였지만, 이제 다음 기회는 최소 다음 분기다.
 * 즉 한 번 크게 이탈하면 캡 때문에 완전히 정상화되기까지 최대 2개 분기(약 6개월)가
 * 걸릴 수 있다 — 이 트레이드오프는 이번 전환에서 그대로 남겨뒀다(캡 값 자체를 바꾸는
 * 건 별도 판단이 필요해 오너에게 보고, 이번엔 주기만 고쳤다). 달러 자산군은 미국달러
 * ETF·엔선물ETF 두 상품에 나눠 담으라고 프롬프트에 명시(오너의 구체적 상품 계획).
 *
 * 승인·체결: new-cash-allocation.mjs와 동일 원칙 — 이 잡은 제안 생성·발송까지만 한다.
 * 실제 체결은 오너가 직접(자산분배 트랙엔 자동 브로커 실행이 없음, proposal-execution-
 * reminder.mjs가 미체결을 리마인드로 보완).
 *
 * ⚠️ 레거시 개별종목 하드가드(2026-08-29 신설, 자산분배 트랙 감사에서 해소) — 매도
 * 방향(초과 자산군)의 후보 목록에 위탁 레거시 개별종목(삼성전자 등)이 실보유로 섞여
 * 나오던 문제를 `rebalance-gap.mjs`의 `LEGACY_INDIVIDUAL_STOCKS`(오너가 이미 확정한
 * 8종목 전량매도 목록 그대로, 이름 패턴 추정 아님)로 이제 Node가 직접 걸러낸다 —
 * 프롬프트 지시는 이중 방어로 계속 유지. `cash-allocation-candidates.mjs`의
 * `findExistingInstruments`도 같은 필터를 적용해 매수 후보 재사용 목록에서도 제외됨
 * (new-cash-allocation.mjs도 동일 함수를 공유해 같이 해소). 단, 이 목록은 "지금 확정된
 * 8종목"만 알아 스키마 자체의 ETF/개별주식 구분 필드 부재라는 근본 한계까지 없앤 건
 * 아니다 — 오너가 새로 다른 개별종목을 사면 이 하드가드가 자동으로 못 잡는다(그 경우
 * LEGACY_INDIVIDUAL_STOCKS에 수동 추가 필요). ⚠️ 후속 코드리뷰 지적(같은 날, 커밋 전) —
 * 후보만 거르고 gapWon(갭 금액)은 그대로 두면, "초과분 대부분이 레거시 종목 때문"인
 * 자산군에서 정상 ETF만 후보로 남아 Athena가 그 ETF를 대신 팔아 갭을 메우라는 압력을
 * 받는다(라이브 데이터로 실제 재현 — 국내주식 초과 9.9M원 중 4,240만원이 레거시
 * 8종목). buildBreachFacts가 legacyExcludedEval을 별도 계산해 프롬프트에 "이 초과분
 * 중 얼마는 레거시라 갭 전체를 후보만으로 메우려 하지 마라"는 맥락을 추가해 해소.
 *
 * 사용법:
 *   node scripts/jobs/rebalance-proposal.mjs            # 실제 판단+발송(분기 트리거일 때만)
 *   node scripts/jobs/rebalance-proposal.mjs --dry-run  # 프롬프트까지, 발송 없음
 *   node scripts/jobs/rebalance-proposal.mjs --force    # 분기 dedup 무시하고 강제 실행(수동 테스트용)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { computeRebalanceGaps, normalizeAccount, isLegacyIndividualStock } from '../lib/rebalance-gap.mjs';
import { CAP_FRACTION, applyCappedAllocation, resolveAllocationPricing } from '../lib/allocation-proposal-shared.mjs';
import { ACCOUNT_ELIGIBLE_ASSET_CLASSES, findExistingInstruments } from '../lib/cash-allocation-candidates.mjs';
import { rankAssetClassUniverse } from '../lib/instrument-scoring.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { createAndSendProposal } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { getQuarterLabel, shouldRunToday } from './quarterly-allocation-review.mjs';
import { isProposalBlocked } from '../lib/proposal-mode.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DEPARTMENT_LABEL = '투자전략실 Athena';
const IN_SCOPE_ACCOUNTS = ['위탁', '연금저축'];
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'RebalanceProposal');
const STATE_FILE = join(STATE_DIR, 'last-quarter.md');

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, filepath: join(dir, f), ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

// 순수함수 — 이탈된 자산군마다 방향(초과/부족)·갭금액(원)·매도후보(과대보유쪽 실보유,
// 계좌태그 포함)·매수후보(과소보유쪽, 계좌별 세금자격 기준)를 계산. Node는 여기까지만 —
// 구체적으로 뭘 얼마나 팔고 살지는 Athena 재량(rebalance-gap.mjs 헤더 주석과 동일 경계).
export function buildBreachFacts(holdings, gaps, totalEval) {
  const breached = gaps.filter((g) => g.breached);
  return breached.map((g) => {
    const direction = g.absDeltaPct > 0 ? '초과' : '부족';
    const gapWon = Math.round(((g.targetPct - g.currentPct) / 100) * totalEval); // 음수=팔아야, 양수=사야
    if (direction === '초과') {
      const inClassHoldings = holdings.filter((h) => IN_SCOPE_ACCOUNTS.includes(normalizeAccount(h.account)) && h.assetClass === g.assetClass);
      const sellCandidates = inClassHoldings
        .filter((h) => !isLegacyIndividualStock(h.name))
        .map((h) => ({ account: normalizeAccount(h.account), name: h.name, ticker: h.ticker, qty: h.qty, curPrice: h.curPrice, evalAmount: h.evalAmount }));
      // 코드리뷰 지적(2026-08-29) — 레거시 개별종목을 매도후보에서만 빼고 gapWon은
      // 그대로 두면, "초과분 대부분이 사실 레거시 종목 때문"인데 후보엔 정상 ETF만
      // 남아 Athena가 그 ETF를 대신 팔아 갭을 메우라는 압력을 받는다(실제로 지금
      // 라이브 데이터로 재현됨 — 국내주식 초과 9.9M원 중 4,240만원이 레거시 8종목).
      // Athena가 "이 초과분은 손댈 수 없는 레거시 때문"이라고 판단할 수 있게 그 금액을
      // 별도로 알려준다 — gapWon 자체는 안 바꾼다(그건 여전히 사실이므로), 프롬프트에서
      // 맥락만 보탠다.
      const legacyExcludedEval = inClassHoldings
        .filter((h) => isLegacyIndividualStock(h.name))
        .reduce((s, h) => s + (h.evalAmount ?? 0), 0);
      return { ...g, direction, gapWon, sellCandidates, legacyExcludedEval };
    }
    const buyCandidatesByAccount = {};
    for (const account of IN_SCOPE_ACCOUNTS) {
      if (ACCOUNT_ELIGIBLE_ASSET_CLASSES[account]?.includes(g.assetClass)) {
        buyCandidatesByAccount[account] = findExistingInstruments(holdings, account, g.assetClass);
      }
    }
    return { ...g, direction, gapWon, buyCandidatesByAccount };
  });
}

// 스코어링된 후보(scripts/lib/instrument-scoring.mjs computeInstrumentScore 반환 모양)
// 상위 N개를 프롬프트용 텍스트 블록으로 렌더. 순수함수.
function formatRankedUniverse(ranked, topN = 3) {
  return ranked.slice(0, topN).map((r, i) => {
    const score = r.composite != null ? r.composite.toFixed(1) : '?';
    const gapNote = r.dataGaps.length ? `, 데이터 부족축: ${r.dataGaps.join('·')}` : '';
    return `        ${i + 1}. ${r.name} (점수 ${score}/100${gapNote})`;
  }).join('\n');
}

// 순수함수 — Athena에게 줄 프롬프트. 이탈 사실·후보만 주고 "구체적으로 뭘 얼마나
// 팔고 살지"만 판단시킨다(rebalance-gap.mjs 헤더 주석의 경계와 동일).
// rankedUniverseByClass: { [assetClass]: rankInstruments 반환 배열 } — 그 자산군에
// "보유 후보가 전혀 없는 계좌"가 있을 때만 채워짐(§2, 2026-09-06 신설). 신규 종목을
// Athena가 자유롭게 지어내지 못하게, 이 목록이 있으면 그 안에서만 고르도록 지시한다.
export function buildRebalanceProposalPrompt(breachFacts, rankedUniverseByClass = {}) {
  const sections = breachFacts.map((b) => {
    const header = `[${b.assetClass}] 목표 ${b.targetPct}% / 현재 ${b.currentPct.toFixed(2)}% — ${b.direction}(갭 약 ${Math.abs(b.gapWon).toLocaleString('ko-KR')}원)`;
    if (b.direction === '초과') {
      const lines = b.sellCandidates.length
        ? b.sellCandidates.map((h) => `    - [${h.account}] ${h.name} ${h.qty}주 @${h.curPrice ?? '?'}원 (평가액 ${h.evalAmount?.toLocaleString('ko-KR') ?? '?'}원)`).join('\n')
        : '    (실보유 없음 — 이 방향은 제안하지 말 것)';
      const legacyNote = b.legacyExcludedEval > 0
        ? `\n  ⚠️ 이 초과분 중 ${b.legacyExcludedEval.toLocaleString('ko-KR')}원은 위탁 레거시 개별종목(전량매도 확정, 오너 직접 처리 중) 때문이다 — 매도후보 목록에선 이미 제외했다. 갭 전체(위 "초과" 금액)를 위 매도후보만으로 메우려 하지 마라 — 레거시 종목분을 제외한 나머지 초과분만 대상으로 판단해라.`
        : '';
      return `${header}\n  매도 후보(실보유):\n${lines}${legacyNote}`;
    }
    const ranked = rankedUniverseByClass[b.assetClass];
    const accLines = Object.entries(b.buyCandidatesByAccount).map(([acc, insts]) => {
      if (!insts.length) {
        if (ranked && ranked.length) return `    [${acc}] 현재 보유 없음 — 아래 데이터 기반 순위 중에서만 골라라:\n${formatRankedUniverse(ranked)}`;
        return `    [${acc}] 현재 보유 없음 — 신규 ETF 제안 가능(가격 미확인, 아래 "신규 종목 선정 기준" 참고)`;
      }
      const lines = insts.map((h) => `      - ${h.name}${h.ticker ? `(${h.ticker})` : ''} 현재가 ${h.curPrice ?? '데이터 부족'}원`).join('\n');
      return `    [${acc}]\n${lines}`;
    }).join('\n');
    return `${header}\n  매수 후보(계좌별, 세금상 담을 수 있는 곳만):\n${accLines || '    (담을 수 있는 계좌 없음)'}`;
  }).join('\n\n');

  return `[자동 리밸런싱 제안] 아래 자산군들이 5/25 밴드를 이탈했다(재조회·추정 금지, 이 숫자만 사용).

${sections}

판단 규칙:
- 개별 회사 주식(삼성전자·SK하이닉스 등)은 매수·매도 후보 목록에 섞여 나올 수 있지만
  **절대 제안하지 마라 — 매도 후보로 나온 개별주식도 대상이 아니다.** 위탁 레거시
  개별종목의 전환 시점·방향은 오너 직접 판단 영역이라 이 시스템이 관여하지 않는다.
  후보 중 ETF(펀드형 상품)만 골라라.
- **이탈 금액 전체를 한 번에 채우려 하지 마라.** 이번엔 갭의 절반 정도만 제안하고
  나머지는 다음 기회로 남겨라 — 이 점검은 분기 1회라 다음 기회는 다음 분기다.
- **"달러" 자산군을 채울 때는 미국달러ETF와 엔선물ETF 두 상품에 나눠 담아라**(한쪽에
  몰지 말 것) — 통화 하나에 타이밍 리스크를 몰아주지 않기 위함.
- instrumentName은 후보 목록의 이름을 정확히 그대로 쓸 것(신규 제안일 때만 새 ETF명).
- **이미 보유 중인 종목이 후보에 있으면 그걸 최우선으로 재사용해라** — 새 브랜드를
  또 고르지 마라(같은 계좌·자산군에 매번 다른 ETF를 새로 제안하면 "같은 안건"으로
  인식이 안 돼 승인 대기 목록에 중복으로 쌓인다, 2026-08-29 오너 지적으로 실제로
  발생한 문제).
- **신규 종목 선정 기준(그 계좌에 보유 후보가 전혀 없을 때만)**: "데이터 기반 순위"가
  제시된 자산군은 **반드시 그 목록 안에서만** 골라라 — 스스로 다른 브랜드를 지어내지
  마라(2026-09-06부터 이 목록 밖 이름은 시스템이 자동으로 드롭한다). 순위가 제시되지
  않은 자산군(아직 후보 데이터가 없음)은 기존대로 보수율(총보수)·유동성(거래대금·
  괴리율)·추적오차를 고려해 판단해라. 이후에도 같은 계좌·자산군에 다시 제안할 일이
  생기면, 이번에 고른 이름과 일관되게 유지해라(매번 다른 브랜드를 새로 짓지 말 것).
  단, "달러" 자산군처럼 원래 여러 상품에 나눠 담으라는 지시가 있으면 그 지시가
  우선한다(위 문단 참고).
- side는 그 자산군의 방향과 정확히 일치해야 한다("초과"면 "매도"만, "부족"이면 "매수"만).
- reasoning은 네(아테나) 성격대로 — 왜 이 계좌·종목·타이밍인지 1~2문장, Frank에게
  텔레그램으로 그대로 전달된다.

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{
  "actions": [
    {"assetClass":"국내주식","side":"매도","account":"위탁","instrumentName":"...","amountWon":300000,"reasoning":"..."}
  ],
  "summary": "한줄 요약"
}
\`\`\``;
}

// 순수함수 — LLM 응답 검증(new-cash-allocation.mjs validateAllocations와 동일 철학:
// 드롭이지 throw 아님, 부분 오염이 전체를 막지 않음) + 분할매수 하드 캡.
// rankedUniverseByClass가 있으면(buildRebalanceProposalPrompt와 동일 데이터) "그 계좌에
// 보유 후보가 전혀 없던" 매수 액션의 instrumentName이 그 순위 목록 밖이면 드롭한다
// (2026-09-06 신설 — Athena가 순위 목록을 무시하고 브랜드를 지어내도 물리적으로
// 막히게, §2 "어느 쪽에도 없는 이름은 드롭" 설계). 순위 목록이 아직 없는 자산군(오너가
// 유니버스를 안 채웠거나 계좌에 이미 보유 후보가 있던 경우)은 이 게이트가 적용 안 됨 —
// 기존처럼 자유 이름을 허용(추정 데이터로 막지 않음).
export function validateRebalanceActions(actions, { breachFacts, holdings, rankedUniverseByClass = {} }) {
  const breachByClass = Object.fromEntries(breachFacts.map((b) => [b.assetClass, b]));
  const capBudget = Object.fromEntries(breachFacts.map((b) => [b.assetClass, Math.abs(b.gapWon) * CAP_FRACTION]));
  return applyCappedAllocation(actions, {
    capBudget,
    capLabel: '갭의 50%',
    validateItem: (a) => {
      const assetClass = String(a?.assetClass ?? '').trim();
      const side = String(a?.side ?? '').trim();
      const account = String(a?.account ?? '').trim();
      const instrumentName = String(a?.instrumentName ?? '').trim();
      let amountWon = Number(a?.amountWon);

      const breach = breachByClass[assetClass];
      if (!breach) return { ok: false, reason: `이탈 집합 밖 자산군: ${assetClass}` };
      const expectedSide = breach.direction === '초과' ? '매도' : '매수';
      if (side !== expectedSide) return { ok: false, reason: `방향 불일치(${assetClass}은 "${expectedSide}"만 가능)` };
      if (!IN_SCOPE_ACCOUNTS.includes(account)) return { ok: false, reason: `부적격 계좌: ${account}` };
      if (!instrumentName) return { ok: false, reason: '종목명 없음' };
      if (!Number.isFinite(amountWon) || amountWon <= 0) return { ok: false, reason: '금액 값 이상' };

      if (side === '매수' && !ACCOUNT_ELIGIBLE_ASSET_CLASSES[account]?.includes(assetClass)) {
        return { ok: false, reason: `${account} 계좌가 담을 수 없는 자산군: ${assetClass}` };
      }
      if (side === '매수') {
        const existingCandidates = breach.buyCandidatesByAccount?.[account] ?? [];
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
        if (amountWon > heldEval) amountWon = heldEval; // 보유액 초과 매도 방지
      }

      return { ok: true, key: assetClass, amountWon, normalized: { assetClass, side, account, instrumentName, reasoning: String(a?.reasoning ?? '') } };
    },
  });
}

// 순수함수 — 확정된 action의 실제 보유(가격·수량) 조회해 quantity·proposedPrice 산출.
// new-cash-allocation.mjs resolveInstrumentPricing과 동일 철학(신규 매수 후보는
// quantity/proposedPrice null → order-gate가 "적용 대상 아님"으로 안전 처리).
export function resolveRebalanceInstrumentPricing(action, holdings) {
  return resolveAllocationPricing(holdings, { account: action.account, assetClass: action.assetClass, instrumentName: action.instrumentName, amountWon: action.amountWon });
}

function readLastQuarter() {
  if (!existsSync(STATE_FILE)) return null;
  const fm = parseFrontmatter(readFileSync(STATE_FILE, 'utf8'));
  return fm.quarter ?? null;
}

async function writeLastQuarter(quarter) {
  if (DRY_RUN) return;
  mkdirSync(STATE_DIR, { recursive: true });
  await writeStateFile(STATE_FILE, buildFrontmatter({ type: 'rebalance-proposal-state', quarter, updatedAt: new Date().toISOString() }));
}

function loadExistingProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const content = readFileSync(join(dir, f), 'utf8');
    return { filename: f, content, ...parseProposal(content) };
  });
}

// 발송 라인이 전부 성공(created)이어야 지문을 갱신한다 — new-cash-allocation.mjs
// allAllocationsSent와 동일 원칙(부분 실패는 다음 실행 재시도).
export function allActionsSent(sendResults) {
  return sendResults.length > 0 && sendResults.every((r) => r.action === 'created');
}

async function main() {
  const now = new Date();
  const lastQuarter = readLastQuarter();
  if (!FORCE && !shouldRunToday(now, lastQuarter)) {
    console.log('ℹ️ 오늘은 분기 점검 대상 아님(이번 분기 이미 실행됐거나 평일/분기시작월 아님) — 건너뜀');
    return;
  }

  loadEnv();
  const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  console.log('⚖️  rebalance-proposal — 5/25 밴드 이탈 분기 리밸런싱 제안 점검');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const proposalsBlocked = isProposalBlocked(existsSync(VAULT_PATHS.state.proposalMode) ? readFileSync(VAULT_PATHS.state.proposalMode, 'utf8') : null);
  if (proposalsBlocked) {
    console.log('  🚫 제안금지 모드 — 점검 자체를 건너뜀("제안요청"으로 해제 전까지, 분기 마커도 안 건드림)');
    return;
  }

  const holdings = readMdDir(VAULT_PATHS.state.holdings);
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);

  if (!breachFacts.length) {
    console.log('  ✅ 이탈 없음 — 이번 분기 리밸런싱 불필요, 조용히 종료');
    await writeLastQuarter(getQuarterLabel(now));
    return;
  }

  console.log(`  이탈 자산군 ${breachFacts.length}개: ${breachFacts.map((b) => `${b.assetClass}(${b.direction})`).join(', ')}`);

  // "그 계좌에 보유 후보가 전혀 없는" 부족 자산군만 순위 계산(불필요한 KRX 조회 방지) —
  // 자산군별로 한 번만(계좌가 여러 개라도 순위는 자산군 단위로 공유). ASSET_CLASS_ETF_
  // UNIVERSE가 비어있으면(오너 미확인) rankAssetClassUniverse가 즉시 빈 배열 반환(네트워크
  // 호출 없음) — §2, 2026-09-06 신설.
  const rankedUniverseByClass = {};
  for (const b of breachFacts) {
    if (b.direction !== '부족') continue;
    const hasEmptyAccount = Object.values(b.buyCandidatesByAccount).some((insts) => !insts.length);
    if (!hasEmptyAccount) continue;
    const ranked = await rankAssetClassUniverse(b.assetClass);
    if (ranked.length) rankedUniverseByClass[b.assetClass] = ranked;
  }

  const prompt = buildRebalanceProposalPrompt(breachFacts, rankedUniverseByClass);
  if (DRY_RUN) { console.log(`\n┌─── 프롬프트 ───┐\n${prompt}\n└──────────────────┘`); return; }

  let actions;
  try {
    const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));
    const { kept, dropped } = validateRebalanceActions(r.actions, { breachFacts, holdings, rankedUniverseByClass });
    dropped.forEach((d) => console.log(`  ⚠️ 액션 드롭: ${d.reason}`));
    actions = kept;
  } catch (e) {
    if (e.isLimit) { console.log('  ⏳ 사용량 한도 → 판단 보류(다음 실행 재시도).'); return; }
    console.error(`  ❌ 리밸런싱 판단 실패: ${e.message} — 다음 실행 재시도`);
    return;
  }
  if (!actions.length) { console.log('  ⚠️ 유효한 액션 없음 — 다음 실행 재시도'); return; }

  let existingProposals = loadExistingProposals(VAULT_PATHS.decisions.proposals);
  const sendResults = [];
  for (const action of actions) {
    const pricing = resolveRebalanceInstrumentPricing(action, holdings);
    try {
      const result = await createAndSendProposal({
        track: '자산분배', account: action.account, assetKey: pricing.assetKey, name: action.instrumentName,
        side: action.side, quantity: pricing.quantity, proposedPrice: pricing.proposedPrice,
        amountWon: action.amountWon,
        reason: action.reasoning, departmentLabel: DEPARTMENT_LABEL,
        existingProposals,
        writeProposalFile: (filename, content) => writeStateFile(join(VAULT_PATHS.decisions.proposals, filename), content),
        sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r),
      });
      if (result.action === 'blocked') {
        console.log(`  ⛔ ${action.instrumentName} 제안 차단: ${result.reason}`);
        sendResults.push({ action: 'blocked' });
        continue;
      }
      console.log(`  ✅ 제안 발송: [${action.account}] ${action.side} ${action.instrumentName} ${action.amountWon.toLocaleString('ko-KR')}원`);
      existingProposals.push({ filename: result.filename, ...parseProposal(readFileSync(join(VAULT_PATHS.decisions.proposals, result.filename), 'utf8')) });
      sendResults.push({ action: 'created' });
    } catch (e) {
      console.error(`  ❌ ${action.instrumentName} 제안 발송 실패: ${e.message}`);
      sendResults.push({ action: 'failed' });
    }
  }

  if (allActionsSent(sendResults)) {
    await writeLastQuarter(getQuarterLabel(now));
    console.log('  🔄 분기 마커 갱신 — 이번 분기는 완료(잔여 갭은 다음 분기에 새로 이어서 제안)');
  } else {
    console.log('  ⚠️ 일부 미발송(차단·실패) — 분기 마커 미갱신(다음 평일 재시도)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ rebalance-proposal 오류:', e.message); process.exit(1); });
}
