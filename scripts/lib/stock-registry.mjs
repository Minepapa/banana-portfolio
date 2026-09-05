// 종목 식별 정규화 registry(2026-09-05 신설) — 같은 종목이 상황에 따라 종목코드로
// 기록되기도 하고 종목명으로 기록되기도 하며, 종목명 자체도 표기가 갈라지는 문제를
// 해결한다(오너 지적: "퀀트 계좌에서 종목명으로 기록되기도 하고 종목코드로 기록되기도
// 하고, 같은 증권사인데 표기에 따라 다르게 종목명이 적히기도"). vault-tags.mjs의
// 종목 태그(`종목/...`)가 이 모듈을 거쳐 여러 표기를 하나의 표준 이름으로 묶는다.
//
// 두 레이어로 나눈 이유:
// ① **code 레지스트리(자동)** — 같은 code가 실제로 두 레코드에 공통으로 있으면
//    안전하게 병합할 수 있다(code는 사실 기반 링크, 추정이 아님). State/Holdings의
//    ticker(KIS로 검증된 값)를 최우선 소스로, Facts/Ledger/Executions의 stockCode
//    (값이 있는 것만, 청산돼 Holdings엔 이미 없는 과거 보유까지 보강)로 넓힌다.
//    실측: 퀀트 트랙 제안(Decisions/Proposals)이 "017670"(코드)만 남기는데, 같은
//    코드의 Executions 체결 기록엔 stockCode="017670"+stockName="SK텔레콤"이 실제로
//    같이 있어(watch-order-fill.mjs가 체결 시점엔 이름도 함께 기록) 이 레이어만으로
//    코드→이름 해결이 된다 — 퀀트가 Holdings를 안 쓰는(계좌분리 원칙, account-
//    resolver.mjs 참고) 것과 무관하게 작동.
// ② **수동 별칭표** — code가 어디에도 안 남는 이름 파편화(예: 카카오 알림의 정식
//    장문명 vs 짧은 표시명)는 code로 이을 방법이 없다 — 다른 이름끼리 함부로
//    유사도로 추정 병합하면 실제로 다른 증권(우선주 vs 보통주 등)을 잘못 합칠
//    위험이 있어(vault-tags.mjs 기존 원칙과 동일 이유), stock-aliases.mjs에 실제
//    확인된 표기만 수동으로 채운다.
//
// 매칭 실패 시(둘 다 못 찾으면) raw를 그대로 반환 — 병합 안 해도 최소한 지금처럼
// 작동하는 안전한 폴백이지, 틀린 병합보다 항상 안전.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from './vault-paths.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { canonCode, canonName } from '../../src/lib/stockIdentity.js';
import { MANUAL_STOCK_ALIASES } from './stock-aliases.mjs';

function readDirSafe(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

// 순수함수화 어려운 부분(파일 I/O)만 분리 — 테스트는 이 함수에 임시 디렉터리를
// 주입해서 검증한다(다른 이 코드베이스 백필 스크립트들과 동일 관례).
export function buildCodeRegistry({
  holdingsDir = VAULT_PATHS.state.holdings,
  executionsDir = VAULT_PATHS.facts.ledger.executions,
} = {}) {
  const registry = new Map(); // canonCode(code) → 표준 표시명

  // State/Holdings가 최우선(KIS 잔고조회로 검증된 현재값, 상품명 개정도 여기 반영됨).
  for (const f of readDirSafe(holdingsDir)) {
    const fm = parseFrontmatter(readFileSync(join(holdingsDir, f), 'utf8'));
    const code = canonCode(fm.ticker);
    if (code && fm.name) registry.set(code, fm.name);
  }
  // Executions로 보강 — Holdings에 이미 없는 code만(청산된 과거 보유, 또는 애초에
  // Holdings에 안 쓰는 계좌인 퀀트 트랙 등).
  for (const f of readDirSafe(executionsDir)) {
    const fm = parseFrontmatter(readFileSync(join(executionsDir, f), 'utf8'));
    const code = canonCode(fm.stockCode);
    if (code && fm.stockName && !registry.has(code)) registry.set(code, fm.stockName);
  }
  return registry;
}

// 프로세스 생애 동안 1회만 스캔(이 코드베이스의 모든 잡이 짧은 1회성 프로세스라
// "프로세스당 1회 캐시"가 곧 "잡 실행당 1회 스캔"과 같다 — 매 태그 계산마다 디스크를
// 다시 훑지 않는다). resetCodeRegistryCache는 테스트 전용.
let cachedRegistry = null;
export function getCodeRegistry() {
  if (!cachedRegistry) cachedRegistry = buildCodeRegistry();
  return cachedRegistry;
}
export function resetCodeRegistryCache() {
  cachedRegistry = null;
}

// 순수함수(테스트 가능) — raw(종목명 또는 종목코드)를 표준 표시명으로 정규화.
// 우선순위: ①수동 별칭표(정확 일치) ②code 레지스트리(raw가 code면 그 code의
// 표준명) ③매칭 실패 시 raw 그대로.
export function resolveCanonicalStockName(raw, registry = getCodeRegistry()) {
  if (!raw) return raw;
  const aliased = MANUAL_STOCK_ALIASES.get(canonName(raw));
  if (aliased) return aliased;
  const byCode = registry.get(canonCode(raw));
  if (byCode) return byCode;
  return raw;
}
