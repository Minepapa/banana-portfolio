import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMigratedExecutionRecord, buildMigratedDividendRecord, buildMigratedProfitRecord,
  buildMigratedDailySnapshotRecord, buildMigratedHoldingRecord, buildMigratedAllocationRecord,
  buildMigratedBaselineRecord, buildMigratedEvaluationRecord, buildMigratedPositionJournalRecord,
  buildMigratedRiskMonitorRecord, buildMigratedProposalRecord, buildMigratedReportRecord,
  buildMigratedPreferenceRecord, buildMigratedMonthlyBalanceRecord,
} from './migration-vault-writer.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';

// 모든 빌더가 { filename, content, dir } 형태 + legacy:true + legacySourceRow(있으면 rowNum
// 그대로) + 같은 rowNum 재호출 시 같은 파일명(idempotent)을 지키는지 공통 검증.
function assertLegacyShape(result, rowNum) {
  assert.ok(result.filename.endsWith('.md'));
  assert.ok(result.dir);
  const fm = parseFrontmatter(result.content);
  assert.equal(fm.legacy, true);
  if (rowNum != null) assert.equal(fm.legacySourceRow, rowNum);
}

test('buildMigratedExecutionRecord: CHEOL_COLS 레이아웃(계좌·자산군·수수료·세금·정산금액 포함) 그대로 반영', () => {
  const row = ['2025-03-10', '매수', '위탁', '005930', '국내주식', '삼성전자', 70000, 10, 700000, 71000, 350, 0, 700350];
  const r = buildMigratedExecutionRecord(row, 5);
  assertLegacyShape(r, 5);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.account, '위탁');
  assert.equal(fm.assetClass, '국내주식');
  assert.equal(fm.fee, 350);
  assert.equal(fm.tax, 0);
  assert.equal(fm.settlementAmount, 700350);
  assert.equal(r.dir, VAULT_PATHS.facts.ledger.executions);
});

test('buildMigratedExecutionRecord: 콤마 포함 문자열 셀("700,000")도 정상 숫자로 파싱 — 2026-08-05 실사고 회귀방지', () => {
  // 구글시트에서 읽은 숫자 셀은 실제로 "700,000" 같은 콤마 포함 문자열로 온다.
  // Number("700,000")은 NaN이고, 예전 코드는 `Number(x) || 0`이라 조용히 0이 됐었다
  // (위탁 삼성전자 투자금액·평가액이 전부 0으로 마이그레이션된 실제 사고).
  const row = ['2025-03-10', '매수', '위탁', '005930', '국내주식', '삼성전자',
    '70,000', '10', '700,000', '71,000', '350', '0', '700,350'];
  const fm = parseFrontmatter(buildMigratedExecutionRecord(row, 5).content);
  assert.equal(fm.price, 70000);
  assert.equal(fm.amount, 700000);
  assert.equal(fm.settlementAmount, 700350);
});

test('buildMigratedHoldingRecord: 콤마 포함 문자열 필드도 정상 숫자로 파싱', () => {
  const holding = { account: '위탁', type: '국내주식', name: '삼성전자', price: '50,450', qty: '40', invest: '2,018,000', currentPrice: '247,750', profit: '7,892,000', eval: '9,910,000', rate: '391.1%', isCashLike: false };
  const fm = parseFrontmatter(buildMigratedHoldingRecord(holding, 15).content);
  assert.equal(fm.avgPrice, 50450);
  assert.equal(fm.invest, 2018000);
  assert.equal(fm.evalAmount, 9910000);
  assert.equal(fm.profitPct, 391.1);
});

test('buildMigratedExecutionRecord: 같은 rowNum 재호출 시 같은 파일명(idempotent)', () => {
  const row = ['2025-03-10', '매수', '위탁', '005930', '국내주식', '삼성전자', 70000, 10, 700000, 71000, 350, 0, 700350];
  assert.equal(buildMigratedExecutionRecord(row, 5).filename, buildMigratedExecutionRecord(row, 5).filename);
});

test('buildMigratedDividendRecord: 계좌 정보 없음(v1 배당금 시트 자체에 없음) → account null', () => {
  const r = buildMigratedDividendRecord(['2025-04-01', 12345, '삼성전자'], 3);
  assertLegacyShape(r, 3);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.afterTaxAmount, 12345);
  assert.equal(fm.account, null);
  assert.equal(r.dir, VAULT_PATHS.facts.ledger.dividends);
});

test('buildMigratedProfitRecord: 수익금 6열 매핑', () => {
  const r = buildMigratedProfitRecord(['2025-05-01', 'SK하이닉스', 5, 100000, 120000, 100000], 8);
  assertLegacyShape(r, 8);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.buyPrice, 100000);
  assert.equal(fm.sellPrice, 120000);
  assert.equal(fm.profit, 100000);
  assert.equal(r.dir, VAULT_PATHS.facts.ledger.profits);
});

