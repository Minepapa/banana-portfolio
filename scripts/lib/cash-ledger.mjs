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
// 위탁·ISA·금현물·CMA는 전부 NH라 실제 입출금 알림(앵커)이 항상 존재 —
// resolveNhCashAnchor를 쓴다. 연금저축은 카카오로 입출금 알림 자체가 안 온다(오너
// 확인, 2026-08-17 — 연 1회 연봉 연동 고정액 자동납입뿐이라 이벤트 알림이 없음) —
// 실제 잔고와 대조할 방법이 없으므로 resolvePensionCashLedger로 별도 처리한다
// (마이그레이션 시점 0원 기준 + 그 이후 배당·매도(+)·매수(−) 전액 델타, 복식부기).

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

// NH 계좌(위탁·ISA·금현물·CMA) 기준점 결정 — 항상 "가장 최근 알림"을 신뢰한다(4계좌
// 전부 실제 알림이 오므로 v1처럼 수동 기준으로 폴백할 필요가 원천적으로 없음). 알림이
// 아직 한 번도 없었으면(이 기능 최초 실행 등) 기존 저장값(마이그레이션 스냅샷 등)을
// 임시 기준으로 유지 — source:'이관'으로 표시해 첫 실제 알림이 오면 반드시 대체되게 한다.
// latestAlarm: { balance, ts } | null. stored: { base, baseTs, source } | null.
export function resolveNhCashAnchor({ stored, latestAlarm }) {
  if (latestAlarm) {
    return { base: latestAlarm.balance, baseTs: latestAlarm.ts, source: '자동' };
  }
  if (stored && Number.isFinite(stored.base)) {
    return { base: stored.base, baseTs: stored.baseTs ?? '', source: stored.source || '이관' };
  }
  return { base: null, baseTs: '', source: null };
}

// 연금저축 원장 — 실제 잔고 대조 수단이 없어(알림 없음) 마이그레이션 시점(0원)을
// 영구 기준점으로 삼고, 그 이후의 모든 배당·매도(+)·매수(−) 이벤트를 전액 반영한다
// (복식부기 — 2026-08-16 사고는 입금만 세고 출금을 안 뺀 게 원인이었으므로 반드시
// 양방향). flows: { ts, amount(+배당/매도 전액, -매수 전액) }[], legacy(마이그레이션
// 스냅샷) 이벤트는 호출부가 미리 걸러서 넘긴다(update-holdings-from-executions.mjs의
// pickUnprocessedExecutions와 동일 원칙).
export function resolvePensionCashLedger({ flows }) {
  const delta = (flows ?? []).reduce((s, f) => s + (f?.amount ?? 0), 0);
  return settleCash(0, delta);
}
