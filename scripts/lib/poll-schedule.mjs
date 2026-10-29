/**
 * 10분 주기 잡의 조회 빈도 등급(2026-10-29 오너 지시 — "변동성이 적은 수치는 이렇게
 * 자주 확인할 필요가 없다. API 호출이 충돌나지 않게 분배해라").
 *
 * 왜: update-holdings-prices·intraday-portfolio-sync가 둘 다 10분마다 24시간 돌며
 * 바뀔 일이 거의 없는 값(채권 평가·금 일별 종가·펀드 기준가·IRP 잔고·NH 예수금)까지
 * 매번 조회했다. 그 결과 NH 유량초과(429, 다른 잡과 같은 순간 호출)와 IRP 원장 초당
 * 한도 초과가 반복됐다(10-14~29 로그 실측, IRP는 장중에만).
 *
 * 등급(모두 KST 벽시계 기준):
 *   - 매 회차(10분): 장중 시세, 체결 감지(장 시간대), 로컬 계산 단계
 *   - 30분: 장 시간대의 NH 예수금
 *   - 1시간: 채권 평가·금 종가·펀드 기준가·IRP 잔고/체결, 장외 시간의 체결·예수금
 *
 * "1시간"은 그 시각의 첫 10분 칸(분 0~9)에 도는 회차만 뜻한다. 그래서 두 잡이 launchd
 * StartCalendarInterval로 고정 분(시세 :00·:10…, 동기화 :05·:15…)에 돌아야 정확히
 * 시간당 1회가 된다(plist 주석 참고). 회차가 늦게 시작돼 칸을 놓치면 그 시간은 건너뛴다
 * — 고정시각 안전망 잡(평일 15:50~16:11)이 하루 1회는 전부 조회한다.
 */

const KST_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
});
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function kstClock(date = new Date()) {
  const parts = Object.fromEntries(KST_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24; // en-US hour12:false는 자정을 "24"로 줄 수 있다
  const minute = Number(parts.minute);
  return { dow: WEEKDAY_INDEX[parts.weekday], hour, minute, hhmm: hour * 100 + minute };
}

// 시간당 첫 10분 칸
export function isHourlySlot(date = new Date()) {
  return kstClock(date).minute < 10;
}

// 30분마다 첫 10분 칸(분 0~9, 30~39)
export function isHalfHourlySlot(date = new Date()) {
  return kstClock(date).minute % 30 < 10;
}

// 국내 거래 시간대 — 정규장(09:00~15:30)에 장전 시간외(08:30~)와 장후 시간외·단일가
// (~18:00)까지 넣는다. 돌파매매 진입이 장후 시간외(15:40~16:00)에 체결되기 때문이다.
// 휴장일은 따지지 않는다(그날은 10분 조회가 헛돌 뿐 틀린 값을 쓰지는 않는다).
export function isKrTradingWindow(date = new Date()) {
  const { dow, hhmm } = kstClock(date);
  return dow >= 1 && dow <= 5 && hhmm >= 830 && hhmm <= 1800;
}

// 평일 고정시각 안전망 잡 구간(reconcile-irp-executions 15:50 ~ update-fund-holdings-from-
// purchases 16:11). 이 구간의 동기화 회차(15:55·16:05)는 같은 스크립트를 같은 순간에 돌려
// IRP 원장·NH 유량을 다시 부딪히고, update-holdings-from-executions 두 개가 잠금 없이 같은
// 체결을 읽어 이중 반영할 수 있다(2026-10-29 독립 리뷰 MEDIUM). 안전망이 7단계를 전부 하므로
// 동기화는 이 구간을 통째로 건너뛴다.
export function isSafetyNetWindow(date = new Date()) {
  const { dow, hhmm } = kstClock(date);
  return dow >= 1 && dow <= 5 && hhmm >= 1550 && hhmm <= 1614;
}

// 장중 동기화(intraday-portfolio-sync) 단계별 실행 여부. full=true면 전부(수동 실행용).
// usOpen은 호출측이 kis.mjs isUsMarketOpen으로 넘긴다(미국 장중엔 해외주식 체결 감지를
// 매 회차 돌린다).
export function planIntradaySyncSteps(date = new Date(), { full = false, usOpen = false } = {}) {
  const krWindow = isKrTradingWindow(date);
  const hourly = isHourlySlot(date);
  const halfHourly = isHalfHourlySlot(date);
  const plan = {
    'reconcile-nh-executions.mjs': krWindow || usOpen || hourly,
    // IRP는 KIS API가 이 계좌 체결을 돌려주지 않아 늘 0건이다(intraday-portfolio-sync 헤더).
    // 거래 시간대에 시간당 1회만 둔다.
    'reconcile-irp-executions.mjs': krWindow && hourly,
    'update-holdings-from-executions.mjs': true,
    'reconcile-nh-cash.mjs': krWindow ? halfHourly : hourly,
    // IRP 잔고·예수금은 월 적립·리밸런싱 때만 바뀐다. 보유 종목 시세는 시세 잡이 따로 갱신.
    'reconcile-irp.mjs': krWindow && hourly,
    'update-cash-from-ledger.mjs': true,
    'update-fund-holdings-from-purchases.mjs': true,
  };
  if (full) for (const step of Object.keys(plan)) plan[step] = true;
  else if (isSafetyNetWindow(date)) for (const step of Object.keys(plan)) plan[step] = false;
  return plan;
}

// 시세 잡(update-holdings-prices)의 느린 값 조회 여부. 장중 KR/US 시세와 USD/KRW 환율은
// 여기서 다루지 않는다(매 회차 그대로).
export function planSlowValuations(date = new Date(), { full = false } = {}) {
  if (full) return { bond: true, gold: true, fund: true };
  const hourly = isHourlySlot(date);
  return {
    // NH 채권 잔고 평가 — 채권 가격은 하루에도 거의 안 움직인다. 거래 시간대에 시간당 1회.
    bond: isKrTradingWindow(date) && hourly,
    // KRX 금 일별 종가·VIP 펀드 기준가 — 하루 한 번 바뀌는 값. 시간당 1회.
    gold: hourly,
    fund: hourly,
  };
}
