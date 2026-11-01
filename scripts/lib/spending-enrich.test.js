import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichEntry, enrichmentMtime, loadEnrichment, EMPTY_ENRICHMENT } from './spending-enrich.mjs';

const root = mkdtempSync(join(tmpdir(), 'spending-enrich-'));
after(() => rmSync(root, { recursive: true, force: true }));

function spendingDir(name, { settings, banksalad } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  if (banksalad) {
    const folder = join(dir, 'Banksalad', '2040-01-01_2040-03-31');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'classified-report.json'), JSON.stringify({ transactions: banksalad }));
  }
  return dir;
}

const settings = {
  recipientDecisions: [],
  cardMap: [{ card: '하나', mask: '5*8*', instrument: 'Card A' }, { card: '삼성', mask: '3663', instrument: 'Card S' }],
  fixedCosts: [
    { name: '통신', merchant: 'KT통신요금', instrument: 'Card A', dayFrom: 11, dayTo: 13, variable: true },
    { name: '월말 구독', merchant: '구독서비스', instrument: 'Card S', dayFrom: 28, dayTo: 2, variable: false },
  ],
  merchantCategories: [{ merchant: '주차장 나이스', category: '자동차', subcategory: '주차' }],
};
const banksalad = [
  { description: '강뼈 탕&찜 본점', original_category: '식비', original_subcategory: '한식', classification: 'expense' },
  { description: '강뼈 탕&찜 본점', original_category: '식비', original_subcategory: '한식', classification: 'expense' },
];
// KST 낮 12시
const at = (day) => new Date(Date.parse(`${day}T12:00:00+09:00`)).toISOString();
const entry = (fields) => ({ status: 'expense', amount: 1000, merchant: '가게', card: '하나', cardMask: '5*8*', cardLast4: null,
  at: at('2040-02-12'), ...fields });

test('카드 이름·고정비·분류 짐작을 붙인다', () => {
  const enrichment = loadEnrichment(spendingDir('full', { settings, banksalad }));
  assert.deepEqual(enrichEntry(entry({ merchant: 'KT통신요금' }), enrichment),
    { instrument: 'Card A', fixedCost: '통신', categoryGuess: null });
  // 하나 자동납부 알림은 카드번호가 없다: 카드사가 고정비 카드의 카드사와 같으면 고정비로 본다.
  assert.equal(enrichEntry(entry({ merchant: 'KT통신요금', cardMask: null }), enrichment).fixedCost, '통신');
  assert.equal(enrichEntry(entry({ merchant: 'KT통신요금', cardMask: null }), enrichment).instrument, null);
  assert.equal(enrichEntry(entry({ merchant: 'KT통신요금', at: at('2040-02-20') }), enrichment).fixedCost, '통신',
    '결제일 창 밖이어도 고정비다(날짜는 참고값)');
  assert.equal(enrichEntry(entry({ merchant: 'KT통신요금', card: '삼성', cardMask: null, cardLast4: '3663' }), enrichment).fixedCost, null,
    '다른 카드');
  assert.equal(enrichEntry(entry({ merchant: '구독서비스', card: '삼성', cardMask: null, cardLast4: '3663', at: at('2040-03-01') }),
    enrichment).fixedCost, '월말 구독');
  assert.deepEqual(enrichEntry(entry({ merchant: '강뼈 탕' }), enrichment).categoryGuess,
    { category: '식비', subcategory: '한식', via: 'partial' }, '알림 가맹점 이름이 잘려도 포함으로 찾는다');
  assert.equal(enrichEntry(entry({ merchant: '강뼈' }), enrichment).categoryGuess, null, '두 글자는 우연 일치라 찾지 않는다');
  assert.deepEqual(enrichEntry(entry({ merchant: 'NICE_주차장 나이스' }), enrichment).categoryGuess,
    { category: '자동차', subcategory: '주차', via: 'owner' });
  const short = { ...enrichment, overrides: { ...enrichment.overrides, 강뼈: { category: '식비', subcategory: '한식' } } };
  assert.deepEqual(enrichEntry(entry({ merchant: '강 뼈' }), short).categoryGuess,
    { category: '식비', subcategory: '한식', via: 'owner' }, '짧은 오너 지정은 이름이 똑같으면 쓴다');
  assert.equal(enrichEntry(entry({ merchant: '강뼈집' }), short).categoryGuess, null, '짧은 오너 지정은 포함으로 넓히지 않는다');
  assert.deepEqual(enrichEntry(entry({ status: 'excluded', merchant: 'KT통신요금' }), enrichment),
    { instrument: null, fixedCost: null, categoryGuess: null }, '결제가 아닌 줄은 비운다');
});

test('카드번호가 있는데 표에 없는 카드는 카드사가 같아도 고정비로 보지 않는다', () => {
  const enrichment = loadEnrichment(spendingDir('masked', { settings }));
  assert.equal(enrichEntry(entry({ merchant: 'KT통신요금', cardMask: '1*2*' }), enrichment).fixedCost, null);
  assert.equal(enrichEntry(entry({ merchant: 'KT', cardMask: null }), enrichment).fixedCost, null,
    '짧은 알림 이름이 긴 고정비 키에 들어 있다고 고정비가 되지 않는다(월 점검과 같은 한 방향)');
});

test('설정 칸은 따로 검사해 한 칸이 깨져도 나머지는 쓰고, 무엇이 깨졌는지 남긴다', () => {
  const enrichment = loadEnrichment(spendingDir('one-broken', { settings: { ...settings, fixedCosts: [{ name: '깨짐' }] } }));
  assert.deepEqual(enrichment.problems, ['fixedCosts']);
  assert.equal(enrichEntry(entry({}), enrichment).instrument, 'Card A', '카드 표는 살아 있다');
  assert.equal(enrichEntry(entry({ merchant: 'KT통신요금' }), enrichment).fixedCost, null);
  assert.deepEqual(loadEnrichment(spendingDir('bad-json', { settings: '{' })).problems, ['settings']);
  assert.ok(enrichmentMtime(spendingDir('future', { settings }), 1000) <= 1000, '미래 시각은 지금으로 자른다');
  assert.deepEqual(enrichEntry(entry({}), null), { instrument: null, fixedCost: null, categoryGuess: null });
});

test('설정이 깨졌거나 자료가 없으면 그 칸만 비우고 멈추지 않는다', () => {
  const broken = loadEnrichment(spendingDir('broken', { settings: '{', banksalad }));
  assert.deepEqual(enrichEntry(entry({ merchant: 'KT통신요금' }), broken).instrument, null);
  assert.equal(enrichEntry(entry({ merchant: '강뼈 탕' }), broken).categoryGuess.category, '식비');
  const invalid = loadEnrichment(spendingDir('invalid', { settings: { cardMap: [{ card: '하나' }] } }));
  assert.equal(enrichEntry(entry({}), invalid).instrument, null);
  const none = loadEnrichment(spendingDir('none'));
  assert.deepEqual(enrichEntry(entry({ merchant: '강뼈 탕' }), none), { instrument: null, fixedCost: null, categoryGuess: null });
  assert.deepEqual(enrichEntry(entry({}), EMPTY_ENRICHMENT), { instrument: null, fixedCost: null, categoryGuess: null });
  assert.equal(enrichmentMtime(spendingDir('empty-mtime')), 0);
  assert.ok(enrichmentMtime(spendingDir('with-mtime', { settings, banksalad })) > 0);
});
