// 자산분배 트랙 제안(assetKey)을 NH PLUG 주문 가능한 자산군으로 분류하는 라우터
// (2026-09-05 신설, 오너 지시: "지금 배선하는거야" — 자산분배 자동체결 1차 구현,
// execute-asset-allocation-proposal.mjs가 소비).
//
// 왜 필요한가: 퀀트 트랙(execute-quant-proposal.mjs)은 계좌가 하나뿐이고 전부 KR
// 주식이라 라우팅 문제가 없었다. 자산분배 트랙은 위탁 계좌 하나에 국내주식·해외주식·
// 실물금이 섞여 있고(연금저축은 오너 지시로 이번 자동체결 대상 제외 — 리마인더만
// 유지), 심지어 Decisions/Proposals의 account 필드 자체가 신뢰 불가능하다(실측:
// 실물금 제안도 account:"위탁"으로 찍혀 있음 — 실제 보유는 State/Holdings의
// 금현물-금-99.99K.md가 유일한 정본, account:"금현물"). 그래서 이 라우터는
// proposal.account를 무시하고, assetKey를 State/Holdings 실측 레코드로 먼저 찾아
// 그 assetClass·account로 분류한다(찾아지면). 못 찾으면(신규 매수, 아직 안 보유)
// code/name 해석기로 직접 판별한다.
//
// 분류 결과 4종:
//   KR_STOCK       — krstock 도메인(국내주식·ETF·리츠·배당주·채권ETF 전부 포함,
//                     iemCd=6자리 종목코드)
//   OVERSEAS_STOCK — gbstock 도메인(해외주식, iemCd=티커)
//   GOLD           — krgold 도메인(실물금, iemCd 고정값 — 아래 참고)
//   UNSUPPORTED    — 이번 1차 구현에서 자동체결 대상 아님(reason에 사유, 기존 수동
//                     리마인더 흐름 유지 — 추측 금지 원칙)
//
// ⚠️ "금" 자산군 함정(2026-09-05 실측으로 발견) — assetClass가 "금"이라고 전부 실물
// 금현물은 아니다. State/Holdings 실측 확인 결과 "TIGER KRX금현물"(연금저축 보유,
// KRX 상장 ETF)도 assetClass:"금"을 쓴다 — 실물 "금 99.99K"(금현물 계좌)와 자산군
// 라벨이 똑같다. 유일한 신뢰 가능 구분자는 account==="금현물"(NH의 전용 실물금
// 서브계좌)뿐이다 — assetClass만으로는 절대 구분 불가. account가 금현물이 아닌 "금"
// 자산군은 전부 일반 ETF로 보고 아래 KR_STOCK 경로로 폴스루한다.
//
// UNSUPPORTED로 떨어지는 나머지 경우:
//   - 현금·외화(달러) 자산군: 예수금 자체는 주문 대상이 아니고, 외화 RP는 오너
//     확인(2026-09-05)대로 NH가 USD 예수금 발생 시 자동 스윕하는 브로커 기능이라
//     이 시스템이 별도 주문을 낼 필요/방법이 없음(환전 주문 API 자체가 없음도
//     이 조사 과정에서 재확인됨).
//   - 국내 자산인데 KRX 마스터/DART에 없는 종목(직접 채권 등, 예: 삼척블루파워12) —
//     krStockCode가 null을 반환하는 게 바로 이 케이스. nhplug-krbond.mjs를 통한
//     직접채권 주문 배선은 아직 없음(1차 구현 범위 밖, 실측 빈도 낮음).
//   - 위 어느 것으로도 못 찾은 종목(오탈자·완전 신규 등) — 추측 금지 원칙.
//
// 실물금 iemCd를 'M04020000'(금1kg)으로 고정하는 이유: nhplug-krgold.mjs의
// GOLD_ITEM_CODE={금1kg,미니금100g}는 명칭 그대로일 뿐 Holdings 표시명("금
// 99.99K")과 무관하다 — 2026-09-05 실측(getGoldBalance 라이브 조회)으로 현재
// 보유 실물금의 iem_cd가 정확히 'M04020000'임을 직접 확인했다. State/Holdings
// 전수 확인 결과 금현물 계좌로 보유되는 실물금은 이 상품 하나뿐이라, 추정이 아니라
// 확인된 사실로 고정값을 쓴다(미니금100g을 사고파는 시나리오가 생기면 이 상수부터
// 재검토할 것).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from './vault-paths.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { canonName } from '../../src/lib/stockIdentity.js';
import { resolveCanonicalStockName, getCodeRegistry } from './stock-registry.mjs';
import { krStockCode, usTicker } from './instruments.mjs';

