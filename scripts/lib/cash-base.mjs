// 예수금 base(기준액) 앵커 결정 — 순수 함수(테스트: cash-base.test.js).
//
// 예수금 = base + Σ(기준일 이후 거래 델타). base 를 무엇으로 잡느냐가 이 모듈의 책임.
//
// NH(ISA·위탁)는 입금/출금 알림의 '출금가능금액'이 그 시점 실제 잔고 = 가장 신뢰할 앵커다.
// 과거 버그: 사용자가 앱에서 예수금을 한 번 수정하면 소스='수동'이 박히고, parse-notifications
// 가 그 후 NH 알림을 영구 무시 → 입금이 base 에 반영 안 돼 매수 델타만 빠져 예수금이 음수로
// 고착(ISA −390,600). 수정: 알림이 수동 기준일보다 '엄격히 최신'이면 알림을 우선한다(입금 자동
// 반영). 같은 날은 사용자가 방금 고친 것으로 보고 수동 존중. 비-NH(연금저축·IRP)는 수동 기준만.

// 시트 셀값("296,000")·숫자(984832) → 정수. 빈값/비숫자는 null.
// 부호 제거는 의도적 — 예수금 base 는 음수가 될 수 없다(앵커 balance≥0, 미수/마진 미지원).
export function parseAmount(v) {
  const digits = String(v ?? '').replace(/[^0-9]/g, '');
  if (digits === '') return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// 예수금 정산 — base + delta. 예수금은 음수가 될 수 없다(미수·마진 미지원)이므로 0으로 클램프하고
// 음수였다는 사실을 negative 로 표시한다. 음수는 입금/이체 알림 누락(카카오 앱이 과거 알림 삭제·
// 비-NH 수동기준 미갱신 등) 또는 거래 오귀속의 징후 — 호출부가 경고를 띄워 계좌·금액 검증을 유도한다.
export function settleCash(base, delta) {
  const raw = (base ?? 0) + (delta ?? 0);
  return { cash: Math.max(0, raw), raw, negative: raw < 0 };
}

// cfg: { base, date, source } | null  (예수금기준 표의 해당 계좌 행)
// anchor: { balance, ts } | null      (그 계좌 최신 NH 입금/출금 알림; balance≥0)
// isAutoTab: boolean                  (ISA·위탁=true, 연금저축·IRP=false)
// 반환: { base: number|null, baseDate: string, autoUpdated: boolean }
//   autoUpdated=true → 호출부가 예수금기준 표를 [base, baseDate, '자동', 시각]으로 갱신해야 함.
export function resolveCashBase({ cfg, anchor, isAutoTab }) {
  const cfgBase = cfg ? parseAmount(cfg.base) : null;     // 수동·자동 행 모두에 쓰이는 기준액
  const cfgDate = cfg ? String(cfg.date ?? '').trim() : '';
  const isManual = cfg?.source === '수동' && cfgBase !== null;

  if (isAutoTab && anchor) {
    // 날짜만 비교(시각 버림): 수동 기준이 있으면 알림이 '엄격히 최신 날짜'(>)일 때만 우선,
    // 같은 날 수동 입력은 존중. 수동이 아니면(자동/미입력) 알림이 기준일 이상(>=)이면 우선
    // — 기존 자동앵커 동작 보존. 같은 날 수동입력 뒤 늦게 들어온 입금은 그날 base 엔 누락되나,
    // 그 입금이 반영된 '더 늦은 날짜'의 NH 알림이 이후 오면 앵커가 갱신돼 반영된다(음수 고착 아님).
    const anchorDate = String(anchor.ts ?? '').slice(0, 10);
    const anchorWins = isManual ? anchorDate > cfgDate : anchorDate >= cfgDate;
    if (anchorWins) {
      return { base: anchor.balance, baseDate: anchorDate, autoUpdated: true };
    }
  }
  if (cfgBase !== null) {
    return { base: cfgBase, baseDate: cfgDate, autoUpdated: false };
  }
  return { base: null, baseDate: '', autoUpdated: false };
}
