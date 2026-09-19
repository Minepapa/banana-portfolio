// NH PLUG "공통_계좌_조회" 도메인 — 2026-09 신설 API 2종(종합거래내역·입출금내역).
//
// 배경: 2026-09-19 오너가 NH PLUG 신규 공개 API 링크 2건을 전달, 진단 스크립트
// (scripts/tools/nhplug-new-apis-probe.mjs)로 실계좌 라이브 검증 완료 —
// 위탁 배당/분배금 집계 가능·외화RP 조회 가능(기존 [[project-nh-fx-rp-not-queryable]]
// 결론 뒤집힘)·ISA는 완전 차단(계좌 자체가 이 앱키 권한 밖) 확인. 상세는
// ~/banana-vault의 Knowledge/API/NH-PLUG.md·Log/Implementation/2026-09-19-NH-API-
// 종합거래내역-입출금내역-발견.md 참고.
//
// 이 두 API는 다른 nhplug-*.mjs 도메인 파일과 달리 결과가 페이지네이션될 수 있어
// (rsp_cd='00218' "연속조회 안내") nhplug.mjs의 callNhForPaging(cts/cts_flag 헤더
// 처리)을 쓴다 — 일반 callNh를 쓰면 00218이 업무오류로 오분류돼 유효한 데이터가
// 있는 페이지까지 throw된다(실측 재현, 2026-09-19).
import { callNhForPaging } from './nhplug.mjs';

const DEFAULT_MAX_PAGES = 50; // 안전판 — 정상 사용 범위(몇 달~1년 조회)에서 이만큼
// 페이지가 나올 일은 없다. 도달하면 truncated:true로 알리고 멈춘다(무한루프 방지, 조용한
// 데이터 누락 방지 — 호출측이 truncated를 반드시 확인하게 강제). 테스트에서만 낮춰서 씀.

async function fetchAllPages({ token, uri, input0, fetchImpl, maxPages = DEFAULT_MAX_PAGES }) {
  const rows = [];
  let cts;
  let ctsFlag;
  for (let page = 0; page < maxPages; page++) {
    const { body, cts: nextCts, ctsFlag: nextCtsFlag, hasMore } = await callNhForPaging({
      token, uri, input0, cts, ctsFlag, fetchImpl,
    });
    const pageRows = Array.isArray(body?.Output_0) ? body.Output_0 : [];
    rows.push(...pageRows);
    if (!hasMore) return { rows, truncated: false };
    // 서버가 연속신호(hasMore)는 줬는데 cts를 안 줌 — 더 못 간다는 점에선 maxPages
    // 소진과 똑같이 "아직 더 있는데 못 받은 페이지가 있다"는 뜻이므로 truncated:true로
    // 취급한다(2026-09-19 코드리뷰 HIGH 지적 — 예전엔 false로 반환해서 호출측이 "완전한
    // 데이터"로 오판했다. feedback-no-silent-fallback 원칙과 동일 — 불완전을 숨기지 않는다).
    if (!nextCts) return { rows, truncated: true };
    cts = nextCts;
    ctsFlag = nextCtsFlag || 'Y';
  }
  return { rows, truncated: true };
}

// 종합거래내역(HTS 8203) — 계좌의 입출금·입출고·매매 전체를 기간별로 조회.
// iemLlfCd: '00'전체·'01'주식/ELW·'05'채권/ELS·'06'CD·'07'CP·'08'RP·'09'수익증권·
//   '10'해외수익증권·'15'해외주식·'16'해외채권·'28'발행어음·'35'IMA
// actTrdDtlCd: '00'전체·'01'입출금·'02'입출고·'03'매매
// trd_dt는 결제기준(체결일 아님) — 체결일 매칭엔 ral_trd_dt(실거래일자)를 쓸 것.
export async function getTotalTransaction({
  token, actNo, iqrStaDt, iqrEndDt, iemLlfCd = '00', actTrdDtlCd = '00', iqrTpCd = '1', iqrRgeCd = '2', fetchImpl, maxPages,
}) {
  return fetchAllPages({
    token,
    uri: '/common/inquiry/v1/totalTransaction',
    input0: {
      iqr_tp_cd: iqrTpCd, iqr_rge_cd: iqrRgeCd, act_no: actNo,
      iqr_sta_dt: iqrStaDt, iqr_end_dt: iqrEndDt, iem_llf_cd: iemLlfCd, act_trd_dtl_cd: actTrdDtlCd,
    },
    fetchImpl,
    maxPages,
  });
}

// 입출금내역(HTS 8207) — 입금/출금만. actTrdDtlCd: '01'전체·'AA'입금·'BB'출금.
// 모의투자 도메인 미제공(오너 계정은 어차피 실전만 쓰므로 영향 없음).
export async function getDepositWithdrawal({
  token, actNo, iqrStaDt, iqrEndDt, actTrdDtlCd = '01', iqrTpCd = '1', fetchImpl, maxPages,
}) {
  return fetchAllPages({
    token,
    uri: '/common/inquiry/v1/depositWithdrawal',
    input0: { iqr_tp_cd: iqrTpCd, act_no: actNo, iqr_sta_dt: iqrStaDt, iqr_end_dt: iqrEndDt, act_trd_dtl_cd: actTrdDtlCd },
    fetchImpl,
    maxPages,
  });
}