export const INSTRUMENT_TYPE = {
  KR_STOCK: 'KR_STOCK',
  OVERSEAS_STOCK: 'OVERSEAS_STOCK',
  GOLD: 'GOLD',
  KR_BOND: 'KR_BOND',
  UNSUPPORTED: 'UNSUPPORTED',
};

// 2026-09-05 라이브 확인(getGoldBalance) — 이 시스템이 보유하는 유일한 실물금 상품.
export const PHYSICAL_GOLD_IEM_CD = 'M04020000';
// 위 iemCd 고정값이 실제로 맞는 유일한 실물금 표시명 — account==="금현물"이라도
// 이 집합에 없는 이름(예: 언젠가 미니금100g을 사게 되는 경우)이면 GOLD로 분류하지
// 않는다(2026-09-06 코드리뷰 MEDIUM 지적 — assetClass·account만 보면 다른 실물금
// 상품에도 이 1kg 코드를 잘못 씌워 10배 차이 나는 금액으로 주문할 위험이 있었다).
// 새 실물금 상품을 실제로 사게 되면 이 집합과 PHYSICAL_GOLD_IEM_CD 매핑을 먼저 갱신할 것.
const KNOWN_PHYSICAL_GOLD_NAMES = new Set(['금 99.99K']);

// 이미 티커 형태(영문 대문자·점만)로 보이는 assetKey는 usTicker 조회 없이 그대로
// 사용 — "VOO"처럼 한글 별칭이 애초에 필요 없는(한글명이 곧 티커가 아닌) 종목까지
// usTicker의 US_MAP·해외종목마스터에 전부 등록해둘 필요가 없다.
const LOOKS_LIKE_TICKER = /^[A-Z.]+$/;

