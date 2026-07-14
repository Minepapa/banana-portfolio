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

// 계좌 귀속 폴백 — 전량매도로 보유행이 지워진 종목(useTradeSync.js clearRowsRaw 가 매도 후
// 잔여수량<=0 이면 B:I를 비움)은 그 시점 이후 "현재 보유" 스캔(portfolioMap)에서 사라진다.
// 실제 사고(2026-07-13): 삼성바이오로직스 전량매도 후 보유행 소멸 → 매도대금(+5,620,000)이
// 예수금 델타 계산에서 조용히 누락되어 위탁 예수금이 0으로 클램프됨.
// 체결내역 시트는 그 거래가 원래 기록될 때(보유행이 아직 살아있던 시점)의 계좌를 C열에 영구
// 보존한다 — 이를 폴백 소스로 삼아 "현재 보유 스캔 실패 → 조용히 버림"을 막는다.
// rows: 체결내역 원본 행. tabCol/nameCol: 0-based 컬럼 인덱스. validTabs: 허용 계좌 목록.
export function buildHistoricalAcctMap(rows, { tabCol, nameCol, validTabs }) {
  const map = new Map(); const ambiguous = new Set();
  for (const row of rows ?? []) {
    const tab = String(row[tabCol] ?? '').trim();
    const name = String(row[nameCol] ?? '').trim();
    if (!tab || !name || !validTabs.includes(tab)) continue;
    const prev = map.get(name);
    if (prev && prev !== tab) { ambiguous.add(name); continue; }
    map.set(name, tab);
  }
  return { map, ambiguous };
}

// 증권사(broker) → 그 증권사를 쓰는 계좌 목록. NH투자증권은 ISA·위탁 둘 다 걸쳐있어 유일
// 확정이 안 되지만, 삼성증권(연금저축 전용)·한국투자증권(IRP 전용)은 증권사만으로 계좌가
// 100% 확정된다 — 종목명 중복(portfolioMap dupNames)과 무관한, 가장 신뢰도 높은 신호다.
// (dividendAcctCandidates 와 동일한 매핑, 체결 흐름 계산에도 재사용)
export const BROKER_TABS = {
  'NH투자증권': ['ISA', '위탁'],
  '삼성증권': ['연금저축'],
  '한국투자증권': ['IRP'],
};

// 실제 사고(2026-07-14): 위탁(NH)·연금저축(삼성증권)이 똑같은 이름("TIGER 미국배당다우존스")을
// 동시보유 → 종목명 매칭(portfolioMap/체결내역 폴백)은 둘 다 배제해 연금저축 매도대금
// (+307,300원)이 누락됐다. 그 알림이 어느 증권사(broker)에서 왔는지는 이미 알고 있으므로,
// 증권사가 계좌를 유일하게 정하면(연금저축·IRP) 종목명 매칭보다 먼저 이걸로 확정한다.
export function resolveBrokerTab(broker) {
  const tabs = BROKER_TABS[broker];
  return tabs?.length === 1 ? tabs[0] : null;
}

// 계좌 결정 — 현재 보유 스캔(liveTab)이 있으면 그것을 신뢰(가장 최신 실측). 없으면(전량매도로
// 소멸) 체결내역 폴백을 쓰되, 같은 종목명이 서로 다른 계좌에 기록된 적 있으면(모호) 오귀속
// 위험이 있어 포기(null)한다 — 틀린 계좌에 붙이는 것보다 누락 경고가 안전하다.
// dupNames: 현재 2개 이상 계좌에 동시 보유 중인 종목명 집합(portfolioMap 구성 시 이미 계산됨).
// KRW 체결 알림엔 계좌번호가 없어 이런 종목은 portfolioMap 이 의도적으로 제외한다(liveTab=null
// 로 여기 들어옴) — 체결내역 이력에 계좌가 하나만 남아있어도(예: 한쪽 계좌 이력 부재) 폴백이
// 되살려버리면 그 배제가 무력화된다. 그래서 dupNames 는 이력 유무와 무관하게 항상 거부한다.
export function resolveTradeTab(name, liveTab, hist, dupNames) {
  if (liveTab) return liveTab;
  if (dupNames?.has(name)) return null;
  if (hist.ambiguous.has(name)) return null;
  return hist.map.get(name) ?? null;
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
