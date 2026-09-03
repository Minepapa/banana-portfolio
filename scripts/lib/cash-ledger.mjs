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
//
// ⚠️ 범위 축소(2026-09-03, 마이그레이션 3단계) — 위 "6계좌 전부 동일 루프" 결정을
// 오너가 다시 뒤집었다("예수금 앵커는 통일 루프 깸. 계좌별 분기" — `Log/Strategy/
// 2026-09-02-NH-API-우선-KIS-카카오파싱-역할축소-결정.md`). API로 직접 예수금
// 조회가 가능해진 4계좌(위탁·CMA·금현물·IRP)는 이제 이 기준점+델타 재구성 자체를
// 건너뛴다(reconcile-nh-cash.mjs·reconcile-irp.mjs가 State/Holdings를 직접 씀) —
// 여기 함수들(resolveCashAnchor·computeCashDelta·settleCash)은 API가 없는 2계좌
// (ISA·연금저축, update-cash-from-ledger.mjs)에만 계속 쓰인다. 위 설계 자체(전체
// 타임스탬프 비교로 v1 날짜절삭 버그 재발 방지)는 여전히 유효 — "몇 계좌에
// 적용하는가"만 좁아졌다.

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

// 계좌 기준점 결정 — 기본은 "가장 최근 CashEvent"를 신뢰(자동 알림·수동 스냅샷
// 구분 없이 시각 기준 최신 것이 이긴다 — 2026-08-18 설계통합, 위 헤더 주석 참고).
// CashEvent가 아직 하나도 없으면(이 기능 최초 실행 등) 기존 저장값(마이그레이션
// 스냅샷 등)을 임시 기준으로 유지 — source:'이관'으로 표시해 첫 실제 기록이 오면
// 반드시 대체되게 한다. latestEvent: { balance, ts } | null. stored: { base, baseTs,
// source } | null.
//
// ⚠️ 버그 수정(2026-09-03, code-reviewer 지적 — 마이그레이션 3단계 롤백 함정) —
// 원래는 latestEvent가 있으면 시각 비교 없이 무조건 그걸 썼다. 위탁·CMA처럼
// CashEvent 파싱이 중단된 계좌(reconcile-nh-cash.mjs가 State/Holdings를 직접
// 쓰는 계좌, parse-notifications-to-vault.mjs 참고)는 latestEvent가 그 중단
// 시점에 영구 동결된다 — 만약 나중에 이 계좌를 실수로 ALL_ACCOUNTS에 되돌리면
// (예: 마이그레이션 롤백), 동결된 옛 latestEvent가 stored(직접 API로 매일
// 갱신되던 최신값)보다 무조건 우선시돼 기준점이 수개월 전으로 튀고, 그 사이
// 쌓인 flow가 델타로 다시 더해져 예수금 이중반영이 난다 — 이 프로젝트가 이미
// 두 번 겪은 사고 클래스. stored.baseTs가 latestEvent.ts보다 최신이면 stored를
// 우선하도록 시각 비교를 추가해 이 경로를 구조적으로 막는다.
export function resolveCashAnchor({ stored, latestEvent }) {
  const hasStored = !!(stored && Number.isFinite(stored.base));
  const storedIsNewer = hasStored && stored.baseTs && latestEvent
    && String(stored.baseTs) > String(latestEvent.ts);
  if (latestEvent && !storedIsNewer) {
    return { base: latestEvent.balance, baseTs: latestEvent.ts, source: '자동' };
  }
  if (hasStored) {
    return { base: stored.base, baseTs: stored.baseTs ?? '', source: stored.source || '이관' };
  }
  return { base: null, baseTs: '', source: null };
}

// 신규현금배분(new-cash-allocation.mjs) 트리거 문턱값+적용범위 — 원래 cash-accumulator.mjs
// 에 있었으나(2026-08-16 신설), 그 모듈 전체(이벤트 누적 방식)가 2026-08-18에 실잔고
// 기반으로 교체되며 폐기됐다(2026-08-17 10배 부풀림 사고 — "들어온 돈"만 더하고 "이미
// 재투자한 돈"을 안 빼는 구조적 결함, 예수금앵커가 없어 실잔고 대조가 불가능했던 게
// 근본원인). 이제 실잔고(State/Holdings/{계좌}-예수금.md)가 있으므로 이 두 상수만
// 여기로 옮기고 이벤트 누적 로직은 전부 제거했다.
export const NEW_CASH_THRESHOLD_WON = 500_000;
// 위탁·연금저축만(ARCHITECTURE-V2.md "신규 현금 배분 원칙" 절, rebalance-gap.mjs
// TARGET_ALLOCATION과 동일 범위 — ISA·CMA·금현물·IRP·퀀트는 대상 밖).
export const CASH_ELIGIBLE_ACCOUNTS = new Set(['위탁', '연금저축']);

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