test('buildMigratedDailySnapshotRecord: JSON 문자열 필드는 재파싱 없이 그대로 보존', () => {
  const byAccount = '{"위탁":1000000}';
  const r = buildMigratedDailySnapshotRecord(['2025-06-01', '2025-06-01 08:00', 5000000, byAccount, '{}'], 12);
  assertLegacyShape(r, 12);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.byAccountJson, byAccount);
  assert.equal(r.dir, VAULT_PATHS.facts.ledger.dailySnapshots);
});

// 2026-08-21 — v1→v2 전수감사에서 새로 발견돼 이관된 시트("월별잔고"). Phase 7의
// 다른 12종과 달리 legacySourceRow 재실행 시 파일명이 시트 행번호가 아니라 연-월
// 자체다(migration-vault-writer.mjs 주석 참고, 한 달에 한 행만 있다는 시트 전제).
test('buildMigratedMonthlyBalanceRecord: 연-월-계좌별잔고-총잔고-지수 10열 매핑', () => {
  const row = ['2025년', '4월', '3,000,000', '543,000', '13,498,868', '42,874,963', '1,000,000', '57,916,831', '2557', '5569'];
  const r = buildMigratedMonthlyBalanceRecord(row, 2);
  assertLegacyShape(r, 2);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.year, 2025);
  assert.equal(fm.month, 4);
  assert.equal(fm.ym, 202504);
  assert.equal(fm.deposit, 3000000);
  assert.equal(fm.isa, 543000);
  assert.equal(fm.wita, 13498868);
  assert.equal(fm.pension, 42874963);
  assert.equal(fm.irp, 1000000);
  assert.equal(fm.total, 57916831);
  assert.equal(fm.kospiIndex, 2557);
  assert.equal(fm.spIndex, 5569);
  assert.equal(r.dir, VAULT_PATHS.facts.ledger.monthlyBalances);
});

test('buildMigratedMonthlyBalanceRecord: 파일명은 연-월(시트 행번호 아님, 한 달=한 행 전제)', () => {
  const row = ['2026년', '8월', '', '32,047,756', '122,596,225', '66,987,014', '4,959,536', '226,590,531'];
  const r = buildMigratedMonthlyBalanceRecord(row, 18);
  assert.equal(r.filename, '2026-08.md');
});

test('buildMigratedMonthlyBalanceRecord: 지수 열(I·J)이 없는 행도 실패하지 않고 0으로', () => {
  const row = ['2026년', '6월', '8,366,100', '31,993,875', '128,439,621', '69,310,460', '4,771,225', '234,515,181'];
  const r = buildMigratedMonthlyBalanceRecord(row, 16);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.kospiIndex, 0);
  assert.equal(fm.spIndex, 0);
  assert.equal(fm.total, 234515181);
});

test('buildMigratedHoldingRecord: 티커·시장은 v1에 없어 빈 값(가공 안 함, 정직하게 빈 값)', () => {
  const holding = { account: '위탁', type: '국내주식', name: '삼성전자', price: 70000, qty: 10, invest: 700000, currentPrice: 75000, profit: 50000, eval: 750000, rate: 7.14, isCashLike: false };
  const r = buildMigratedHoldingRecord(holding, 15);
  assertLegacyShape(r, 15);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.ticker, '');
  assert.equal(fm.evalAmount, 750000);
  assert.equal(r.dir, VAULT_PATHS.state.holdings);
});

test('buildMigratedHoldingRecord: 같은 rowNum 재호출 시 같은 파일명(idempotent — 재실행 시 덮어쓰기)', () => {
  const h = { account: '위탁', type: '국내주식', name: '삼성전자', price: 1, qty: 1, invest: 1, currentPrice: 1, profit: 0, eval: 1, rate: 0, isCashLike: false };
  assert.equal(buildMigratedHoldingRecord(h, 15).filename, buildMigratedHoldingRecord({ ...h, qty: 99 }, 15).filename);
});

test('buildMigratedHoldingRecord: 같은 계좌+종목명이라도 rowNum이 다르면 다른 파일(같은 종목 여러 매입 로트 보존)', () => {
  // 2026-08-05 실사고 재현: 위탁 삼성전자가 40주@50,450원 + 30주@54,700원 두 로트로
  // 각각 다른 행에 있었는데, 처음엔 계좌+이름만 파일명으로 써서 한 로트가 사라졌다.
  const lot1 = { account: '위탁', type: '국내주식', name: '삼성전자', price: 50450, qty: 40, invest: 2018000, currentPrice: 247750, profit: 7892000, eval: 9910000, rate: 391.1, isCashLike: false };
  const lot2 = { account: '위탁', type: '국내주식', name: '삼성전자', price: 54700, qty: 30, invest: 1641000, currentPrice: 247750, profit: 5791500, eval: 7432500, rate: 352.9, isCashLike: false };
  const r1 = buildMigratedHoldingRecord(lot1, 15);
  const r2 = buildMigratedHoldingRecord(lot2, 16);
  assert.notEqual(r1.filename, r2.filename);
});