// sps_cd_krl_anm(적요코드한글약명)에서 배당/분배금 "입금" 항목만 골라낸다 — 실측
// 확인된 적요 예: "배당금"·"외화배당금입금"·"ETF분배금입금"(2026-09-19 라이브 검증).
// "배당소득세"·"배당금출금"류(세금·출금)는 배당 입금 그 자체가 아니라 Vault
// (Facts/Ledger/Dividends, 입금 레코드만 존재)엔 대응 레코드가 없어 그대로 두면
// 매번 오탐 경고가 된다 — 세금/출금 적요는 명시적으로 제외(2026-09-19 코드리뷰 LOW
// 지적 반영). 순수함수.
export function filterDividendRows(rows) {
  return (rows || []).filter((r) => {
    const label = r?.sps_cd_krl_anm || '';
    return /배당|분배/.test(label) && !/세$|출금/.test(label);
  });
}

// 외화RP(iem_llf_cd='08') 거래이력에서 현재 열려있는 로트들을 재구성해 합계를 낸다.
//
// ⚠️ 2026-09-19 전면 재작성 — 이전 버전(latestForeignRpBalance)은 "최신 거래 1건의
// 거래후잔고수량 = 계좌 전체 RP 잔고"로 가정했는데, 오너가 NH 앱 스크린샷으로
// 직접 반증했다: 같은 계좌에 **만기일이 다른 RP 로트가 동시에 여러 개** 있을 수
// 있고(실측: 652.47 USD 만기 2026-09-23 + 5,353.15 USD 만기 2026-10-02 =
// 6,005.62), `trd_af_bnc_qty`는 "그 거래가 속한 로트 자신의 잔고"이지 계좌 전체
// 합계가 아니다. 실거래로 재현 확인:
//   20260826 외화RP매도 거래금액 652.47(그 로트 잔고 0) → 같은 날 외화RP매수
//   652.47(잔고 652.47) — 만기 도래 시 자동 매도+동액 매수로 "롤오버"하는 것으로
//   추정(자유약정형 특성).
//   20260904 외화RP매수 거래금액 5353.15(잔고 5353.15) — 별개의 신규 로트.
// "최신 1건"만 보면 9/4에 새로 생긴 로트(5353.15)만 잡고 8/26에 롤오버된 로트
// (652.47)를 놓친다.
//
// 재구성 방법: 로트에 고유 ID 필드가 없어(API 스펙에 그런 필드 없음) FIFO(선입선출)로
// 매수/매도를 짝짓는다 — 매수마다 새 로트를 열고, 매도는 **가장 먼저 열린(=가장
// 먼저 만기되는) 열린 로트**를 하나 닫는다.
//
// ⚠️ 금액 매칭은 안 된다(2026-09-19, 400일 실계좌 전수 조회로 처음 버전의 금액매칭
// 방식이 완전히 실패하는 걸 실측 확인 — 18개 매수 중 단 하나도 매도와 매칭되지
// 않아 총액이 31,138 USD로 부풀려짐). 원인: RP는 보유기간 동안 이자가 붙어
// 매도금액이 매수원금과 정확히 다르다(NH 앱 스크린샷의 "손익 -60원"·"120,455원"이
// 그 증거 — 원금과 상환액이 다르다는 뜻). 반면 "자유약정형"은 고정 만기(관측상
// 약 28일)를 두고 구매 순서대로 만기가 돌아오는 상품이라, FIFO가 실제 상환 순서와
// 일치할 가능성이 훨씬 높다 — 로트 개설일이 빠를수록 만기도 빠르다는 전제.
//
// 조회기간 시작 이전에 이미 열려있던 로트의 매도는 짝지을 열린 로트가 큐에 없어
// 조용히 무시되는데(shift()가 빈 큐에서 no-op), 이게 오히려 안전하다 — 그 로트의
// 원금을 애초에 더한 적이 없으니 뺄 것도 없다. "자유약정형"은 만기마다 자동
// 롤오버(매도+신규 매수)하므로, 조회기간이 한 만기주기(약 28일)보다 충분히 길면
// 모든 현재 열린 로트가 최소 한 번은 롤오버를 겪어 창 안에서 열림이 잡힌다 —
// reconcile-nh-fx-rp.mjs가 400일 창을 쓰는 이유.
//
// cur_cd가 비어있는(=원화) 행은 처음부터 제외(2026-09-19 코드리뷰 HIGH 지적 —
// 원화 RP가 섞이는 문제가 있었음).
export function reconstructForeignRpLots(rows) {
  const fxRows = (rows || [])
    .filter((r) => r?.trd_dt && r?.cur_cd)
    .slice()
    .sort((a, b) => (a.trd_dt < b.trd_dt ? -1 : a.trd_dt > b.trd_dt ? 1 : 0));

  const openLots = []; // FIFO 큐 — push로 열고 shift로 닫는다.
  for (const r of fxRows) {
    const label = r.sps_cd_krl_anm || '';
    const amt = Number(String(r.trd_amt ?? '').replace(/,/g, ''));
    if (/매수/.test(label)) {
      if (!Number.isFinite(amt)) continue;
      openLots.push({ amount: amt, openedDate: r.trd_dt, currency: r.cur_cd, productName: r.iem_nm || null });
    } else if (/매도/.test(label)) {
      openLots.shift(); // 가장 먼저 열린 로트를 닫음 — 매칭 실패(창 시작 이전 개설분)는 no-op
    }
  }
  const total = openLots.reduce((sum, l) => sum + l.amount, 0);
  const currency = openLots[0]?.currency ?? null;
  return { lots: openLots, total, currency };
}