function readDirSafe(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

// State/Holdings 전체를 canonName(name) → 레코드 Map으로 인덱싱(순수 I/O 분리 —
// stock-registry.mjs의 buildCodeRegistry와 동일 관례). 실행 잡이 배치 시작 시 1회만
// 호출하고, classifyAssetAllocationInstrument에는 결과를 주입한다.
export function buildHoldingsIndex({ holdingsDir = VAULT_PATHS.state.holdings } = {}) {
  const index = new Map();
  for (const f of readDirSafe(holdingsDir)) {
    const fm = parseFrontmatter(readFileSync(join(holdingsDir, f), 'utf8'));
    if (!fm.name) continue;
    const key = canonName(fm.name);
    const record = {
      account: fm.account ?? null,
      assetClass: fm.assetClass ?? null,
      name: fm.name,
      ticker: fm.ticker || null,
      isCashLike: fm.isCashLike === true,
      // qty(2026-09-06 추가) — 외화 RP처럼 NH API로 조회 불가해 오너가 수동 갱신하는
      // 보유값을 실행 잡이 예수금 계산에 참고할 수 있게(execute-asset-allocation-
      // proposal.mjs의 해외주식 가용현금 계산 참고). 다른 소비처엔 영향 없음(기존
      // 필드는 그대로).
      qty: Number.isFinite(fm.qty) ? fm.qty : null,
      // bondCode(2026-09-06 추가) — 직접채권(삼척블루파워12 등) 전용 NH krbond
      // 종목코드. ticker와 일부러 분리한 필드: ticker는 krstock 도메인(6자리 KR
      // 코드) 전용이라 채권 코드(예: "B150351F4", 9자리 영숫자)를 거기 섞으면 이
      // 라우터가 krstock으로 잘못 라우팅해 엉뚱한 API 도메인으로 주문을 낼 위험이
      // 있다. update-holdings-prices.mjs가 NH 채권 잔고조회로 채워둔다.
      bondCode: fm.bondCode || null,
    };
    const existing = index.get(key);
    // 같은 이름이 서로 다른 계좌에 보유돼 있으면(예: 같은 ETF를 위탁·연금저축 양쪽에
    // 보유 — 자산분배 트랙 특성상 실제로 가능) 어느 계좌 소속인지 추정하지 않는다
    // (2026-09-06 코드리뷰 MEDIUM 지적 — 마지막에 읽힌 파일이 조용히 이겨서 엉뚱한
    // 계좌로 실주문이 나갈 위험이 있었다). ambiguousAccounts를 표시해두면 분류기가
    // UNSUPPORTED로 처리한다(nh-accounts.mjs의 마스킹 충돌 가드와 동일 원칙).
    if (existing && existing.account !== record.account && !existing.ambiguousAccounts) {
      index.set(key, { ...record, ambiguousAccounts: [existing.account, record.account] });
      continue;
    }
    index.set(key, record);
  }
  return index;
}

// 순수함수(테스트 가능) — assetKey(종목명 또는 코드) → 분류 결과.
// holdingsIndex: buildHoldingsIndex() 결과(호출측 주입, 이 함수는 fs를 안 만짐).
// registry: stock-registry.mjs의 getCodeRegistry() 결과(resolveCanonicalStockName용).
// krStockCodeFn/usTickerFn: 기본은 instruments.mjs 실구현(DART/KIS 마스터파일 조회,
// 네트워크·디스크 I/O 있음) — 테스트에서 고정 응답으로 주입해 네트워크 없이 검증한다.
export function classifyAssetAllocationInstrument({
  assetKey, holdingsIndex, registry = getCodeRegistry(), dartApiKey,
  krStockCodeFn = krStockCode, usTickerFn = usTicker,
}) {
  const trimmedKey = String(assetKey ?? '').trim();
  const canonicalName = resolveCanonicalStockName(trimmedKey, registry);
  const holding = holdingsIndex.get(canonName(canonicalName)) ?? holdingsIndex.get(canonName(trimmedKey));

  if (holding) {
    // 같은 이름이 여러 계좌에 걸쳐 있어 어느 계좌 소속인지 추정 불가한 경우(위
    // buildHoldingsIndex 주석 참고) — 가장 먼저 확인해 아래 어떤 분기로도 안 새게 한다.
    if (holding.ambiguousAccounts) {
      return {
        type: INSTRUMENT_TYPE.UNSUPPORTED,
        reason: `같은 이름이 여러 계좌(${holding.ambiguousAccounts.join('·')})에 보유돼 있어 계좌를 추정하지 않음 — 수동 확인 필요`,
      };
    }
    // 달러(외화 RP·예수금) 먼저 확인 — 외화 RP도 isCashLike:true라 아래 일반
    // 현금성 자산 분기보다 먼저 걸지 않으면 더 구체적인 사유(자동스윕)가 아니라
    // 뭉뚱그린 "현금성 자산" 사유로 가려진다.
    if (holding.assetClass === '달러') {
      return {
        type: INSTRUMENT_TYPE.UNSUPPORTED,
        reason: '외화 RP/예수금 — NH 자동스윕 대상(오너 확인 2026-09-05), 별도 주문 없음(환전 주문 API 자체도 없음)',
      };
    }
    if (holding.isCashLike || holding.assetClass === '현금') {
      return { type: INSTRUMENT_TYPE.UNSUPPORTED, reason: `현금성 자산(${holding.assetClass ?? '현금'}) — 주문 대상 아님` };
    }
    // 실물금은 account==="금현물"이고 그 표시명이 실측 확인된 상품일 때만 — 파일
    // 헤더 주석의 "금 자산군 함정" 참고. 이름까지 확인하는 이유는 KNOWN_PHYSICAL_
    // GOLD_NAMES 선언부 주석 참고(계좌·자산군만으로는 금1kg·미니금100g 구분 불가).
    if (holding.assetClass === '금' && holding.account === '금현물') {
      if (!KNOWN_PHYSICAL_GOLD_NAMES.has(holding.name)) {
        return {
          type: INSTRUMENT_TYPE.UNSUPPORTED,
          reason: `금현물 계좌의 알 수 없는 실물금 상품명(${holding.name}) — iemCd 추정 안 함, 확인 후 코드 갱신 필요`,
        };
      }
      return {
        type: INSTRUMENT_TYPE.GOLD, iemCd: PHYSICAL_GOLD_IEM_CD,
        nhAccountLabel: '금현물', resolvedName: holding.name,
      };
    }
    if (holding.assetClass === '해외주식') {
      const iemCd = LOOKS_LIKE_TICKER.test(trimmedKey) ? trimmedKey : usTickerFn(holding.name);
      if (!iemCd) return { type: INSTRUMENT_TYPE.UNSUPPORTED, reason: `해외주식 티커 해석 실패(추측 금지): ${holding.name}` };
      return { type: INSTRUMENT_TYPE.OVERSEAS_STOCK, iemCd, nhAccountLabel: holding.account, resolvedName: holding.name };
    }
    // 채권(2026-09-06 확장, 오너 지시 — "장내채권도 주문 넣을 수 있게") — ETF(예:
    // KODEX CD금리액티브(합성))와 직접채권(삼척블루파워12 등) 두 갈래가 같은
    // assetClass를 쓴다. ETF는 krStockCodeFn으로 정상 해석되니 먼저 시도하고,
    // 실패하면 bondCode(update-holdings-prices.mjs가 NH krbond 잔고조회로 채워둠)로
    // 직접채권 여부를 확인한다 — 이 순서를 바꾸면 ETF가 잘못 KR_BOND로 갈 위험이 있다.
    if (holding.assetClass === '채권') {
      const etfCode = holding.ticker || krStockCodeFn(holding.name, dartApiKey);
      if (etfCode) return { type: INSTRUMENT_TYPE.KR_STOCK, iemCd: etfCode, nhAccountLabel: holding.account, resolvedName: holding.name };
      if (holding.bondCode) {
        return { type: INSTRUMENT_TYPE.KR_BOND, iemCd: holding.bondCode, nhAccountLabel: holding.account, resolvedName: holding.name };
      }
      return {
        type: INSTRUMENT_TYPE.UNSUPPORTED,
        reason: `직접채권으로 추정되나 종목코드 미확인(가격갱신 잡이 아직 못 채움) — 추측 금지: ${holding.name}`,
      };
    }
    // 국내주식·리츠·배당주·TDF·금(ETF, 금현물 계좌 아님) 등 — 전부 krstock.
    const iemCd = holding.ticker || krStockCodeFn(holding.name, dartApiKey);
    if (!iemCd) {
      return {
        type: INSTRUMENT_TYPE.UNSUPPORTED,
        reason: `국내 종목코드 해석 실패(마스터파일 미등재) — 추측 금지: ${holding.name}`,
      };
    }
    return { type: INSTRUMENT_TYPE.KR_STOCK, iemCd, nhAccountLabel: holding.account, resolvedName: holding.name };
  }

  // Holdings에 없음(미보유 신규 매수) — assetClass 힌트가 없어 code/name 해석기로
  // 직접 판별. 국내 먼저(자산분배 신규매수 대다수가 KODEX/TIGER 등 국내 ETF) 시도,
  // 실패하면 해외, 둘 다 실패하면 UNSUPPORTED(추측 금지). nhAccountLabel은 위탁
  // 기본값(신규 매수는 연금저축이 아닌 위탁을 거치는 이 프로젝트 관례 — 실행 잡이
  // 허용 계좌 집합으로 다시 한번 확인하므로 여기서 틀려도 안전하게 걸러진다).
  const krCode = krStockCodeFn(canonicalName, dartApiKey);
  if (krCode) return { type: INSTRUMENT_TYPE.KR_STOCK, iemCd: krCode, nhAccountLabel: '위탁', resolvedName: canonicalName };
  const usCode = LOOKS_LIKE_TICKER.test(trimmedKey) ? trimmedKey : usTickerFn(canonicalName);
  if (usCode) return { type: INSTRUMENT_TYPE.OVERSEAS_STOCK, iemCd: usCode, nhAccountLabel: '위탁', resolvedName: canonicalName };
  return {
    type: INSTRUMENT_TYPE.UNSUPPORTED,
    reason: `미보유 신규종목이라 State/Holdings 힌트 없음 + code/name 자동해석 실패(추측 금지): ${trimmedKey}`,
  };
}
