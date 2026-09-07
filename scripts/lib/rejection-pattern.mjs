// 자산분배 트랙 연속 거부 패턴 감지 — 2026-09-07 신설(오너 지시: "내가 흔들리지
// 않고 최소한의 개입으로 자산분배 전략을 수행할 수 있도록... 이걸 잘 지키게 하는 게
// 너의 몫이야"). 코드가 갭·밴드를 기계적으로 계산해도, 오너가 실제로 제안을 반복
// 거부하면(예: 하락한 자산군을 더 사라는 제안이 불안해서) 전략 자체가 조용히 무력화될
// 수 있다 — 이건 구조(코드) 문제가 아니라 행동 패턴이라 시스템이 "감지해서 되짚어
// 주는" 것 말고는 강제할 방법이 없다(feedback-zeus-decision-scope: 오너에게 완전
// 이양+거부권이 있는 영역 — 이 모듈은 거부를 막지 않는다, 알아차리게만 한다).
//
// "연속"(rolling window 대신) 정의를 쓰는 이유 — 오래전 흩어진 거부 몇 건보다,
// "최근 결정들이 전부 거부"인 상태가 진짜 "지금 흔들리고 있다"는 신호에 더 가깝다.
// 승인이 한 번이라도 섞이면 스트릭이 끊긴다(그 시점부터 다시 정상 궤도로 본다).

// proposals: parseProposal()로 이미 파싱된 배열. track 하나로 스코프(기본 '자산분배'
// — 퀀트 트랙은 오너 승인/거부가 없는 자동체결이라 이 패턴 자체가 적용 안 됨).
// 결정(승인·거부)된 것만 decidedAt 내림차순으로 보고, 맨 앞부터 '거부'가 연속되는
// 개수를 센다 — '승인'을 만나면 그 즉시 멈춘다(그 이전 거부는 이미 "지나간 흔들림").
export function detectRejectionStreak(proposals, { track = '자산분배' } = {}) {
  const decided = (proposals ?? [])
    .filter((p) => p.track === track && p.decidedAt && (p.status === '승인' || p.status === '거부'))
    .sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime());

  let streak = 0;
  for (const p of decided) {
    if (p.status !== '거부') break;
    streak++;
  }
  return streak;
}

// streak가 threshold의 배수일 때만 알림(3,6,9... — 매 거부마다 알리면 naggy, 그렇다고
// 딱 한 번만 알리면 계속 흔들리는데 이후엔 조용해짐 — 둘 다 피한다).
export function shouldNudgeRejectionStreak(streak, threshold = 3) {
  return streak > 0 && threshold > 0 && streak % threshold === 0;
}

// 순수함수 — 오너 자신이 확정한 원칙을 되짚어주는 문구(설득이 아니라 "본인이 세운
// 기준을 다시 보여주기" — 판단은 여전히 오너 몫, 거부권을 막지 않는다). 데이터
// (거부 횟수)는 사실로, 원칙 재확인은 질문형으로 — 강요하지 않는다.
export function buildRejectionStreakNudge(streak) {
  return `최근 자산분배 트랙 제안을 ${streak}회 연속 거부하셨습니다.\n\n`
    + `자산분배 시스템은 "하락한 자산군을 매수해 목표비중을 지킨다"는 원칙으로 설계돼 `
    + `있습니다 — 이 원칙 자체를 다시 검토하고 싶으신 거라면 그것도 정상적인 판단입니다. `
    + `다만 일시적인 불안 때문에 계속 거부하고 계신 거라면, 원래 계획대로 진행하시는 걸 `
    + `권해드립니다. 어느 쪽이든 답장 한 줄이면 충분합니다 — "전략 재검토"라고 답장해주시면 `
    + `그 다음 대화에서 처음부터 다시 짚어보겠습니다.`;
}
