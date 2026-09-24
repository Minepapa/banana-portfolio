// 검문소 — docs/ARCHITECTURE-V2.md "안전장치 계층" 절. 전부 순수 함수(Node 결정론,
// LLM 판단이 끼어들 자리가 없다 — "Node가 결정론적으로 계산·집행, LLM은 해석·판단만"
// 원칙의 실행 단계 구현). 어떤 부서·오너 승인도 이 검문소를 우회하지 못한다.
//
// 두 시점으로 나뉜다:
//   1) 제안 생성 시점 — resolveProposalIntake (단일 활성 제안 원칙·거부 재상정 쿨다운)
//   2) 실행(브로커 호출 직전) 시점 — runExecutionGateChecks (나머지 5종 + 킬스위치)
// 설계서의 "검문소 항목" 표는 이 둘을 한 절에 같이 서술하지만, 실제로 개입하는 파이프라인
// 단계가 다르므로 여기서는 함수를 분리했다(각각 다른 입력을 받는다).

import { findActiveProposal, findRecentRejection, proposalMatchKey } from './proposal-vault.mjs';
import { isKillSwitchActive } from './kill-switch.mjs';
import { readKrxTradingDayStatus } from './krx-trading-calendar.mjs';

const REJECTION_COOLDOWN_MS_DEFAULT = 24 * 60 * 60 * 1000; // 24시간 — 오너 확정(2026-08-29, 자산분배 트랙 감사). "최소 하루는 재상정 안 함"이 최종 운용값.

// ── 1) 제안 생성 시점 ──────────────────────────────────────────────
// existingProposals: proposal-vault.parseProposal()로 파싱된 객체 배열(호출부가 이미
// Decisions/Proposals를 읽어 넘긴다 — 이 모듈은 fs를 만지지 않는다).
// conditionsChanged: 호출부(부서 로직, Phase 8·9)가 "조건이 의미있게 바뀌었다"고
// 명시적으로 판단했을 때만 true로 넘긴다 — 이 판단 자체는 LLM/부서의 몫이지 여기서
// 추정하지 않는다(추정 금지 원칙, ADR 0003과 동일 정신).
export function resolveProposalIntake({ track, assetKey, side, existingProposals, conditionsChanged = false, rejectionCooldownMs = REJECTION_COOLDOWN_MS_DEFAULT, now = new Date() }) {
  const recentRejection = findRecentRejection(existingProposals, { track, assetKey, side, withinMs: rejectionCooldownMs, now });
  if (recentRejection && !conditionsChanged) {
    return { action: 'blocked', reason: `거부 재상정 쿨다운 — ${recentRejection.decidedAt}에 거부된 안건, 조건 변화 없이는 재상정 불가` };
  }

  const active = findActiveProposal(existingProposals, { track, assetKey, side });
  if (active) {
    return { action: 'supersede', supersedeId: active.id, reason: '같은 안건의 활성(대기/승인) 제안을 최신 정보로 교체' };
  }

  return { action: 'create' };
}

// ── 2) 실행(브로커 호출 직전) 시점 — 6종, 전부 통과해야 실행 ──────────

// proposedPrice가 없는 제안(예: 정액 리밸런싱)은 이 체크를 건너뛴다(적용 대상 아님) —
// null을 "통과"로 처리하되 이유를 명시해 조용히 넘어가지 않게 한다.
export function checkPriceDeviation({ proposedPrice, currentPrice, maxDeviationPct = 1 }) {
  if (proposedPrice == null) return { pass: true, reason: '가격 기준 없는 제안(적용 대상 아님)' };
  if (currentPrice == null || !Number.isFinite(currentPrice)) return { pass: false, reason: '현재가 조회 실패' };
  const deviationPct = Math.abs(currentPrice - proposedPrice) / proposedPrice * 100;
  if (deviationPct > maxDeviationPct) {
    return { pass: false, reason: `가격이탈 ${deviationPct.toFixed(2)}% (제안가 ${proposedPrice} → 현재가 ${currentPrice}, 허용 ±${maxDeviationPct}%)` };
  }
  return { pass: true, reason: `가격이탈 ${deviationPct.toFixed(2)}% (허용범위 내)` };
}

export function checkHoldingsConsistency({ side, quantity, currentHoldingQty = 0, availableCash = 0, orderCost = 0 }) {
  if (side === '매도') {
    if (quantity > currentHoldingQty) {
      return { pass: false, reason: `매도수량(${quantity})이 보유수량(${currentHoldingQty})을 초과` };
    }
    return { pass: true, reason: '보유수량 충분' };
  }
  if (side === '매수') {
    if (orderCost > availableCash) {
      return { pass: false, reason: `매수금액(${orderCost})이 가용예수금(${availableCash})을 초과` };
    }
    return { pass: true, reason: '예수금 충분' };
  }
  return { pass: false, reason: `알 수 없는 side: ${side}` };
}

export function checkIdempotency({ proposalId, alreadyExecutedIds = [] }) {
  if (alreadyExecutedIds.includes(proposalId)) {
    return { pass: false, reason: `제안 ${proposalId}은 이미 체결 처리됨(재시도/재승인 차단)` };
  }
  return { pass: true, reason: '최초 체결 시도' };
}

