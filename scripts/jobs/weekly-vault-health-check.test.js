import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBrokenAndAmbiguousLinks,
  findOrphanedNotes,
  findRecentLegacyFiles,
  findFxAnomalies,
  findMissingCurrencyField,
  findPendingWork,
  findRemainingWorkSections,
  findStaleAutoClaims,
  findInvalidProgressFields,
  findStaleEmptyClaims,
  syncIndexCounts,
  buildHealthCheckFacts,
  hasAnyIssue,
  buildApolloPrompt,
} from './weekly-vault-health-check.mjs';

const mkFile = (relPath, content, frontmatter = {}) => ({ relPath, absPath: `/vault/${relPath}.md`, content, frontmatter });

test('findBrokenAndAmbiguousLinks: 존재하는 전체경로 링크는 정상', () => {
  const files = [
    mkFile('A', '내용 [[B]]'),
    mkFile('B', '내용'),
  ];
  const { broken, ambiguous } = findBrokenAndAmbiguousLinks(files);
  assert.equal(broken.length, 0);
  assert.equal(ambiguous.length, 0);
});

test('findBrokenAndAmbiguousLinks: 존재하지 않는 대상은 깨진 링크', () => {
  const files = [mkFile('A', '내용 [[없는파일]]')];
  const { broken } = findBrokenAndAmbiguousLinks(files);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].target, '없는파일');
});

test('findBrokenAndAmbiguousLinks: 베이스네임이 유일하면 폴더 경로 없이도 정상 해석', () => {
  const files = [
    mkFile('Knowledge/Hubs/X', '내용 [[Y]]'),
    mkFile('Knowledge/Meta/Y', '내용'),
  ];
  const { broken, ambiguous } = findBrokenAndAmbiguousLinks(files);
  assert.equal(broken.length, 0);
  assert.equal(ambiguous.length, 0);
});

test('findBrokenAndAmbiguousLinks: 같은 베이스네임이 여러 개면 중의적', () => {
  const files = [
    mkFile('Knowledge/API/README', '내용'),
    mkFile('Knowledge/Playbook/README', '내용'),
    mkFile('X', '내용 [[README]]'),
  ];
  const { ambiguous } = findBrokenAndAmbiguousLinks(files);
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].candidates.length, 2);
});

test('findBrokenAndAmbiguousLinks: 코드스팬(백틱) 안의 [[..]]는 링크로 안 침', () => {
  const files = [mkFile('A', '설명 텍스트 `[[wikilink]]` 그대로')];
  const { broken } = findBrokenAndAmbiguousLinks(files);
  assert.equal(broken.length, 0, '백틱 안 예시 문구가 실제 링크로 오인되면 안 됨(2026-09-04 실사고 재현)');
});

test('findBrokenAndAmbiguousLinks: 표 셀 안의 이스케이프 파이프(\\|)도 정상 해석', () => {
  const files = [
    mkFile('A', '| 열1 | [[B\\|표시텍스트]] |'),
    mkFile('B', '내용'),
  ];
  const { broken } = findBrokenAndAmbiguousLinks(files);
  assert.equal(broken.length, 0);
});

test('findOrphanedNotes: 인바운드 링크가 하나도 없는 대상 폴더 노트는 고립', () => {
  const files = [
    mkFile('Knowledge/Infra/동기화-인프라', '아무도 안 가리킴'),
    mkFile('Knowledge/Meta/사용안내', '내용 [[Knowledge/Meta/파일배선도]]'),
    mkFile('Knowledge/Meta/파일배선도', '내용 [[Knowledge/Meta/사용안내]]'), // 서로 상호 링크 — 둘 다 인바운드 있음
  ];
  const orphaned = findOrphanedNotes(files, ['Knowledge/Meta', 'Knowledge/Infra']);
  assert.deepEqual(orphaned, ['Knowledge/Infra/동기화-인프라']);
});

test('findOrphanedNotes: 베이스네임으로만 걸린 링크도 인바운드로 인정', () => {
  const files = [
    mkFile('Knowledge/Hubs/X', '내용 [[동기화-인프라]]'),
    mkFile('Knowledge/Infra/동기화-인프라', '내용'),
  ];
  const orphaned = findOrphanedNotes(files, ['Knowledge/Infra']);
  assert.equal(orphaned.length, 0);
});

