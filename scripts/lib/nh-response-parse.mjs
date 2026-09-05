// NH PLUG 응답 파싱 공용 순수함수 — 2026-09-05/06 asset-allocation 자동체결 코드리뷰
// 지적으로 scripts/jobs/update-holdings-prices.mjs·reconcile-nh-cash.mjs에서 이 lib로
// 승격(원래는 각 잡 파일에 자체 정의돼 있었다 — 이제 execute-asset-allocation-
// proposal.mjs가 세 번째 소비처가 되며 브로커별 잡 파일 사이의 cross-import보다
// 공용 lib 승격이 맞다고 판단). 두 잡 파일은 하위호환을 위해 이 모듈에서 import한
// 뒤 그대로 재수출(re-export)한다 — 기존 테스트가 그 잡 파일에서 직접 import하므로
// 깨지지 않는다.

// NH 시세응답에서 가격 필드를 뽑아 검증(원래 update-holdings-prices.mjs, 2026-09-02
// 코드리뷰 HIGH 지적) — `Number.isFinite(curPrice)`로만 확인하면 `Number(null)`·
// `Number('')`·`Number('0')`가 전부 `0`(유한수)이라 "필드 없음"·"빈 문자열"·
// "진짜 0원"을 못 걸러낸다. NH가 거래정지·조회불가 종목에 stck_prpr:null 같은 값을
// 실어보내면 그대로 curPrice=0으로 통과할 뻔했다 — kis.mjs의 기존 시세 파서가 이미
// `price > 0`으로 검증하는 것과 동일 기준. ⚠️ NH 시세 필드는 문자열로 온다(예:
// `stck_prpr:'75000'`, nhplug-krstock.test.js 실측) — Number()로 반드시 캐스팅해야
// checkPriceDeviation의 Number.isFinite 검사를 통과한다(2026-09-06 asset-allocation
// 코드리뷰 HIGH — 이 캐스팅 없이 문자열을 그대로 넘기면 모든 제안이 "현재가 조회
// 실패"로 오판되던 사고 실측 재현·수정).
export function extractNhPrice(output0, field) {
  const price = Number(output0?.[field]);
  if (!(price > 0)) throw new Error(`NH 응답에 유효한 현재가(${field}) 없음: ${JSON.stringify(output0)}`);
  return price;
}

// 계좌잔고(getKrBalance) / 예수금및잔고(getGoldBalance) 응답 Output_0 → 예수금(원).
// 순수함수 — 테스트 가능. drn_pbl_amt(출금가능금액) 우선, 없으면(금현물 응답엔
// 이 필드 자체가 없음, 라이브 확인) dca(당일예수금)로 폴백 — dca는 결제(T+2) 반영
// 전 값이라 매수 직후 며칠간 실제보다 부풀려질 수 있어 drn_pbl_amt가 우선이다
// (원래 reconcile-nh-cash.mjs 2026-09-03 결정). 둘 다 없으면(구조 변경 등 신호)
// throw — 0으로 추정하지 않는다. 값 자체가 0인 건 허용(전액 매수 등 실제로 가능한
// 상태이므로 price>0류 가드를 쓰면 안 됨 — `??`는 null/undefined에서만 다음으로
// 넘어가고 0은 그대로 보존한다). NH 값이 콤마 포함 문자열로 올 수 있어(구글시트
// 숫자 파싱 함정과 동일 클래스) 콤마 제거 후 캐스팅.
export function extractNhCashDeposit(output0) {
  const raw = output0?.drn_pbl_amt ?? output0?.dca;
  if (raw == null) throw new Error('NH 계좌잔고 응답에 drn_pbl_amt(출금가능금액)·dca(예수금) 필드 모두 없음 — 구조 확인 필요');
  const n = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`NH 계좌잔고 예수금 값이 숫자가 아님: ${raw}`);
  return n;
}
