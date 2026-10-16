import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VAULT_PATH = mkdtempSync(join(tmpdir(), 'asset-class-test-vault-'));
const { resolveHoldingAssetClass, assetClassTableRows, loadHoldingAssetClassSources, missingAssetClassQuestion } = await import('./holding-asset-class.mjs');
const { applyBuy } = await import('./holdings-updater.mjs');
const { buildLiveHoldingRecord } = await import('./holdings-vault-writer.mjs');
const { parseFrontmatter } = await import('./vault-frontmatter.mjs');
const { buildVaultTags } = await import('./vault-tags.mjs');
const { createWikiQuestion } = await import('./wiki-question-queue.mjs');

const exec = { account: '위탁', stockName: 'KODEX 200', stockCode: '069500', price: 100, quantity: 2 };

test('신규 매수: 제안, 자산군 표, 라우터 순으로 확인하고 충돌 경고', () => {
  const proposals = [{ side: '매수', status: '체결', account: '위탁', assetKey: '069500', assetClass: '국내주식' }];
  const wikiRows = [{ account: '위탁', name: 'KODEX 200', assetClass: '채권' }];
  const routerMappings = [{ code: '069500', assetClass: '금' }];
  const all = resolveHoldingAssetClass(exec, { proposals, wikiRows, routerMappings });
  assert.equal(all.assetClass, '국내주식');
  assert.equal(all.warnings.length, 2);
  assert.equal(resolveHoldingAssetClass(exec, { wikiRows }).assetClass, '채권');
  assert.equal(resolveHoldingAssetClass(exec, { routerMappings }).assetClass, '금');
  assert.equal(resolveHoldingAssetClass({ ...exec, assetClass: '달러' }, { proposals }).assetClass, '달러');
  assert.equal(resolveHoldingAssetClass(exec, { routerMappings: [{ ...routerMappings[0], account: '금현물' }] }).assetClass, '');
});

test('자산군 노트 표는 종목 링크의 별칭을 읽는다', () => {
  const rows = assetClassTableRows('## 지금 쓰는 종목\n| 종목 | 계좌 |\n|---|---|\n| [[Wiki/종목|KODEX 200]] | 위탁 |\n', '국내주식');
  assert.deepEqual(rows, [{ name: 'KODEX 200', account: '위탁', assetClass: '국내주식' }]);
});

test('ISA 배당주 신규 매수는 ISA 자산군 표에서 결정한다', () => {
  const buy = { ...exec, account: 'ISA', stockName: '새 배당 ETF', stockCode: '111111' };
  const result = resolveHoldingAssetClass(buy, {
    wikiRows: [{ account: 'ISA', name: '새 배당 ETF', assetClass: '배당주' }],
  });
  assert.equal(result.assetClass, '배당주');
  assert.equal(result.source, '자산군 표');
  assert.deepEqual(result.warnings, []);
});

test('다른 계좌 보유는 코드 우선으로 찾고 자산군이 하나로 일치해야 한다', () => {
  const holdingsMap = new Map([
    ['연금저축|옛 이름', { account: '연금저축', name: '옛 이름', ticker: '069500', assetClass: '국내주식' }],
    ['ISA|KODEX 200', { account: 'ISA', name: 'KODEX 200', ticker: '999999', assetClass: '배당주' }],
  ]);
  const result = resolveHoldingAssetClass(exec, { holdingsMap });
  assert.equal(result.assetClass, '국내주식');
  assert.equal(result.source, '다른 계좌 보유');
  holdingsMap.set('ISA|같은 코드', { account: 'ISA', name: '같은 코드', ticker: '069500', assetClass: '배당주' });
  assert.equal(resolveHoldingAssetClass(exec, { holdingsMap }).assetClass, '');
});

test('다른 계좌 동명 보유의 종목코드가 다르면 이름으로 추정하지 않는다', () => {
  const holdingsMap = new Map([['ISA|KODEX 200', {
    account: 'ISA', name: 'KODEX 200', ticker: '999999', assetClass: '배당주',
  }]]);
  assert.equal(resolveHoldingAssetClass(exec, { holdingsMap }).assetClass, '');
  holdingsMap.get('ISA|KODEX 200').ticker = '';
  assert.equal(resolveHoldingAssetClass(exec, { holdingsMap }).assetClass, '');
  assert.match(resolveHoldingAssetClass(exec, { holdingsMap }).warnings.join('\n'), /위탁 계좌에 맞지 않는 자산군: 배당주/);
});

test('ETF 유니버스의 정확한 이름으로 결정한다', () => {
  const result = resolveHoldingAssetClass({ ...exec, stockName: 'KODEX 200TR', stockCode: '278530' });
  assert.equal(result.assetClass, '국내주식');
  assert.equal(result.source, 'ETF 유니버스');
  assert.equal(resolveHoldingAssetClass({ ...exec, stockName: 'KODEX 200TR 변형' }).assetClass, '');
});