test('findRecentLegacyFiles: 대정리 기준일 이후 legacy:true 파일만 플래그', () => {
  const files = [
    mkFile('A', '', { legacy: true, date: '2026-09-05' }),
    mkFile('B', '', { legacy: true, date: '2026-08-01' }), // 기준일 이전 — 대정리로 이미 걸러진 옛 파일
    mkFile('C', '', { legacy: false, date: '2026-09-06' }),
  ];
  const result = findRecentLegacyFiles(files, '2026-09-04');
  assert.deepEqual(result, ['A']);
});

// ⚠️ 2026-09-03 엔비디아 실사고 재현 — 환율 미반영이면 profit이 원시 USD 차액 그대로라
// impliedRate(profit/rawDiff)가 1에 가깝다(정상 환율 800~2500 범위를 한참 벗어남).
test('findFxAnomalies: 환율 미반영(profit이 원시 USD 차액과 거의 같음)이면 이상치로 잡음', () => {
  const records = [
    { __relPath: 'Facts/Ledger/Profits/A', currency: 'USD', buyPrice: 169.9, sellPrice: 223.2, quantity: 24, profit: (223.2 - 169.9) * 24 }, // 환율 미반영
  ];
  const anomalies = findFxAnomalies(records);
  assert.equal(anomalies.length, 1);
  assert.ok(anomalies[0].impliedRate < 2, `배율이 1에 가까워야 함, 실제 ${anomalies[0].impliedRate}`);
});

test('findFxAnomalies: 정상적으로 환율이 반영된 레코드는 통과', () => {
  const records = [
    { __relPath: 'Facts/Ledger/Profits/A', currency: 'USD', buyPrice: 169.9, sellPrice: 223.2, quantity: 24, profit: (223.2 - 169.9) * 24 * 1356.31 },
  ];
  assert.equal(findFxAnomalies(records).length, 0);
});

test('findFxAnomalies: 국내종목(currency 없음)은 대상 아님', () => {
  const records = [{ __relPath: 'X', buyPrice: 50000, sellPrice: 60000, quantity: 10, profit: 100000 }];
  assert.equal(findFxAnomalies(records).length, 0);
});

test('findMissingCurrencyField: 2026-09-04 이후 레코드인데 currency 필드가 없으면 플래그', () => {
  const records = [
    { __relPath: 'A', date: '2026-09-05 10:00:00', currency: undefined },
    { __relPath: 'B', date: '2026-08-01 10:00:00', currency: undefined }, // 수정 이전 구형 — 대상 아님
    { __relPath: 'C', date: '2026-09-05 10:00:00', currency: 'KRW' },
  ];
  assert.deepEqual(findMissingCurrencyField(records, '2026-09-04'), ['A']);
});

test('findPendingWork: progress가 진행중·보류인 것만, 완료·폐기는 제외', () => {
  const records = [
    { __relPath: 'A', progress: '진행중' },
    { __relPath: 'B', progress: '보류' },
    { __relPath: 'C', progress: '완료' },
    { __relPath: 'D', progress: '폐기' },
  ];
  const result = findPendingWork(records);
  assert.deepEqual(result.map((r) => r.file), ['A', 'B']);
});

test('findRemainingWorkSections: "## 남은 것" 섹션이 있으면 첫 줄을 미리보기로 추출', () => {
  const files = [mkFile('A', '# 제목\n\n## 남은 것\n\n- 첫 번째 남은 일\n- 두 번째\n')];
  const result = findRemainingWorkSections(files);
  assert.equal(result.length, 1);
  assert.equal(result[0].preview, '첫 번째 남은 일');
});

test('findRemainingWorkSections: 섹션 없으면 빈 배열', () => {
  assert.deepEqual(findRemainingWorkSections([mkFile('A', '# 제목\n\n내용만 있음')]), []);
});

test('findRemainingWorkSections: progress:"완료"/"폐기"로 닫힌 문서는 제외(2026-09-20 오너 DevRequest — 이미 완료된 건 목록에서 뺀다)', () => {
  const files = [
    mkFile('A-완료', '## 남은 것\n\n- 완료됐는데 안 지운 잔재', { progress: '완료' }),
    mkFile('B-폐기', '## 남은 것\n\n- 폐기됐는데 안 지운 잔재', { progress: '폐기' }),
    mkFile('C-진행중', '## 남은 것\n\n- 실제로 해결 필요', { progress: '진행중' }),
  ];
  const result = findRemainingWorkSections(files);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'C-진행중');
});

