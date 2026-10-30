import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMerchantIndex, cardCandidates, categoryFor, fixedCostCandidates, normalizeMerchant,
  readBanksaladTransactions } from './spending-tables.mjs';

const row = (date, description, amount, instrument = '가상카드', category = '식비', subcategory = '한식') => ({
  date, description, signed_amount: String(-amount), payment_instrument: instrument, classification: 'expense',
  original_category: category, original_subcategory: subcategory });

test('가맹점 이름의 자동납부·법인 표기·공백을 지우고 같음·포함으로 항목을 찾는다', () => {
  assert.equal(normalizeMerchant('SK텔레콤(자동납부)'), normalizeMerchant('SK텔레콤'));
  assert.equal(normalizeMerchant('현대오일뱅크(주)직영 송도'), '현대오일뱅크직영송도');
  const index = buildMerchantIndex([row('2026-09-01', 'KT통신요금 자동납부', 1, 'x', '주거/통신', '휴대폰'),
    row('2026-09-02', '당근문구', 1, 'x', '카페/간식', '간식'), row('2026-09-03', '당근문구', 1, 'x', '카페/간식', '간식'),
    row('2026-09-04', '당근문구', 1, 'x', '경조/선물', '선물')]);
  // 대분류 이름에 /가 있어도 대분류·소분류가 갈리지 않는다.
  assert.deepEqual(categoryFor('KT통신요금', index), { category: '주거/통신', subcategory: '휴대폰', count: 1, share: 1, via: 'exact' });
  assert.equal(categoryFor('당근문구', index).share, 0.67);
  assert.equal(categoryFor('당근문구 송도점', index).via, 'partial');
  assert.equal(categoryFor('나이스인프라', index), null);
  assert.equal(categoryFor('나이스인프라', index, { [normalizeMerchant('나이스인프라')]: { category: '자동차', subcategory: '주차' } }).via, 'owner');
  // 2자 이름은 포함 일치를 하지 않는다(우연 일치).
  assert.equal(categoryFor('KT', index), null);
});

test('카드 표는 같은 날(±1일)·같은 금액 거래가 2건 이상이고 과반일 때만 결제수단을 낸다', () => {
  const transactions = [row('2026-10-12', 'a', 1000, '삼성 SFC'), row('2026-10-13', 'b', 2000, '삼성 SFC'),
    row('2026-10-14', 'c', 3000, '하나 BESTSHOP')];
  const alert = (at, amount, card, cardMask) => ({ at, amount, card, cardMask, status: 'expense' });
  const cards = cardCandidates([alert('2026-10-12T03:00:00Z', 1000, '삼성', '3663'), alert('2026-10-14T03:00:00Z', 2000, '삼성', '3663'),
    alert('2026-10-14T03:00:00Z', 3000, '하나', '5*6*'), { ...alert('2026-10-14T03:00:00Z', 3000, '하나', '5*6*'), status: 'pending' }], transactions);
  assert.deepEqual(cards.map(({ key, alerts, instrument }) => [key, alerts, instrument]), [
    ['삼성|3663', 2, '삼성 SFC'], ['하나|5*6*', 1, null]]);
  // 같은 날 같은 금액을 두 번 쓴 거래가 있어도 알림 한 건은 한 표다.
  const twice = cardCandidates([alert('2026-10-12T03:00:00Z', 4500, '하나', '5*8*')],
    [row('2026-10-12', '카페', 4500, '하나 MG'), row('2026-10-12', '카페', 4500, '하나 MG')]);
  assert.equal(twice[0].instrument, null);
  // 시각이 깨진 알림은 건너뛴다.
  assert.deepEqual(cardCandidates([{ ...alert('bad', 1000, '삼성', '3663') }], transactions), []);
});

test('고정비는 여러 달 한 번씩, 결제일·금액이 고른 것만 후보로 낸다', () => {
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
  const transactions = [
    ...months.map((month, index) => row(`${month}-${11 + (index % 3)}`, 'SK텔레콤(자동납부)', 29000 + index * 500, '하나')),
    ...months.map((month) => row(`${month}-05`, '티머니_버스', 1500, 'K-패스')), ...months.map((month) => row(`${month}-20`, '티머니_버스', 1500, 'K-패스')),
    ...months.map((month, index) => row(`${month}-${index % 2 ? 2 : 25}`, '학원', 300000, '카카오')),
    ...months.map((month, index) => row(`${month}-22`, '관리비', index === 2 ? 430000 : 270000, '하나')),
    ...months.slice(0, 3).map((month) => row(`${month}-10`, '구독', 9900, '삼성')),
  ];
  const fixed = fixedCostCandidates(transactions);
  assert.deepEqual(fixed.map(({ merchant, months: count, dayFrom, dayTo, amount }) => [merchant, count, dayFrom, dayTo, amount]),
    [['SK텔레콤(자동납부)', 5, 11, 13, 30000]]);
});

test('가장 늦게 끝나는 내보내기 폴더의 지출 행만 읽는다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spending-tables-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [folder, description] of [['2025-01-01_2025-12-31', '옛것'], ['2025-10-21_2026-10-21', '새것']]) {
    mkdirSync(join(dir, 'Banksalad', folder), { recursive: true });
    writeFileSync(join(dir, 'Banksalad', folder, 'classified-report.json'), JSON.stringify({ transactions: [
      row('2026-10-01', description, 1), { ...row('2026-10-01', '월급', -1), classification: 'income' }] }));
  }
  const result = readBanksaladTransactions(dir);
  assert.equal(result.folder, '2025-10-21_2026-10-21');
  assert.deepEqual(result.transactions.map((item) => item.description), ['새것']);
  assert.deepEqual(readBanksaladTransactions(join(dir, '없음')), { folder: null, transactions: [] });
});

test('고정비: 말일 결제가 1일로 밀려도 같은 무리로 보고, 가끔 한 번 더 나간 달은 그 달만 뺀다', () => {
  const transactions = [row('2026-03-30', '보험', 50000, '삼성'), row('2026-05-01', '보험', 50000, '삼성'),
    row('2026-05-30', '보험', 50000, '삼성'), row('2026-06-29', '보험', 50000, '삼성'),
    row('2026-07-31', '보험', 50000, '삼성'), row('2026-08-30', '보험', 50000, '삼성')];
  const [fixed] = fixedCostCandidates(transactions);
  // 5월은 두 번 나가 그 달만 빠지고, 나머지 4개월로 후보가 된다.
  assert.equal(fixed.merchant, '보험');
  assert.equal(fixed.months, 4);
});
