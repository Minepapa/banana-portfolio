// 예수금(현금) 원장 — 계좌별 실제 잔고를 정밀 타임스탬프 기준점+델타로 계산.
// v1 cash-base.mjs(resolveCashBase)의 후속 — v1은 기준점·거래를 **날짜(yyyy-MM-dd)만**
// 비교해서, 기준점이 잡힌 "그날 안에" 일어난 다른 거래가 델타 계산에서 통째로 빠지는
// 버그가 있었다(2026-08-18 오너 지적으로 재조사 — v1 parse-notifications.mjs
// `flows.filter(fl => fl.date > baseDate)`가 fl.date·baseDate 둘 다 날짜만 남기고
// 시각을 버려서, NH 입출금 알림이 오전에 왔는데 같은 날 오후에 배당·매도가 생기면
// 그 거래가 델타에서 빠졌다 — "분명 업데이트됐는데 기준점 값으로 돌아온다"는 증상의
// 정체. v1에서 "안 급하다"고 미뤄뒀던 문제, v2 이식 시점에 근본 수정).
//
// v2는 Facts/Ledger 전 종류(체결·배당·실현손익·예수금알림)가 초 단위 정밀
// 타임스탬프를 갖고 있어(normalizeDateTime 확인됨), 날짜 대신 **전체 타임스탬프**로
// 비교하면 이 버그 자체가 구조적으로 생길 수 없다.
//
// ⚠️ 설계 통합(2026-08-18) — 처음엔 NH 4계좌(위탁·ISA·금현물·CMA, 자동 입출금
// 알림 있음)와 연금저축(알림 없음, 0원-이후-복식부기)을 별도 함수로 나눴었다.
// 그런데 오너가 IRP(한국투자증권, 알림 없음·매월 26일 고정 25만원 자동입금)까지
// "모든 계좌 동일하게" 관리하길 원했고, 연금저축도 실은 잔고 조회가 가능함이
// 드러났다(MMF 보유 평가금액이 곧 예수금 — 배당·수익금이 자동으로 MMF에 쌓이고
// 매수 시 MMF를 먼저 매도하는 구조). 즉 "자동 알림 유무"가 아니라 "기준점을 어떻게
// 얻는가"만 다를 뿐, 델타 계산(체결·배당 흐름 합산)은 6계좌 전부 동일해야 맞다 —
// resolvePensionCashLedger(0원 영구기준 복식부기)는 삭제했다. 알림이 없는 계좌는
// 오너가 앱에서 직접 확인한 값을 수동 CashEvent로 기록해 기준점 삼는다(자동 알림과
// 완전히 같은 레코드 모양 — Facts/Ledger/CashEvents는 이제 "자동 알림"과 "수동
// 스냅샷"을 구분하지 않고 그냥 "이 시각에 이 계좌 잔고가 이 값이었다"는 사실만 담는
// 폴더다). resolveCashAnchor는 그래서 더 이상 NH 전용이 아니다 — 모든 계좌에 그대로
// 쓴다(이름에서 "Nh" 제거).

// anchorTs 이후(엄격히 이후, 같은 시각은 이미 그 잔고에 반영된 것으로 간주)에 발생한
// flow만 델타에 포함한다 — 위 v1 버그를 막는 핵심. flow: { ts: 'YYYY-MM-DD HH:mm:ss',
// amount: number(+입금성/-출금성) }.
export function computeCashDelta({ anchorTs, flows }) {
  return (flows ?? [])
    .filter((f) => f?.ts && anchorTs && f.ts > anchorTs)
    .reduce((s, f) => s + (f.amount ?? 0), 0);
}

// 예수금 정산 — base+delta, 0 클램프(미수·마진 미지원이라 음수 잔고는 있을 수 없음).
// raw는 클램프 전 값을 보존해 음수였다는 사실(경고 트리거)을 잃지 않는다.
export function settleCash(base, delta) {
  const raw = (base ?? 0) + (delta ?? 0);
  return { cash: Math.max(0, raw), raw, negative: raw < 0 };
}

// 계좌 기준점 결정 — 항상 "가장 최근 CashEvent"를 신뢰한다(자동 알림·수동 스냅샷
// 구분 없이 시각 기준 최신 것이 이긴다 — 2026-08-18 설계통합, 위 헤더 주석 참고).
// CashEvent가 아직 하나도 없으면(이 기능 최초 실행 등) 기존 저장값(마이그레이션
// 스냅샷 등)을 임시 기준으로 유지 — source:'이관'으로 표시해 첫 실제 기록이 오면
// 반드시 대체되게 한다. latestEvent: { balance, ts } | null. stored: { base, baseTs,
// source } | null.
export function resolveCashAnchor({ stored, latestEvent }) {
  if (latestEvent) {
    return { base: latestEvent.balance, baseTs: latestEvent.ts, source: '자동' };
  }
  if (stored && Number.isFinite(stored.base)) {
    return { base: stored.base, baseTs: stored.baseTs ?? '', source: stored.source || '이관' };
  }
  return { base: null, baseTs: '', source: null };
}

// 위탁이 신규현금배분(new-cash-allocation.mjs) 등에서 실제로 "쓸 수 있는" 현금 —
// 위탁 자체 잔고 + 금현물 잔고를 합산한다(오너 확정, 2026-08-18: "금현물 계좌의
// 현금(아직 금을 안 사고 대기 중인 돈)은 위탁과 합쳐서 같이 취급"). 각 계좌의 실제
// 잔고(State/Holdings/{계좌}-예수금.md)는 그대로 따로 저장·감사되고, 이 함수는 그
// 위에서 "합산해서 보는 관점"만 별도로 제공한다 — 물리적으로 두 계좌를 하나로
// 합치는 게 아니라 정책적 관점 하나를 계산해줄 뿐이다(nh-accounts.mjs 헤더 주석의
// "cash-ledger.mjs의 합산 로직"이 가리키는 지점).
export function resolveDesignatedCashBalance({ wtCash, goldCash }) {
  return (wtCash ?? 0) + (goldCash ?? 0);
}