test('findRemainingWorkSections: progress 필드 자체가 없는 문서(Sessions·DevRequests 관례)는 계속 포함(누락 방지 우선)', () => {
  const files = [mkFile('Log/Sessions/A', '## 남은 것\n\n- 세션 로그 잔여')];
  assert.equal(findRemainingWorkSections(files).length, 1);
});

test('findStaleAutoClaims: "자동 갱신" 문구 있는데 오래 안 바뀌면 재확인 후보', () => {
  const files = [mkFile('A', '분기보고서 발행 직후 자동 갱신된다.', { updatedAt: '2026-06-01' })];
  const result = findStaleAutoClaims(files, new Date('2026-09-04'), 56);
  assert.equal(result.length, 1);
});

test('findStaleAutoClaims: "자동" 문구 있어도 최근에 갱신됐으면 통과', () => {
  const files = [mkFile('A', '자동 기록된다.', { updatedAt: '2026-09-01' })];
  assert.equal(findStaleAutoClaims(files, new Date('2026-09-04'), 56).length, 0);
});

test('findStaleAutoClaims: "자동" 문구가 아예 없으면(예: 영구 결정 기록) 대상 아님', () => {
  const files = [mkFile('A', '오너가 2026-01-01 직접 결정했다.', { updatedAt: '2026-01-01' })];
  assert.equal(findStaleAutoClaims(files, new Date('2026-09-04'), 56).length, 0);
});

// [핵심] 2026-09-14 신설 — 므네모시네 정합성 구조적 가드 1단계(오너 지시).
test('findInvalidProgressFields: progress 필드 결측이면 잡음', () => {
  const records = [{ progress: undefined, __relPath: 'Log/Implementation/A' }];
  const result = findInvalidProgressFields(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].file, 'Log/Implementation/A');
  assert.equal(result[0].progress, null);
});

test('findInvalidProgressFields: 4종 캐노니컬 값은 전부 통과', () => {
  const records = ['완료', '진행중', '보류', '폐기'].map((progress, i) => ({ progress, __relPath: `Log/Implementation/${i}` }));
  assert.equal(findInvalidProgressFields(records).length, 0);
});

test('findInvalidProgressFields: 4종 밖의 자유서술("부분완료" 등)은 잡음 — 2026-09-13 실측 재발 케이스', () => {
  const records = [{ progress: '부분완료', __relPath: 'Log/Implementation/A' }];
  const result = findInvalidProgressFields(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].progress, '부분완료');
});

test('findStaleEmptyClaims: "비어있음"인데 실제로 파일이 있으면 잡음 — FundPurchases 재발 케이스', () => {
  const indexMd = [
    '## Facts/ — 원장',
    '### Facts/Ledger/ — 돈이 실제로 움직인 기록',
    '| 하위 폴더 | 무엇 | 언제 | 지금 상태 |',
    '|---|---|---|---|',
    '| `FundPurchases/` | 펀드 적립 | 알림 도착 시 | **⬜ 비어있음** — 아직 안 옴 |',
  ].join('\n');
  const allFiles = [{ relPath: 'Facts/Ledger/FundPurchases/2026-09-13-펀드적립.md' }];
  const result = findStaleEmptyClaims(indexMd, allFiles);
  assert.equal(result.length, 1);
  assert.equal(result[0].folder, 'Facts/Ledger/FundPurchases');
  assert.equal(result[0].actualCount, 1);
});

test('findStaleEmptyClaims: 실제로도 비어있으면 안 잡음', () => {
  const indexMd = [
    '## State/ — 지금 이 순간의 값',
    '| 폴더 | 무엇 | 언제 | 지금 상태 |',
    '|---|---|---|---|',
    '| `KillSwitch/` | 킬스위치 | 발동 시 | **⬜ 비어있음(폴더 자체가 없음)** |',
  ].join('\n');
  assert.equal(findStaleEmptyClaims(indexMd, []).length, 0);
});