test('계좌 관행과 맞지 않는 자산군은 버리고 다음 출처로 진행한다', () => {
  const result = resolveHoldingAssetClass({ ...exec, assetClass: 'TDF' });
  assert.equal(result.assetClass, '');
  assert.match(result.warnings.join('\n'), /위탁 계좌에 맞지 않는 자산군: TDF/);
  const dividend = resolveHoldingAssetClass({ ...exec, assetClass: '배당주' });
  assert.equal(dividend.assetClass, '');
  assert.match(dividend.warnings.join('\n'), /위탁 계좌에 맞지 않는 자산군: 배당주/);
  const fallback = resolveHoldingAssetClass({ ...exec, assetClass: 'TDF' }, {
    wikiRows: [{ account: '위탁', name: 'KODEX 200', assetClass: '국내주식' }],
  });
  assert.equal(fallback.assetClass, '국내주식');
  assert.equal(resolveHoldingAssetClass({ ...exec, account: '연금저축', assetClass: '배당주' }).warnings.length, 0);
  assert.equal(resolveHoldingAssetClass({ ...exec, account: 'ISA', assetClass: '금' }).assetClass, '');
});

test('못 정해도 보유를 만들고 질문은 종목별 1건만 큐에 남는다', async () => {
  const resolution = resolveHoldingAssetClass(exec);
  const { holding } = applyBuy(null, exec, { assetClassResolution: resolution });
  assert.equal(holding.assetClass, '');
  const question = missingAssetClassQuestion(holding);
  assert.equal(question.asker, 'plutus');
  assert.equal(question.urgent, false);
  assert.deepEqual(question, missingAssetClassQuestion(holding));
  assert.deepEqual(question, missingAssetClassQuestion({ ...holding, ticker: '나중에 등록' }));
  const neverSend = () => { throw new Error('비긴급 질문이 즉시 발송됨'); };
  const first = await createWikiQuestion(question, { sender: neverSend });
  const second = await createWikiQuestion(missingAssetClassQuestion({ ...holding, ticker: '069500' }), { sender: neverSend });
  assert.equal(first.queued, true);
  assert.equal(second.duplicate, true);
  assert.equal(first.questionId, second.questionId);
  assert.equal(applyBuy(holding, exec).holding.assetClass, '');
});

test('실제 자산군 노트 이름을 출처로 읽고 배당주·리츠를 배당주로 대응한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-class-notes-'));
  const topicsDir = join(root, 'topics');
  const proposalsDir = join(root, 'proposals');
  mkdirSync(topicsDir);
  mkdirSync(proposalsDir);
  const table = (name, account) => `## 지금 쓰는 종목\n| 종목 | 계좌 |\n|---|---|\n| ${name} | ${account} |\n`;
  writeFileSync(join(topicsDir, '배당주·리츠 자산군.md'), table('TIGER 리츠부동산인프라', 'ISA'));
  writeFileSync(join(topicsDir, '국내주식 자산군.md'), table('KODEX 200', '위탁'));
  mkdirSync(join(topicsDir, '읽기실패.md'));
  const sources = loadHoldingAssetClassSources({ topicsDir, proposalsDir });
  assert.deepEqual(sources.wikiRows.toSorted((a, b) => a.name.localeCompare(b.name)), [
    { name: 'TIGER 리츠부동산인프라', account: 'ISA', assetClass: '배당주' },
    { name: 'KODEX 200', account: '위탁', assetClass: '국내주식' },
  ].toSorted((a, b) => a.name.localeCompare(b.name)));
});

test('제안은 실제 체결 상태·계좌가 맞는 자산군 종류 하나만 사용한다', () => {
  const proposals = [
    { side: '매수', status: '대기', account: '위탁', assetKey: '069500', assetClass: '금' },
    { side: '매수', status: '체결', account: null, assetKey: '069500', assetClass: '금' },
    { side: '매수', status: '체결', account: '위탁', assetKey: '069500', assetClass: '국내주식' },
    { side: '매수', status: '섀도우체결', account: '위탁', assetKey: '069500', assetClass: '국내주식' },
  ];
  assert.equal(resolveHoldingAssetClass(exec, { proposals }).assetClass, '국내주식');
  proposals.push({ side: '매수', status: '체결', account: '위탁', assetKey: '069500', assetClass: '채권' });
  assert.equal(resolveHoldingAssetClass(exec, { proposals }).assetClass, '');
});

test('출처 충돌은 결정값을 유지하면서 같은 종목의 확인 질문으로 수렴한다', async () => {
  const trade = { ...exec, stockName: '충돌 ETF', stockCode: '876543' };
  const result = resolveHoldingAssetClass(trade, {
    wikiRows: [{ account: '위탁', name: '충돌 ETF', assetClass: '채권' }],
    routerMappings: [{ code: '876543', assetClass: '금' }],
  });
  assert.equal(result.assetClass, '채권');
  assert.equal(result.conflict, true);
  const holding = { account: '위탁', name: '충돌 ETF', ticker: '' };
  const first = await createWikiQuestion(missingAssetClassQuestion(holding, result));
  const second = await createWikiQuestion(missingAssetClassQuestion({ ...holding, ticker: '876543' }, result));
  assert.equal(first.queued, true);
  assert.equal(second.duplicate, true);
});

test('기존 보유 자산군 유지 및 새 보유 태그는 buildVaultTags 결과', () => {
  const existing = { ...applyBuy(null, { ...exec, assetClass: '국내주식' }).holding };
  assert.equal(applyBuy(existing, { ...exec, assetClass: '금' }).holding.assetClass, '국내주식');
  const content = buildLiveHoldingRecord(existing).content;
  const tags = parseFrontmatter(content).tags;
  assert.deepEqual(tags, buildVaultTags({ account: existing.account, assetClass: existing.assetClass, stockName: existing.name }));
});
