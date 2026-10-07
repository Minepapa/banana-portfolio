import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { VAULT_PATHS, VAULT_REL, VAULT_ROOT } from './vault-paths.mjs';
import {
  LEGACY_TO_MOUSEION_RULES,
  MOUSEION_TOP_FOLDERS,
  findDestinationCollisions,
  mapLegacyPath,
} from './vault-layout.mjs';

function collectStringValues(value) {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectStringValues);
}

const relativePaths = Object.values(VAULT_REL);
const absolutePaths = collectStringValues(
  Object.fromEntries(Object.entries(VAULT_PATHS).filter(([key]) => key !== 'root')),
);
const currentVaultPaths = [
  ...relativePaths,
  ...absolutePaths.map((absolutePath) => relative(VAULT_ROOT, absolutePath)),
];

test('VAULT_REL과 VAULT_PATHS의 모든 현재 경로가 매핑된다', () => {
  for (const relPath of currentVaultPaths) {
    assert.ok(relPath && !relPath.startsWith('..'), `볼트 밖 경로: ${relPath}`);
    assert.ok(MOUSEION_TOP_FOLDERS.includes(relPath.split('/')[0]), `새 최상위 폴더 아님: ${relPath}`);
  }
});

test('이관 목적지 충돌은 대소문자를 무시하고 legacy 원본을 함께 보고한다', () => {
  assert.deepEqual(findDestinationCollisions([
    'Knowledge/Topics/README.md', 'Knowledge/Infra/readme.md',
    'Log/Reports/weekly.md', 'Knowledge/Topics/unique.md',
  ]), [{
    to: '30_Wiki/34_Topics/README.md',
    sources: ['Knowledge/Topics/README.md', 'Knowledge/Infra/readme.md'],
  }]);
});

test('파일 예외와 삭제 대상을 적용한 경로에는 목적지 충돌이 없다', () => {
  assert.deepEqual(findDestinationCollisions([
    'Knowledge/API/README.md',
    'Knowledge/Playbook/README.md',
    'Knowledge/Index.md',
    'Knowledge/Meta/Index.md',
    'Knowledge/Kangto/original.txt',
    'Knowledge/Kangto/original.json',
  ]), []);
});

test('매핑 결과와 규칙의 대상 폴더는 새 볼트 이름 규칙을 따른다', () => {
  const pathsToCheck = [
    ...currentVaultPaths.map((relPath) => ({ from: relPath, to: relPath })),
    ...LEGACY_TO_MOUSEION_RULES.filter((rule) => rule.action !== 'delete')
      .map(({ from, to }) => ({ from, to })),
  ];

  for (const { from, to } of pathsToCheck) {
    assert.ok(to, `누락된 매핑: ${from}`);
    if (to === '.gitignore') {
      assert.equal(from, '.gitignore', '루트 설정 파일만 루트에 유지한다');
      continue;
    }
    const segments = to.split('/');
    const topFolder = segments[0];
    assert.ok(MOUSEION_TOP_FOLDERS.includes(topFolder), `${from} → ${to}: 미등록 최상위 폴더`);
    assert.match(topFolder, /^\d\d_[A-Za-z]+$/, `${from} → ${to}: 최상위 폴더 이름`);

    // 파일명에는 한글·공백이 가능하다. 확장자가 있는 마지막 조각만 제외한다.
    const folderSegments = segments.at(-1).includes('.') ? segments.slice(1, -1) : segments.slice(1);
    for (const folder of folderSegments) {
      assert.match(folder, /^[A-Za-z0-9_-]+$/, `${from} → ${to}: 하위 폴더 이름`);
    }
  }
});