test('findStaleEmptyClaims: "✅"로 이미 채워졌다고 정확히 표기된 행은 대상 아님(개수 드리프트는 감내)', () => {
  const indexMd = [
    '## State/ — 지금 이 순간의 값',
    '| 폴더 | 무엇 | 언제 | 지금 상태 |',
    '|---|---|---|---|',
    '| `Holdings/` | 보유현황 | 체결 시 | ✅ 35개 파일 |',
  ].join('\n');
  const allFiles = [{ relPath: 'State/Holdings/위탁-삼성전자' }, { relPath: 'State/Holdings/위탁-현대차' }];
  assert.equal(findStaleEmptyClaims(indexMd, allFiles).length, 0); // 개수(35 vs 실제 2)는 검사 대상 아님
});

// [핵심] 2026-09-14 신설 — 개수 자동동기화(오너 지시: "개수 차이도 맞출 수 있을 것 같다").
test('syncIndexCounts: 실제 개수와 다르면 그 줄의 숫자만 교체, changes에 기록', () => {
  const indexMd = [
    '## Facts/ — 원장',
    '### Facts/Ledger/ — 돈이 실제로 움직인 기록',
    '| 하위 폴더 | 무엇 | 언제 | 지금 상태 |',
    '|---|---|---|---|',
    '| `Executions/` | 체결 | 알림 도착 시 | ✅ 86개 파일 |',
  ].join('\n');
  const allFiles = [
    { relPath: 'Facts/Ledger/Executions/a' }, { relPath: 'Facts/Ledger/Executions/b' }, { relPath: 'Facts/Ledger/Executions/c' },
  ];
  const { updatedContent, changes } = syncIndexCounts(indexMd, allFiles);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { folder: 'Facts/Ledger/Executions', oldCount: 86, newCount: 3 });
  assert.match(updatedContent, /✅ 3개 파일/);
  assert.doesNotMatch(updatedContent, /86개 파일/);
});

test('syncIndexCounts: 실제 개수와 같으면 변경 없음(changes 빈 배열, 내용 그대로)', () => {
  const indexMd = [
    '## State/ — 지금 이 순간의 값',
    '| 폴더 | 무엇 | 언제 | 지금 상태 |',
    '|---|---|---|---|',
    '| `Holdings/` | 보유현황 | 체결 시 | ✅ 2개 파일 |',
  ].join('\n');
  const allFiles = [{ relPath: 'State/Holdings/a' }, { relPath: 'State/Holdings/b' }];
  const { updatedContent, changes } = syncIndexCounts(indexMd, allFiles);
  assert.equal(changes.length, 0);
  assert.equal(updatedContent, indexMd);
});

test('syncIndexCounts: "비어있음"류(형식이 다른 행)는 대상 아님 — findStaleEmptyClaims 소관', () => {
  const indexMd = [
    '## State/ — 지금 이 순간의 값',
    '| 폴더 | 무엇 | 언제 | 지금 상태 |',
    '|---|---|---|---|',
    '| `MorningBriefing/` | 브리핑 | 발송 시 | **⬜ 비어있음** — 아직 안 돎 |',
  ].join('\n');
  const allFiles = [{ relPath: 'State/MorningBriefing/a' }];
  const { changes } = syncIndexCounts(indexMd, allFiles);
  assert.equal(changes.length, 0); // countRe가 "✅ N개 파일" 형식이 아니면 매칭 안 됨
});

test('hasAnyIssue: 전부 빈 배열이면 false(조용함)', () => {
  const empty = { broken: [], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [], pendingWork: [], remainingSections: [], staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  assert.equal(hasAnyIssue(empty), false);
});

test('hasAnyIssue: 하나라도 있으면 true', () => {
  const oneIssue = { broken: [{ file: 'A', target: 'B' }], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [], pendingWork: [], remainingSections: [], staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  assert.equal(hasAnyIssue(oneIssue), true);
});

test('buildHealthCheckFacts: 발견된 것만 줄로 나열, 빈 항목은 줄 자체가 안 생김', () => {
  const r = { broken: [{ file: 'A', target: 'B' }], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [], pendingWork: [], remainingSections: [], staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  const facts = buildHealthCheckFacts(r);
  assert.equal(facts.length, 1);
  assert.match(facts[0], /깨진 링크 1건/);
});

test('buildApolloPrompt: 세 마커·사실 목록이 프롬프트에 그대로 포함', () => {
  const prompt = buildApolloPrompt(['깨진 링크 1건: A→[[B]]']);
  assert.match(prompt, /\[결론\]/);
  assert.match(prompt, /\[맥락\]/);
  assert.match(prompt, /\[의사결정\]/);
  assert.match(prompt, /깨진 링크 1건/);
});