test('buildMigratedAllocationRecord: 계좌×자산군 조합 필드', () => {
  const r = buildMigratedAllocationRecord({ account: '위탁', assetName: '국내주식', target: 30, current: 28.5, rebalAmt: 150000 });
  assertLegacyShape(r, null);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.targetPct, 30);
  assert.equal(fm.currentPct, 28.5);
  assert.equal(r.dir, VAULT_PATHS.state.allocation);
});

test('buildMigratedBaselineRecord: 실제 11열(PBR 포함) 레이아웃 — writer(backfill-baselines) 기준', () => {
  const row = ['삼성전자', '005930', 'KR', '2025-06-30', '38.5%', '15.2%', '9.8%', '45%', '5200', '1.2', '비고텍스트'];
  const r = buildMigratedBaselineRecord(row);
  assertLegacyShape(r, null);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.pbr, '1.2');
  assert.equal(fm.note, '비고텍스트');
  assert.equal(r.dir, VAULT_PATHS.state.baselines);
});

test('buildMigratedEvaluationRecord: axisItems JSON은 재파싱 없이 원문 그대로', () => {
  const axisItemsJson = '{"수익성":[{"label":"ROE"}]}';
  const row = ['2025-01-01', '삼성전자', '005930', 'KR', '🟢 유효', '🟢', '🟢', '🟡', '🟢', '🟡',
    '1) 이유1 2) 이유2', '1) 위험1', '1) 액션1', '메모', '매수', '2025-01-02', '70000', '12개월', '15%', 'AI메모', axisItemsJson];
  const r = buildMigratedEvaluationRecord(row, 20);
  assertLegacyShape(r, 20);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.axisItemsJson, axisItemsJson);
  assert.equal(fm.conclusion, '🟢 유효');
  assert.equal(r.dir, VAULT_PATHS.decisions.evaluations);
});

test('buildMigratedPositionJournalRecord: JOURNAL_COL 16열 매핑', () => {
  const row = ['삼성전자', '005930', 'KR', '위탁', '확신', '반도체 사이클', '90000', '60000 이탈', '12개월',
    '2025-01-02', '보유', '', '', '', '확인', '2025-01-02'];
  const r = buildMigratedPositionJournalRecord(row, 7);
  assertLegacyShape(r, 7);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.status, '보유');
  assert.equal(fm.thesis, '반도체 사이클');
  assert.equal(r.dir, VAULT_PATHS.decisions.positionJournal);
});

test('buildMigratedPositionJournalRecord: 상태 없으면 "보유" 기본값', () => {
  const row = ['삼성전자', '', '', '위탁', '', '', '', '', '', '', '', '', '', '', '', ''];
  const fm = parseFrontmatter(buildMigratedPositionJournalRecord(row, 1).content);
  assert.equal(fm.status, '보유');
});

test('buildMigratedRiskMonitorRecord: RISK_COL 8열 매핑', () => {
  const row = ['2025-02-01', 'B', '삼성전자', '🟡', '요약', '상세', '{"foo":1}', '기준선ref'];
  const r = buildMigratedRiskMonitorRecord(row, 4);
  assertLegacyShape(r, 4);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.riskType, 'B');
  assert.equal(fm.signal, '🟡');
  assert.equal(r.dir, VAULT_PATHS.decisions.riskMonitor);
});

test('buildMigratedProposalRecord: 원본 필드 그대로 아카이브(v2 스키마로 강제변환 안 함) — 오너 확정', () => {
  const row = ['2025-01-01', '리밸런싱', '위탁', '매수', '삼성전자', 10, 70000, 700000,
    '{"text":"근거"}', '[]', '승인', '2025-01-01', '', 'k1'];
  const r = buildMigratedProposalRecord(row, 2);
  assertLegacyShape(r, 2);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.type, 'legacy-proposal');
  assert.equal(fm.source, '리밸런싱');
  assert.equal(fm.matchKey, 'k1');
  // 파일명이 legacy- 접두사라 새 Proposal 스키마(id={track}-{side}-{assetKey}-{ts})와 절대 안 겹침
  assert.ok(r.filename.startsWith('legacy-'));
  assert.equal(r.dir, VAULT_PATHS.decisions.proposals);
});

test('buildMigratedReportRecord: 주간리포트 3열', () => {
  const r = buildMigratedReportRecord(['2025-01-05', '요약텍스트', '본문텍스트'], 1);
  assertLegacyShape(r, 1);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.summary, '요약텍스트');
  assert.equal(r.dir, VAULT_PATHS.knowledge.reports);
});

test('buildMigratedPreferenceRecord: 성향관찰 8열, 상태 없으면 "관찰" 기본값', () => {
  const r = buildMigratedPreferenceRecord(['2025-01-05', '매수과열', '관찰내용', '증거', '일치', '높음', '', '2025-01-06'], 6);
  assertLegacyShape(r, 6);
  const fm = parseFrontmatter(r.content);
  assert.equal(fm.status, '관찰');
  assert.equal(r.dir, VAULT_PATHS.knowledge.profile);
});
