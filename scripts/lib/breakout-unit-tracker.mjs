// 돌파매매 전략 — 점진적 배팅(유닛) 사이징 (2026-09-14, 오너 지시로 유튜브
// "깡토의 추세추종" 채널 영상(https://youtu.be/cQCu62gMAPs, "진입시점·매수비중·
// 손절기준 총정리") 학습 후 신설. Whisper 음성전사로 확인).
//
// ⚠️ 용어 충돌 주의 — breakout-risk.mjs의 shouldPyramid()/position.units는 "같은
// 포지션에 불타기(추가매수)"를 가리키는 완전히 다른 개념이다. 영상은 이 둘을 명시적으로
// 구분한다("유닛이라는 건 분할 매수와는 다른 개념인 겁니다") — 이 파일이 다루는
// "유닛"은 "신규로 진입하는(기존과 다른) 종목의 최초 투입금을, 계좌 전체의 최근
// 승패 실적에 따라 조절"하는 개념이다. 혼동 방지를 위해 이 파일 전역에서
// "bettingUnit"이라는 이름을 쓴다 — 코드상 position.units(불타기 카운트)와는
// 절대 같은 걸 가리키지 않는다.
//
// 핵심 로직(영상 그대로, 오너 확정 2026-09-14 — 1단계는 종목유닛만, 장세판단
// (시장레짐) 유닛은 영상도 별개 개념으로 다뤄 이번 범위에서 제외):
// - Max2%룰로 계산되는 종목당 최대투입금(computePositionSize, breakout-risk.mjs)을
//   TOTAL_BETTING_UNITS(오너 확정: 5)개로 등분한다 — 1유닛 = 최대투입금 × 20%.
// - 모든 신규 진입(=기존 보유와 다른 종목의 최초 매수)은 계좌 전체의 누적 유닛
//   카운터를 그대로 물려받는다. 첫 거래는 1유닛(MIN_BETTING_UNITS)에서 시작.
// - 어떤 포지션이든 처음 3R(+24%)에 도달("성공")하면 카운터 +1(상한
//   TOTAL_BETTING_UNITS). -8% 손절로 청산("실패")되면 카운터 -1(하한
//   MIN_BETTING_UNITS). 4연속 성공해야 풀유닛(5유닛).
// - 이 카운터는 특정 종목이 아니라 계좌 전체에 걸쳐 순차 누적된다(영상 예시: A·B가
//   이미 3R 달성해 카운터가 3인 상태에서 C를 사면 C도 3유닛으로 시작).
//
// ⚠️ 영상에 명시되지 않아 이 구현이 채택한 가정(실거래 배선 전 재확인 권장):
// 1. 하한을 1로 둠(0 이하는 "베팅 안 함"이 되어 전략 자체가 무의미해지므로 안전한
//    기본값으로 채택 — 영상은 하한을 언급하지 않음).
// 2. "3R 도달"과 "-8% 손절"을 성공/실패 판정 기준으로 그대로 씀(breakout-risk.mjs의
//    PARTIAL_PROFIT_TRIGGER_R·STOP_LOSS_PCT와 동일 트리거 재사용, 영상이 예시로 든
//    바로 그 숫자).
// 3. 트레일링스탑이 3R 도달 전 단계(1R·2R)에서 상향된 뒤 그 손절선에 걸려 청산되는
//    경우(즉 아직 "성공" 크레딧을 못 받았지만 원금 손실은 -8%보다 작은 경우)도
//    "실패"로 취급한다 — 영상은 이런 중간 케이스를 다루지 않았으나, "3R 성공 전에
//    청산됐다"는 사실 자체가 영상이 말한 "실패"의 본질(그 종목에서 기대한 성공을
//    못 거뒀다)에 더 부합한다고 판단.
// 4. 같은 날 손절선과 3R가를 동시에 터치한 경우(일봉만으론 일중 순서 불명)는 "실패"로
//    차감하지 않는다(그렇다고 "성공"으로 가산하지도 않음 — 그냥 미판정) — 실전에서는
//    breakout-protection.mjs가 손절·3R익절 두 조건부 주문을 동시에 걸어두므로, 이런
//    날은 3R 지정가가 손절보다 먼저 체결됐을 가능성이 실제로 있다(2026-09-14 코드리뷰
//    지적, breakout-simulator.mjs의 exit 분기 참고).
//
// 순수함수 — 실제 상태(현재 유닛 수) 영속은 호출측(백테스트 시뮬레이터/Kairos
// 실계좌 State 파일)이 들고 있는다(이 프로젝트 전반의 관례, breakout-risk.mjs와
// 동일 원칙).