test('경로 경계와 예외 규칙을 정확히 적용한다', () => {
  assert.equal(mapLegacyPath('Unknown/Path.md'), null);
  assert.equal(mapLegacyPath('Decisions/NewCategory/item.md'), null);
  assert.equal(mapLegacyPath('Stateful/JobHealth/x.md'), null);
  assert.equal(mapLegacyPath('State/Holding/x.md')?.rule.from, 'State');
  assert.equal(mapLegacyPath('State/Holdings/x.md')?.rule.from, 'State');
  assert.equal(mapLegacyPath('State/JobHealth/x.md')?.to, '95_Etna/Jobs/JobHealth/x.md');
  assert.equal(mapLegacyPath('State/JobHealth/x.md')?.rule.from, 'State/JobHealth');
  assert.equal(mapLegacyPath('State/JobHealthExtra/x.md')?.rule.from, 'State');
  assert.equal(mapLegacyPath('.gitignore')?.to, '.gitignore');
  assert.equal(mapLegacyPath('.gitignore-extra'), null);
});

test('자신을 포함하는 일반 규칙보다 예외 규칙이 먼저 온다', () => {
  for (const [exceptionIndex, exception] of LEGACY_TO_MOUSEION_RULES.entries()) {
    for (const [generalIndex, general] of LEGACY_TO_MOUSEION_RULES.entries()) {
      if (exception.from.startsWith(`${general.from}/`)) {
        assert.ok(exceptionIndex < generalIndex, `${exception.from}은 ${general.from}보다 앞서야 한다`);
      }
    }
  }
});

test('특수 매핑은 지정한 목적지와 연도 폴더 표시를 보존한다', () => {
  const examples = [
    ['Decisions/Proposals/order.md', '95_Etna/Investing/Orders/order.md', false],
    ['Decisions/Profile/observation.md', '20_Records/21_Notes/observation.md', true],
    ['Decisions/Evaluations/item.md', '95_Etna/Investing/Evaluations/item.md', false],
    ['Decisions/PositionJournal/item.md', '95_Etna/Investing/PositionJournal/item.md', false],
    ['Decisions/RiskMonitor/item.md', '95_Etna/Investing/RiskMonitor/item.md', false],
    ['Log/Reports/weekly.md', '50_Outputs/Reports/weekly.md', true],
    ['Log/Research/note.md', '50_Outputs/Reports/note.md', true],
    ['Log/Sessions/session.md', '60_Logs/Zeus/session.md', true],
    ['Log/TelegramSession/session.md', '60_Logs/Zeus/Telegram/session.md', true],
    ['Log/WarningEvents/event.md', '95_Etna/Jobs/WarningEvents/event.md', false],
    ['Knowledge/Kangto/README.md', '20_Records/22_Literature/README.md', true],
    ['Knowledge/Kangto/1_책/INDEX.md', '20_Records/22_Literature/INDEX.md', true],
    [
      'Knowledge/Kangto/1_책/손실은짧게수익은길게_Ch4_전사.md',
      '20_Records/22_Literature/손실은짧게수익은길게_Ch4_전사.md',
      true,
    ],
    ['Knowledge/Index.md', '90_Delphi/index.md', false],
    ['Knowledge/Meta/Index.md', '80_Archive/Knowledge/Meta/Index.md', false],
    ['Knowledge/Meta/므네모시네-파일배선도.md', '90_Delphi/Schema/경로 등록부.md', false],
    ['Knowledge/API/README.md', '30_Wiki/34_Topics/API 개요.md', false],
    ['Knowledge/Playbook/README.md', '30_Wiki/34_Topics/플레이북 개요.md', false],
  ];

  for (const [from, to, yearFolder] of examples) {
    assert.deepEqual(
      { to: mapLegacyPath(from)?.to, yearFolder: mapLegacyPath(from)?.yearFolder },
      { to, yearFolder },
      from,
    );
  }
});

test('깡토 노트 외 파일은 매핑 없음과 구별되는 삭제 결과를 반환한다', () => {
  for (const relPath of [
    'Knowledge/Kangto/1_책/original.txt',
    'Knowledge/Kangto/metadata.json',
  ]) {
    const result = mapLegacyPath(relPath);
    assert.equal(result.to, null);
    assert.equal(result.action, 'delete');
    assert.ok(result.reason);
    assert.equal(result.rule.from, 'Knowledge/Kangto');
  }
  assert.equal(mapLegacyPath('Unknown/original.txt'), null);
});
