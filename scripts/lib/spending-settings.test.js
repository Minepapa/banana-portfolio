import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySettingsPatch, mergeSettings, validateSpendingSettings } from './spending-settings.mjs';
import { readSpendingSettings } from './spending-daily.mjs';
import { runSettingsTool } from '../tools/spending-settings.mjs';

const root = mkdtempSync(join(tmpdir(), 'spending-settings-'));
after(() => rmSync(root, { recursive: true, force: true }));

const patch = {
  cardMap: [{ card: '하나', mask: '5*8*', instrument: 'Card A' }],
  instrumentAliases: [{ from: 'Pay A', to: 'Card A', via: 'Pay' }],
  fixedCosts: [{ name: '통신', merchant: '통신요금', instrument: 'Card A', dayFrom: 11, dayTo: 13, variable: true }],
  merchantCategories: [{ merchant: '주차장', category: '자동차', subcategory: '주차' }],
  duplicateRoutes: [{ keep: 'Pay B', drop: 'Pay A' }],
};

test('설정 형식: 칸마다 필수값·중복·별칭 연쇄를 막는다', () => {
  assert.doesNotThrow(() => validateSpendingSettings({ recipientDecisions: [], ...patch }));
  const bad = [
    { cardMap: [{ card: '하나', mask: '', instrument: 'A' }] },
    { cardMap: [patch.cardMap[0], { ...patch.cardMap[0], instrument: 'B' }] },
    { instrumentAliases: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }] },
    { instrumentAliases: [{ from: 'A', to: 'A' }] },
    { fixedCosts: [{ ...patch.fixedCosts[0], dayTo: 32 }] },
    { fixedCosts: [{ ...patch.fixedCosts[0], variable: 'yes' }] },
    { fixedCosts: [patch.fixedCosts[0], patch.fixedCosts[0]] },
    { merchantCategories: [{ merchant: '가게' }] },
    { fixedCosts: [{ ...patch.fixedCosts[0], merchant: 'K T' }] },
    { merchantCategories: [{ merchant: '(주)AB', category: '식비' }] },
    { recipientDecisions: [{ bank: '하나', last4: '12', status: 'excluded' }] },
    { duplicateRoutes: [{ keep: 'A', drop: 'A' }] },
    { duplicateRoutes: [null] },
    { duplicateRoutes: [{ keep: 'B', drop: 'A' }, { keep: 'C', drop: 'B ' }] },
    { duplicateRoutes: [{ keep: 'A', drop: 'B' }, { keep: 'B', drop: 'C' }] },
  ];
  for (const settings of bad) assert.throws(() => validateSpendingSettings(settings), /소비 설정 형식 오류/, JSON.stringify(settings));
});

test('갱신: 칸 단위로 바꾸고 다른 칸은 두며, 같은 내용이면 쓰지 않는다', () => {
  const dir = join(root, 'apply');
  mkdirSync(dir);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ recipientDecisions: [{ bank: '하나', last4: '0107', status: 'excluded' }], investmentAccounts: [] }));
  assert.throws(() => mergeSettings({}, { recipientDecisions: [] }), /바꿀 수 없는 칸/);
  const first = applySettingsPatch(dir, patch);
  assert.deepEqual(first, { changed: true, keys: Object.keys(patch) });
  const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.recipientDecisions[0].last4, '0107');
  assert.deepEqual(saved.fixedCosts, patch.fixedCosts);
  assert.equal(readSpendingSettings(dir).cardMap[0].instrument, 'Card A');
  let writes = 0;
  assert.deepEqual(applySettingsPatch(dir, patch, { write: () => { writes += 1; } }), { changed: false, keys: [] });
  assert.equal(writes, 0);
});

test('도구: 기본은 미리보기라 파일을 바꾸지 않고, 모르는 옵션은 막는다', () => {
  const dir = join(root, 'tool');
  mkdirSync(dir);
  const patchPath = join(root, 'patch.json');
  writeFileSync(patchPath, JSON.stringify(patch));
  const lines = [];
  const preview = runSettingsTool([`--patch=${patchPath}`], { spendingDir: dir, log: (line) => lines.push(line) });
  assert.equal(preview.preview, true);
  assert.match(lines[0], /미리보기 — 바뀔 칸: cardMap/);
  assert.throws(() => readFileSync(join(dir, 'settings.json')), /ENOENT/);
  assert.throws(() => runSettingsTool([`--patch=${patchPath}`, '--force'], { spendingDir: dir, log: () => {} }), /모르는 옵션/);
  runSettingsTool([`--patch=${patchPath}`, '--apply'], { spendingDir: dir, log: () => {} });
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).cardMap.length, 1);
});

test('일일 경로는 송금 판정 칸만 검사해 월간 칸 손 편집 실수에 멈추지 않는다', () => {
  const dir = join(root, 'daily');
  mkdirSync(dir);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ recipientDecisions: [], fixedCosts: [{ name: 'x', variable: 'yes' }] }));
  assert.deepEqual(readSpendingSettings(dir).recipientDecisions, []);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ recipientDecisions: [{ bank: '하나', last4: '1' }] }));
  assert.throws(() => readSpendingSettings(dir), /recipientDecisions/);
});