import { computePositionSize } from './breakout-risk.mjs';

export const TOTAL_BETTING_UNITS = 5; // 오너 확정, 2026-09-14 — 영상 예시와 동일
export const MIN_BETTING_UNITS = 1;
export const BETTING_UNIT_SUCCESS_R = 3; // 3R(+24%) 최초 도달 = "성공" — breakout-risk.mjs PARTIAL_PROFIT_TRIGGER_R과 동일 트리거 재사용

// 승패 1건을 카운터에 반영 — outcome: 'success'(3R 최초 도달) | 'failure'(3R 도달 전
// 손절 청산). 상한/하한 래칫(절대 범위 밖으로 안 나감).
//
// ⚠️ 이 함수를 "이벤트 여러 건에 순차 적용"하면 적용 순서에 결과가 좌우된다(래칫이
// 중간값을 버리므로) — 같은 날 여러 포지션이 동시에 청산되는 백테스트 상황에서는
// 이 함수를 이벤트마다 부르지 말고, 순변화(성공건수-실패건수)를 먼저 다 더한 뒤
// 한 번만 클램프해야 순서 무관하게 결과가 같다(breakout-simulator.mjs의
// runBreakoutBacktest가 실제로 이렇게 한다 — 2026-09-14 코드리뷰 지적, 순서의존
// 버그 발견 후 배치 적용으로 수정). 실계좌(Kairos)처럼 이벤트가 실시간으로 하나씩
// 일어나는 라이브 상황에서는 이 함수를 그대로 이벤트마다 호출하면 된다(문제 없음
// — 순서 자체가 실제로 일어난 순서이므로).
export function nextBettingUnits(currentUnits, outcome) {
  if (!Number.isInteger(currentUnits)) throw new Error(`nextBettingUnits: currentUnits는 정수여야 함, 받은 값: ${currentUnits}`);
  if (outcome === 'success') return Math.min(currentUnits + 1, TOTAL_BETTING_UNITS);
  if (outcome === 'failure') return Math.max(currentUnits - 1, MIN_BETTING_UNITS);
  throw new Error(`nextBettingUnits: 알 수 없는 outcome "${outcome}" (success|failure만 허용)`);
}

// 현재 유닛 수 기준 신규 진입 투입금 = Max2%룰 최대한도(computePositionSize) ×
// (currentUnits/TOTAL_BETTING_UNITS). currentUnits가 범위(1~TOTAL) 밖이면(호출측
// 실수 등) 안전하게 클램프하되, 정수가 아니거나 NaN이면 조용히 통과시키지 않고
// throw한다(2026-09-14 코드리뷰 지적 — 클램프만으로는 NaN이 그대로 새어나가
// "이후 모든 진입이 조용히 스킵"되는, 이 프로젝트가 금지하는 조용한 폴백 패턴이 됨).
export function computeBettingUnitInvestment(capitalWon, currentUnits, opts = {}) {
  if (!Number.isInteger(currentUnits)) throw new Error(`computeBettingUnitInvestment: currentUnits는 정수여야 함, 받은 값: ${currentUnits}`);
  const ceiling = computePositionSize(capitalWon, opts);
  const clampedUnits = Math.max(MIN_BETTING_UNITS, Math.min(currentUnits, TOTAL_BETTING_UNITS));
  return ceiling * (clampedUnits / TOTAL_BETTING_UNITS);
}
