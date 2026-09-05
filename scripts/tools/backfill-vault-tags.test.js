import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackfillTags, TARGETS } from './backfill-vault-tags.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import {
  buildExecutionRecord, buildCashEventRecord, buildDividendRecord, buildFundPurchaseRecord,
  buildFundValuationRecord, buildExchangeRecord, buildProfitRecord,
} from '../lib/ledger-vault-writer.mjs';
import { buildLiveHoldingRecord, buildCashHoldingRecord } from '../lib/holdings-vault-writer.mjs';
import { buildProposalRecord } from '../lib/proposal-vault.mjs';

function extractFor(name) {
  return TARGETS.find((t) => t.name === name).extract;
}

test('Executions: 계좌·종목 둘 다', () => {
  assert.deepEqual(
    computeBackfillTags({ account: '위탁', stockName: '삼성전자' }, extractFor('Executions')),
    ['계좌/위탁', '종목/삼성전자'],
  );
});

test('CashEvents: 계좌만(종목 없음)', () => {
  assert.deepEqual(computeBackfillTags({ account: 'CMA' }, extractFor('CashEvents')), ['계좌/CMA']);
});

test('Dividends: account가 null이라 종목만', () => {
  assert.deepEqual(
    computeBackfillTags({ account: null, stockName: 'TIGER 미국배당다우존스' }, extractFor('Dividends')),
    ['종목/TIGER-미국배당다우존스'],
  );
});

test('FundPurchases: 계좌·펀드명(종목 축)', () => {
  assert.deepEqual(
    computeBackfillTags({ account: '연금저축', fundName: 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe' }, extractFor('FundPurchases')),
    ['계좌/연금저축', '종목/VIP한국형가치투자증권자투자신탁주식-C-Pe'],
  );
});

test('Profits: 계좌·종목', () => {
  assert.deepEqual(
    computeBackfillTags({ account: '위탁', stockName: '애플' }, extractFor('Profits')),
    ['계좌/위탁', '종목/애플'],
  );
});

test('Holdings: 일반 보유는 계좌·자산군·종목', () => {
  assert.deepEqual(
    computeBackfillTags({ account: '위탁', assetClass: '국내주식', name: '삼성전자', isCashLike: false }, extractFor('Holdings')),
    ['계좌/위탁', '자산군/국내주식', '종목/삼성전자'],
  );
});

test('[예수금 예외] Holdings: isCashLike=true면 종목 태그 없음', () => {
  assert.deepEqual(
    computeBackfillTags({ account: 'CMA', assetClass: '현금', name: '예수금', isCashLike: true }, extractFor('Holdings')),
    ['계좌/CMA', '자산군/현금'],
  );
});

test('Allocation: assetName이 자산군 축으로 매핑', () => {
  assert.deepEqual(
    computeBackfillTags({ account: '위탁', assetName: '국내주식' }, extractFor('Allocation')),
    ['계좌/위탁', '자산군/국내주식'],
  );
});

test('Proposals: account 있으면 그대로', () => {
  assert.deepEqual(
    computeBackfillTags({ account: '위탁', track: '자산분배', assetKey: '테슬라' }, extractFor('Proposals')),
    ['계좌/위탁', '종목/테슬라'],
  );
});

test('[오너 결정 2026-09-05] Proposals: account가 null인 퀀트 제안은 track으로 계좌 축 대체', () => {
  // assetKey는 실제 vault의 code 레지스트리·별칭표와 안 겹치는 값을 씀(2026-09-05
  // stock-registry.mjs 연동 후 — 이 테스트의 관심사는 계좌 축 대체 로직이지 종목명
  // 해석이 아니므로, 실존 종목코드를 쓰면 registry 기본값(실제 Vault 스캔)이 이걸
  // 실제 회사명으로 치환해버려 무관한 이유로 테스트가 깨질 수 있다).
  assert.deepEqual(
    computeBackfillTags({ account: null, track: '퀀트', assetKey: '__테스트종목__' }, extractFor('Proposals')),
    ['계좌/퀀트', '종목/__테스트종목__'],
  );
});

test('Proposals: account도 null이고 track도 퀀트가 아니면(자산분배인데 account 누락) 계좌 축 없음', () => {
  assert.deepEqual(
    computeBackfillTags({ account: null, track: '자산분배', assetKey: '__테스트종목__' }, extractFor('Proposals')),
    ['종목/__테스트종목__'],
  );
});

test('아무 축도 없으면 빈 배열(레거시 등)', () => {
  assert.deepEqual(computeBackfillTags({}, extractFor('CashEvents')), []);
});

// ── 드리프트 가드: 라이브 writer 결과물 ↔ 백필 extract 왕복 일치(2026-09-05 코드리뷰
// MEDIUM 지적) ────────────────────────────────────────────────────────────────
// 이 두 경로(신규 파일을 만드는 라이브 writer, 기존 파일을 고치는 백필)의 필드 매핑이
// 각자 독립적으로 적혀 있어서 한쪽만 바뀌면 조용히 어긋난다 — 실제로 이 정확한 형태로
// Dividends의 지연 계좌귀속 패치가 태그를 재계산 안 해서 57건이 새어나갔다(HIGH 지적).
// 여기서는 "라이브 writer가 만든 레코드를 파싱해서 백필 extract에 그대로 먹였을 때
// 똑같은 태그가 나오는가"를 카테고리마다 검증해 재발을 막는다. Allocation은 별도
// 빌더 함수가 없어(update-allocation-from-holdings.mjs 안에 인라인) 왕복 검증
// 대상에서 뺐다 — 호출 지점이 하나뿐이라 드리프트 위험이 이 정도로 낮음.

test('[드리프트 가드] Executions: 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildExecutionRecord({
    tradeDate: '2026-08-04 09:12:33', tradeType: '매수', stockName: '삼성전자', quantity: 10, price: 71000, currency: 'KRW', broker: 'NH투자증권', account: '위탁',
  });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Executions')), fm.tags);
});

