// State/Holdings 라이브 레코드 빌더 — 순수 함수(구현계획서 Phase 8).
// migration-vault-writer.mjs의 buildMigratedHoldingRecord와 다른 점: 시트 행번호가
// 없다(더 이상 시트에서 옮기는 게 아니라 체결로부터 직접 계산된 "지금 상태"). 파일명이
// `계좌-종목명.md`로 고정이라 holdings-updater.mjs가 같은 (계좌,종목)을 항상 같은
// 파일로 수렴시킨다 — Phase 7의 로트유실 사고(계좌-종목명만으로 지었다가 여러 로트가
// 있던 마이그레이션 데이터가 서로 덮어쓴 사고)와는 성격이 다르다: 여기선 애초에
// "같은 파일로 합쳐지는 게 맞는 설계"(가중평균 갱신)이므로 안전하다.
import { buildFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-') || '_';
}

export function holdingFilename(account, name) {
  return `${sanitizeSegment(account)}-${sanitizeSegment(name)}.md`;
}

export function buildLiveHoldingRecord(holding) {
  const content = buildFrontmatter({
    type: 'holding',
    account: holding.account, assetClass: holding.assetClass ?? '', name: holding.name,
    ticker: holding.ticker ?? '', market: holding.market ?? '',
    avgPrice: holding.avgPrice, qty: holding.qty, invest: holding.invest,
    curPrice: holding.curPrice ?? null, evalAmount: holding.evalAmount ?? null,
    profitAmount: holding.profitAmount ?? null, profitPct: holding.profitPct ?? null,
    isCashLike: holding.isCashLike ?? false,
    // 이 보유에 이미 반영된 체결의 dedupKey 목록(JSON 배열 문자열 — frontmatter는 평평한
    // 스칼라만 지원해 배열을 직접 못 담음, riskMonitor의 evidence 필드 등과 동일 관례).
    // update-holdings-from-executions.mjs가 같은 체결을 재처리할 때(holdingsApplied 플래그
    // 기록이 중간에 실패해도) 여기서 한 번 더 idempotent하게 걸러낸다 — 코드리뷰 지적,
    // 2026-08-05: 파일쓰기 성공 후 플래그쓰기가 실패하면 다음 실행에서 같은 체결이
    // 다시 적용돼 수량이 두 번 반영되는 문제가 있었음.
    appliedDedupKeys: JSON.stringify(holding.appliedDedupKeys ?? []),
    updatedAt: new Date().toISOString(),
  });
  return { filename: holdingFilename(holding.account, holding.name), content, dir: VAULT_PATHS.state.holdings };
}

// State/Holdings 파일에서 읽은 프론트매터의 appliedDedupKeys(JSON 문자열)를 배열로
// 안전하게 되돌린다 — 필드가 없거나(마이그레이션 레코드) 파싱 실패해도 빈 배열.
export function parseAppliedDedupKeys(holdingFrontmatter) {
  try {
    const parsed = JSON.parse(holdingFrontmatter?.appliedDedupKeys ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 계좌별 현금(예수금) 잔고 — State/Holdings에 종목 보유와 같은 방식(같은 디렉터리,
// 같은 파일명 관례)으로 저장한다(2026-08-18, 예수금앵커 배선 — update-cash-from-ledger.mjs
// 가 호출). name="예수금"·isCashLike=true는 v1부터 이어진 관례 그대로 따른다 — 기존
// isCashLike 소비처(order-candidates.mjs·realtime-quotes.mjs·sync-position-journal.mjs
// 등)가 전부 이 이름·플래그로 예수금 행을 걸러내므로, 새 스키마를 만들지 않고 그 관례에
// 맞춘다(1주=1원 취급: avgPrice=1·curPrice=1, qty=invest=evalAmount=잔고).
//
// buildLiveHoldingRecord와 달리 appliedDedupKeys(증분 반영 방어)가 없다 — 종목 보유는
// 체결을 하나씩 누적 반영하지만, 예수금은 매 실행마다 기준점+델타를 처음부터 다시
// 계산해 전체를 덮어쓴다(cash-ledger.mjs). 같은 입력이면 항상 같은 출력이 나오는 순수
// 재계산이라 "체결이 두 번 반영되는" 사고 클래스 자체가 성립하지 않는다.
export function buildCashHoldingRecord(cash) {
  const content = buildFrontmatter({
    type: 'holding', account: cash.account, assetClass: '현금', name: '예수금',
    ticker: '', market: '',
    avgPrice: 1, qty: cash.balance, invest: cash.balance,
    curPrice: 1, evalAmount: cash.balance, profitAmount: 0, profitPct: 0,
    isCashLike: true,
    // 예수금 전용 감사 필드 — 종목 보유엔 없는 정보(어떤 기준점+델타로 이 값이 나왔는지
    // 보존, cash-ledger.mjs resolveCashAnchor 참고).
    anchorBase: cash.anchorBase ?? null, anchorTs: cash.anchorTs ?? '', anchorSource: cash.anchorSource ?? '',
    raw: cash.raw ?? cash.balance, negative: cash.negative ?? false,
    updatedAt: new Date().toISOString(),
  });
  return { filename: holdingFilename(cash.account, '예수금'), content, dir: VAULT_PATHS.state.holdings };
}
