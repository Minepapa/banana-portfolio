// 돌파매매 전략 — 트레일링스탑 재계산 판정(2026-09-13). KIS 스톱지정가(ORD_DVSN=22)는
// 고정된 조건가 1개일 뿐 자동으로 안 올라간다(Knowledge/API/KIS.md 참고) — 주가가
// 올라 새 R단계를 찍을 때마다 우리 시스템이 기존 손절주문을 "정정"(reviseKrOrder,
// scripts/lib/kis.mjs)해 조건가를 올려야 진짜 트레일링이 된다. 이 파일은 그 판정만
// 하는 순수함수(주문 정정 자체는 호출측 잡이 reviseKrOrder로 실행).
import { computeTrailingStop, STOP_LOSS_PCT } from './breakout-risk.mjs';

// position: breakout-position-vault.mjs가 만든 레코드(parseBreakoutPosition 결과) —
// entryPrice·highSinceEntry·stopPrice(·stopLossPct, 2026-09-19 ATR 가변손절 실전배선)
// 필요. latestHigh: 오늘까지 확인된 최신 고가(당일 장중 고가 또는 전일 일봉 고가 —
// 호출측이 어느 걸 쓸지 결정).
//
// ⚠️ position.stopLossPct 사용(코드리뷰 MEDIUM 지적 — breakout-position-vault.mjs가
// "트레일링스탑이 원래 확정값을 그대로 다시 쓸 수 있어야 한다"는 이유로 이 필드를
// 저장하는데, 정작 이 함수가 안 쓰고 있었다). 없으면(과거 레코드 등) 기존 고정값.
// 4% 포지션에 8% 기준 R단계를 잘못 적용하면 트레일링이 한 단계 덜 조여진다(실제
// 손절가가 나가지는 않음 — computeTrailingRevision의 `newStopPrice > stopPrice`
// 가드가 더 느슨한 값을 걸러내므로 안전한 방향으로 실패하지만, 트레일링 자체가
// 무력화됨).
//
// 반환: 갱신 불필요면 null. 갱신 필요하면 { newHighSinceEntry, newStopPrice } — 손절선은
// 오직 위로만 래칫(computeTrailingStop 자체가 이미 이 성질을 가짐 — reachedRMultiple이
// highSinceEntry 기준 단조증가). 같은 값이면(진전 없음) 갱신 안 함(불필요한 정정 API
// 호출·수수료성 이벤트 방지).
export function computeTrailingRevision(position, latestHigh) {
  const newHighSinceEntry = Math.max(position.highSinceEntry, latestHigh);
  const newStopPrice = computeTrailingStop(position.entryPrice, newHighSinceEntry, position.stopLossPct ?? STOP_LOSS_PCT);
  if (!(newStopPrice > position.stopPrice)) return null;
  return { newHighSinceEntry, newStopPrice };
}