test('[드리프트 가드] CashEvents: 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildCashEventRecord({ account: '위탁', acctNo: '1', balance: 100, ts: '2026-08-18 09:00:00' });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('CashEvents')), fm.tags);
});

test('[드리프트 가드] Dividends: 라이브 writer ↔ 백필 extract 태그 일치(계좌 지연귀속 전 상태)', () => {
  const { content } = buildDividendRecord({
    date: '2026-08-04', afterTaxAmount: 1000, stockName: 'TIGER 리츠부동산인프라', acctRaw: '', broker: 'NH투자증권', receivedTime: '09:00:00', uniqueKey: 'x',
  });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Dividends')), fm.tags);
});

test('[드리프트 가드/HIGH 회귀] Dividends: 계좌 지연귀속 후(account 채워짐) 상태도 백필 extract가 동일 태그 재현', () => {
  const { content } = buildDividendRecord({
    date: '2026-08-04', afterTaxAmount: 1000, stockName: 'TIGER 리츠부동산인프라', acctRaw: '', broker: 'NH투자증권', receivedTime: '09:00:00', uniqueKey: 'x',
  });
  // update-holdings-from-executions.mjs가 나중에 account만 채우고 tags도 같이
  // 재계산하는 패치를 흉내(2026-09-05 수정 후 실제 코드가 하는 것과 동일 형태).
  const patchedFm = { ...parseFrontmatter(content), account: 'ISA' };
  const expectedTags = ['계좌/ISA', '종목/TIGER-리츠부동산인프라'];
  assert.deepEqual(computeBackfillTags(patchedFm, extractFor('Dividends')), expectedTags);
});

test('[드리프트 가드] FundPurchases: 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildFundPurchaseRecord({ fundName: 'VIP한국형가치투자증권투자신탁', amount: 500000, nav: 1523.45, date: '2026-08-04', units: 328.185, account: '연금저축' });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('FundPurchases')), fm.tags);
});

test('[드리프트 가드] FundValuations: 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildFundValuationRecord({
    fundName: 'VIP한국형가치투자증권자투자(주식)-C-Pe', principal: 12800000, valuationAmount: 16582868, profitAmount: 3782868, profitPct: 29.55, date: '2026-09-01', account: '연금저축',
  });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('FundValuations')), fm.tags);
});

test('[드리프트 가드] Profits: 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildProfitRecord({ tradeDate: '2026-08-05 10:00:00', stockName: '삼성전자', quantity: 4, price: 70000, account: '위탁' }, 50000, 80000);
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Profits')), fm.tags);
});

test('[드리프트 가드] Exchanges: 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildExchangeRecord({ kind: '외화매수', usd: 3000, won: 4128000, date: '2026-08-04', account: '위탁' });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Exchanges')), fm.tags);
});

test('[드리프트 가드] Holdings(일반): 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildLiveHoldingRecord({ account: '위탁', assetClass: '국내주식', name: '삼성전자', avgPrice: 1, qty: 1, invest: 1 });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Holdings')), fm.tags);
});

test('[드리프트 가드] Holdings(예수금): 라이브 writer ↔ 백필 extract 태그 일치', () => {
  const { content } = buildCashHoldingRecord({ account: 'CMA', balance: 100 });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Holdings')), fm.tags);
});

test('[드리프트 가드] Proposals: 라이브 writer ↔ 백필 extract 태그 일치(자산분배)', () => {
  const { content } = buildProposalRecord({ track: '자산분배', account: '위탁', assetKey: '테슬라', side: '매도', quantity: 1, proposedPrice: null });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Proposals')), fm.tags);
});

test('[드리프트 가드] Proposals: 라이브 writer ↔ 백필 extract 태그 일치(퀀트, account null)', () => {
  const { content } = buildProposalRecord({ track: '퀀트', assetKey: '삼성전자', side: '매수', quantity: 10, proposedPrice: 71000 });
  const fm = parseFrontmatter(content);
  assert.deepEqual(computeBackfillTags(fm, extractFor('Proposals')), fm.tags);
});
