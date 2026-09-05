// 종목명 파편화 수동 별칭표(2026-09-05 신설) — code로는 못 잇는 이름 파편화만 여기
// 수동으로 추가한다(같은 code가 어딘가에 있으면 stock-registry.mjs의 자동 code
// 레지스트리가 이미 처리하므로 여기 넣을 필요 없음 — 예: Proposals의 "005930"↔
// State/Holdings의 "삼성전자"는 둘 다 ticker "005930"으로 연결돼 자동 처리됨).
//
// ⚠️ 잘못 추가하면 서로 다른 증권이 합쳐질 위험이 있다(예: 우선주 vs 보통주,
// 이름은 비슷해도 실제로 다른 종목인 경우) — 실제로 므네모시네에 존재하는 원문
// 표기를 오너와 함께 확인한 뒤에만 추가할 것, 추측으로 채우지 않는다. 키는
// canonName(원본 그대로, NFC·공백정규화·소문자)로 계산 — stock-registry.mjs의
// resolveCanonicalStockName이 조회에 사용.
//
// 2026-09-05 최초 시딩 — code-reviewer가 그래프 뷰 태그 작업 중 실측으로 찾아낸
// 파편화 사례(scripts/lib/vault-tags.mjs 관련 커밋 리뷰) 중 code로 자동 해결 안
// 되는 것만 옮김.
import { canonName } from '../../src/lib/stockIdentity.js';

const RAW_ALIASES = {
  // 삼성전자 — "005930"↔"삼성전자"는 State/Holdings ticker로 자동 해결되지만,
  // "삼성전자보통주"(Dividends 알림 원문 표기)는 code가 안 실려 있어 수동 추가.
  '삼성전자보통주': '삼성전자',
  // SK하이닉스 — Holdings에 ticker가 비어있어(백필 안 됨) code 자동해결 대상이
  // 아님. 카카오 배당 알림 원문 표기 두 가지를 표준명으로.
  '에스케이하이닉스보통주': 'SK하이닉스',
  '하이닉스': 'SK하이닉스',
  // TIGER 미국배당다우존스 계열 — 카카오 알림이 정식 장문명(운용사명+상품유형
  // 접미사 포함, 종종 글자수 제한으로 끝이 잘림)을 쓰는 반면 State/Holdings·
  // 다른 State 상태 파일은 짧은 표시명을 쓴다.
  '미래에셋 TIGER 미국배당다우존스증권상장지수투자신탁(주식)': 'TIGER 미국배당다우존스',
  '미래에셋 TIGER 미국배당다우존스타겟데일리커버드콜증권상장지': 'TIGER 미국배당다우존스타겟데일리커버드콜',
  // ACE 미국10년국채액티브 — 어순만 다른 동일 상품(카카오 알림 표기 차이).
  'ACE 미국국채10년액티브': 'ACE 미국10년국채액티브',
  // KODEX 골드선물(H) — 퀀트 제안(assetKey)이 " ETF" 접미사를 붙이거나 뺀 두
  // 형태를 섞어 씀.
  'KODEX 골드선물(H) ETF': 'KODEX 골드선물(H)',
  // SK텔레콤 — code(017670)로는 Executions 경유 자동 해결되지만(stock-registry.mjs
  // 헤더 주석 참고), 카카오 배당 알림의 "SK텔레콤보통주" 표기는 code가 안 실려 있어
  // 수동 추가(실측: Facts/Ledger/Dividends 2건).
  'SK텔레콤보통주': 'SK텔레콤',
  // VIP한국형가치투자 펀드 — 일부 FundValuations 레코드가 "신탁"을 빠뜨린 축약형을
  // 씀(나머지 대다수·State/Holdings는 "신탁" 포함형이 표준).
  'VIP한국형가치투자증권자투자(주식)-C-Pe': 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe',
  // TIME Korea플러스배당액티브 — 카카오 배당 알림의 정식 장문명(운용사명 접두사+
  // 상품유형 접미사, 글자수 제한으로 끝이 잘림)이 Holdings 짧은 표시명과 다름.
  '타임폴리오 TIME Korea플러스배당액티브증권상장지수투자신탁[주': 'TIME Korea플러스배당액티브',
  // TIGER 리츠부동산인프라TOP10액티브 — "TIGER 리츠부동산TOP10"은 v1(구글시트)
  // 마이그레이션 시절의 축약 표기(2025-11~2026-04 배당 기록, 이후 카카오 실시간
  // 파싱으로 전환되며 표기가 바뀜 — 같은 계좌·같은 월배당 주기로 연속성 확인).
  'TIGER 리츠부동산TOP10': 'TIGER 리츠부동산인프라TOP10액티브',
  // 카카오 알림 정식 장문명(글자수 제한으로 끝이 잘려 "TOP10액티브"까지만 보임).
  '미래에셋 TIGER 리츠부동산인프라TOP10액티브부동산상장지수투자': 'TIGER 리츠부동산인프라TOP10액티브',
  // PLUS 고배당주 — 카카오 알림 정식 장문명(운용사 "한화" 접두사 포함).
  '한화 PLUS 고배당주 증권상장지수투자신탁(주식)': 'PLUS 고배당주',
};

// canonName 기준 Map — resolveCanonicalStockName이 조회할 실제 테이블.
export const MANUAL_STOCK_ALIASES = new Map(
  Object.entries(RAW_ALIASES).map(([alias, canonical]) => [canonName(alias), canonical]),
);