// resolveDesignatedCashBalance가 받는 파라미터 이름(wtCash·goldCash)이 "어느 계좌가
// 자유 재투자 대상인지"를 사실상 결정한다 — report-facts.mjs가 이 판단을 별도로
// KNOWN_DESIGNATED_ACCOUNTS Set으로 다시 하드코딩하면, 여기 파라미터가 3번째 계좌로
// 늘어나도 그쪽 Set은 조용히 안 늘어난다(코드리뷰 지적, 2026-08-30). 계좌명 목록
// 자체를 여기서 내보내 소비자가 이 배열 하나만 따라가게 한다.
//
// ⚠️ 후속 코드리뷰 지적(2026-08-31) — 위 문단이 사실과 다르다. resolveDesignatedCashBalance는
// 여전히 `{wtCash, goldCash}` 2필드 고정 시그니처이고, report-facts.mjs도 이 배열을
// `const [wtCash, goldCash] = DESIGNATED_CASH_ACCOUNTS.map(...)`로 앞 2개만 취해 쓴다 —
// 이 배열에 3번째 계좌를 추가해도 그 계좌는 두 소비자 모두에서 조용히 버려진다("배열
// 하나만 따라가게 한다"는 주장이 거짓이 되는 지점). 완전한 일반화(N개 계좌 배열을
// 받는 시그니처로 교체) 대신, 길이가 어긋나면 즉시 실패하게 해서 이 사실이 다시
// 잊혀지지 않게 한다 — 배열을 확장하려면 resolveDesignatedCashBalance와
// report-facts.mjs 호출부를 함께 고쳐야 한다.
export const DESIGNATED_CASH_ACCOUNTS = ['위탁', '금현물'];
if (DESIGNATED_CASH_ACCOUNTS.length !== 2) {
  throw new Error('DESIGNATED_CASH_ACCOUNTS 길이가 2가 아님 — resolveDesignatedCashBalance({wtCash, goldCash})와 report-facts.mjs의 [wtCash, goldCash] 구조분해를 함께 일반화한 뒤에만 배열을 확장할 것');
}

// 2026-08-30 신설 — new-cash-allocation.mjs에서 여기로 이전(코드리뷰 HIGH 지적).
// report-facts.mjs(주간 리포트)가 "위탁+금현물 자유 재투자 가능 현금"을 보여줄 때
// resolveDesignatedCashBalance는 재사용했지만, 그 입력(wtCash·goldCash)을 직접
// 계산하는 "그 계좌의 현금이 정확히 무엇인가"라는 선택 규칙은 따로 재구현했다
// (assetClass==='현금'인 보유 전부를 합산 — new-cash-allocation.mjs가 실제로 쓰는
// "이름이 정확히 '예수금'인 보유 하나"라는 더 엄격한 규칙과 다름). 지금은 두 계좌
// 다 예수금 홀딩이 하나뿐이라 우연히 같은 값이 나오지만, "달러" 자산군의 외화RP처럼
// isCashLike이지만 assetClass가 "현금"이 아닌 보유가 계좌에 추가되거나, 같은 계좌에
// "현금" assetClass 보유가 두 개 이상 생기면(신규 MMF 등) 조용히 갈라진다 — 정확히
// 이 리팩터가 막으려던 "같은 개념을 두 번 정의" 패턴의 재발이라 코드리뷰에서 지적됨.
// 이제 findCashBalance 하나만 두 소비자(new-cash-allocation.mjs·report-facts.mjs)가
// 공유한다 — "그 계좌의 현금 잔고"라는 선택 규칙 자체가 한 곳에만 존재.
//
// State/Holdings에서 그 계좌의 예수금 보유(isCashLike, name="예수금")를 찾는다 —
// buildCashHoldingRecord가 쓰는 관례 그대로(holdings-vault-writer.mjs). 없으면(그
// 계좌 예수금 계산이 아직 한 번도 안 됨 등) null — 0으로 추정하지 않는다.
export function findCashBalance(holdings, account) {
  const h = holdings.find((x) => x.account === account && x.name === '예수금' && x.isCashLike);
  return h && Number.isFinite(h.evalAmount) ? h.evalAmount : null;
}