// reply_to 없이 애매하게 "승인"만 오면 추정하지 않고 재확인 요청(ADR 0003 폴백 금지
// 원칙) — replyTo가 정확히 expectedProposalId와 일치할 때만 통과.
export function checkApprovalMatch({ replyTo, expectedProposalId }) {
  if (!replyTo) {
    return { pass: false, reason: 'reply_to 없음 — 어느 제안에 대한 승인인지 추정하지 않고 재확인 요청' };
  }
  if (replyTo !== expectedProposalId) {
    return { pass: false, reason: `reply_to(${replyTo})가 이 제안 ID(${expectedProposalId})와 불일치` };
  }
  return { pass: true, reason: '제안-승인 일치' };
}

// 시장별 타임존·개장시간 — KR(09:00-15:30 KST)은 원래부터 있던 값. US(09:30-16:00
// America/New_York)는 2026-09-06 asset-allocation 자동체결 코드리뷰 HIGH 지적으로
// 추가(해외주식 제안이 market 기본값 'KR'로만 게이트돼, KR 장중(KST 09:00-15:30 =
// 미국장은 닫혀있는 시간대)에만 통과하고 실제 미국장 시간엔 오히려 차단되는 거꾸로
// 된 게이트였다 — 이 프로젝트 다른 곳의 KST/NY 구분(scripts/lib/kis.mjs의
// isKrMarketOpen/isUsMarketOpen)과 같은 시간대 값을 쓰되, order-gate.mjs는 브로커
// 무관 순수 모듈 원칙을 지키기 위해 kis.mjs를 import하지 않고 동일 로직을 그대로 둔다.
const MARKET_SESSIONS = {
  KR: { timeZone: 'Asia/Seoul', label: 'KST', openHHMM: 900, closeHHMM: 1530 },
  US: { timeZone: 'America/New_York', label: 'NY', openHHMM: 930, closeHHMM: 1600 },
};

// KRX 공휴일은 updater가 매일 기록한 KIS 캐시로 판정한다. 오늘자 값이 없으면
// fail-closed — 달력 API 장애/잡 누락을 거래일로 추정하지 않는다. 테스트·명시적
// 호출자는 krxTradingDayStatus를 주입할 수 있고 운영 호출부는 캐시를 읽는다.
export function checkMarketOpen({ now = new Date(), market = 'KR', krxTradingDayStatus } = {}) {
  const session = MARKET_SESSIONS[market];
  if (!session) return { pass: false, reason: `지원 안 하는 시장: ${market}` };
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: session.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday').value;
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  const hhmm = hour * 100 + minute;
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  const inSession = hhmm >= session.openHHMM && hhmm <= session.closeHHMM;
  if (!isWeekday) return { pass: false, reason: `주말(${weekday}) — 장 마감. 다음 개장까지 보류` };
  if (market === 'KR') {
    const tradingDay = krxTradingDayStatus ?? readKrxTradingDayStatus(now);
    if (tradingDay.isOpen !== true) {
      const detail = tradingDay.isOpen === false ? 'KRX 휴장일' : (tradingDay.reason || '당일 KRX 거래일 확인 불가');
      return { pass: false, reason: `${detail}(${tradingDay.date}) — 주문 보류` };
    }
  }
  if (!inSession) return { pass: false, reason: `장중 시간 아님(${session.label} ${hour}:${String(minute).padStart(2, '0')}) — 다음 개장까지 보류` };
  return { pass: true, reason: '장중(당일 KRX 개장 확인 완료)' };
}

// 승인의 당일 유효기간 — 오너 확정(2026-08-13): "승인"은 승인한 그날(KST 달력일)에만
// 유효하다. 가격이탈 등으로 계속 막힌 채 날짜가 넘어가면, 승인 시점의 판단(그날 가격·
// 상황 기준)이 이미 낡았을 수 있어 시스템이 다음날·다음주까지 조용히 재시도하지 않는다
// — 지정가 "당일유효" 주문 관례와 동일 원칙. runExecutionGateChecks의 일부가 아니다
// (그쪽은 "지금 이 시도가 통과하나"만 보고 상태를 안 바꾼다) — 이 함수는 "이 승인 자체가
// 아직 유효한가"를 별도로 판정하고, 호출부(execute-quant-proposal.mjs)가 true면 상태를
// "거부"로 전환해 재승인을 요구한다.
export function isApprovalStale({ decidedAt, now = new Date() }) {
  if (!decidedAt) return false;
  const kstDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
  return kstDate(new Date(decidedAt)) !== kstDate(now);
}

export function checkKillSwitch({ killSwitchContent }) {
  if (isKillSwitchActive(killSwitchContent)) {
    return { pass: false, reason: '킬스위치 활성 — 오너의 "정지" 명령으로 모든 자동 실행 중단됨' };
  }
  return { pass: true, reason: '킬스위치 비활성' };
}

// 전부 통과해야 실행 — 하나라도 실패하면 즉시 차단하고 실패 사유를 전부 모아 반환한다
// (부분 정보로 판단하지 않도록 모든 체크를 다 돌린다 — 하나 실패했다고 나머지를
// 건너뛰면 "그 다음엔 뭐가 더 막혔는지" 재확인을 위해 다시 돌려야 하는 낭비가 생긴다).
export function runExecutionGateChecks(input) {
  const checks = {
    priceDeviation: checkPriceDeviation(input),
    holdingsConsistency: checkHoldingsConsistency(input),
    idempotency: checkIdempotency(input),
    approvalMatch: checkApprovalMatch(input),
    marketOpen: checkMarketOpen(input),
    killSwitch: checkKillSwitch(input),
  };
  const failures = Object.entries(checks)
    .filter(([, r]) => !r.pass)
    .map(([name, r]) => ({ check: name, reason: r.reason }));
  return { pass: failures.length === 0, failures, checks };
}

export { proposalMatchKey };
