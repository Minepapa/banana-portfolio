import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsCatalog, factsFor } from './facts-catalog.mjs';

function temporaryCatalog(meta) {
  const toolsDir = mkdtempSync(join(tmpdir(), 'facts-catalog-'));
  writeFileSync(join(toolsDir, 'sample-facts.mjs'), `export const FACTS_META = ${JSON.stringify(meta)};\nthrow new Error('import executed');\n`);
  return toolsDir;
}

const valid = {
  serves: [{ agent: 'plutus', workType: '장부 품질' }], attach: 'always', args: [], summary: '장부 사실',
};

test('모든 사실 도구의 자기 선언은 생성 레지스트리와 일치한다', () => {
  const entries = factsCatalog();
  assert.equal(entries.length, 9);
  assert.deepEqual(factsFor('plutus').always.map((entry) => entry.filename).sort(),
    ['ledger-facts.mjs', 'macro-overlay-facts.mjs', 'rebalance-facts.mjs', 'risk-facts.mjs']);
  assert.deepEqual(factsFor('plutus').onRequest.map((entry) => entry.filename).sort(),
    ['isa-exposure-facts.mjs', 'stock-facts.mjs']);
  assert.deepEqual(factsFor('clio').onRequest.map((entry) => entry.filename), ['preference-facts.mjs']);
  assert.deepEqual(factsFor('hermes'), { always: [], onRequest: [] });
  assert.equal(entries.filter((entry) => entry.deprecated).length, 2);
  assert.equal(factsFor('plutus').always.find((entry) => entry.filename === 'macro-overlay-facts.mjs').command,
    'macro-overlay-facts.mjs --dry-run');
});

test('정적 파싱은 도구 본문을 실행하지 않으며 메타 누락과 잘못된 연결을 차단한다', () => {
  const toolsDir = temporaryCatalog(valid);
  try {
    const options = { toolsDir };
    assert.equal(factsCatalog(options)[0].summary, '장부 사실');
    const path = join(toolsDir, 'sample-facts.mjs');
    const cases = [
      [null, /FACTS_META 누락/],
      [{ ...valid, serves: [] }, /serves 누락/],
      [{ ...valid, serves: [{ agent: 'unknown', workType: '장부 품질' }] }, /미등록 담당/],
      [{ ...valid, serves: [{ agent: 'plutus', workType: '잘못된 유형' }] }, /미등록 담당/],
    ];
    for (const [meta, message] of cases) {
      writeFileSync(path, meta ? `export const FACTS_META = ${JSON.stringify(meta)};\n` : 'export const OTHER = {};\n');
      assert.throws(() => factsCatalog(options), message);
    }
    assert.match(readFileSync(path, 'utf8'), /FACTS_META/);
  } finally { rmSync(toolsDir, { recursive: true, force: true }); }
});

test('macro-overlay의 상태 갱신 방지 인자를 강제한다', () => {
  const toolsDir = mkdtempSync(join(tmpdir(), 'facts-macro-'));
  try {
    writeFileSync(join(toolsDir, 'macro-overlay-facts.mjs'), `export const FACTS_META = ${JSON.stringify({ ...valid, args: [] })};\n`);
    assert.throws(() => factsCatalog({ toolsDir }), /--dry-run 필수/);
  } finally { rmSync(toolsDir, { recursive: true, force: true }); }
});

test('입력이 필요한 도구(input)는 목록에 입력 형식과 함께 나오고 --all에서도 실행하지 않는다', async () => {
  const { departmentCallFacts } = await import('../tools/department-call-facts.mjs');
  const calls = [];
  const catalog = () => ({
    always: [{ command: 'a-facts.mjs', summary: 'A' }],
    onRequest: [{ command: 'b-facts.mjs', summary: 'B' }, { command: 'stock-facts.mjs', input: '"<종목명>"', summary: '종목' }],
  });
  const result = await departmentCallFacts('plutus', { catalog, all: true, runner: async (command) => { calls.push(command); return 'ok'; } });
  assert.deepEqual(calls.sort(), ['a-facts.mjs', 'b-facts.mjs']);
  assert.match(result.onRequestText, /node scripts\/tools\/stock-facts\.mjs "<종목명>" — 종목/);
});

test('실제 stock-facts 메타는 입력 형식을 선언한다', () => {
  const entry = factsCatalog().find((item) => item.filename === 'stock-facts.mjs');
  assert.equal(entry.input, '"<종목명>"');
  assert.equal(entry.attach, 'on-request');
});
