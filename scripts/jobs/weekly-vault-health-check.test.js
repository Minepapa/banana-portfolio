import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_PROGRESS_VALUES } from '../lib/vault-frontmatter.mjs';
import {
  findBrokenAndAmbiguousLinks,
  findOrphanedNotes,
  findRecentLegacyFiles,
  findFxAnomalies,
  findMissingCurrencyField,
  classifyWorkDocChecks,
  findStaleAutoClaims,
  findInvalidProgressFields,
  findCompletableWorkDocs,
  createCompletableQuestions,
  loadHealthCheckAgent,
  findStaleEmptyClaims,
  syncIndexCounts,
  buildHealthCheckFacts,
  hasAnyIssue,
  buildApolloPrompt,
} from './weekly-vault-health-check.mjs';

const mkFile = (relPath, content, frontmatter = {}) => ({ relPath, absPath: `/vault/${relPath}.md`, content, frontmatter });

test('주간 건강검진은 보유 자산군 빈칸을 발견 사항에 포함한다', () => {
  const result = {
    broken: [], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [],
    emptyHoldingAssetClasses: ['95_Etna/Investing/Holdings/위탁-새종목.md: holding assetClass is empty'],
    workChecks: { overdue: [], missing: [], scheduledCount: 0 }, questionFailures: [],
    staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [],
  };
  assert.equal(hasAnyIssue(result), true);
  assert.match(buildHealthCheckFacts(result).join('\n'), /보유 자산군 빈칸 1건/);
});

test('C1: 열린 작업의 경과·누락만 보고하고 확인일이 남은 문서는 개수만 센다', () => {
  const files = [
    mkFile('40_Projects/a/Requests/old', '## 남은 것\n- 일', { status: '보류', waitingOn: '외부', nextCheck: '2026-10-10' }),
    mkFile('40_Projects/b/Implementation/today', '## 남은 것\n- 일', { progress: '진행중', waitingOn: '착수 대기', nextCheck: '2026-10-11' }),
    mkFile('40_Projects/c/Requests/later', '', { status: '차단됨', waitingOn: '오너 판단', nextCheck: '2026-10-12' }),
    mkFile('40_Projects/d/Requests/missing', '', { status: '진행중' }),
    mkFile('40_Projects/e/Implementation/no-date', '', { progress: '진행중', waitingOn: '외부' }),
    mkFile('40_Projects/f/Requests/done', '## 남은 것\n- 잔재', { status: '완료', nextCheck: '2026-10-09' }),
    mkFile('40_Projects/g/Implementation/discarded', '', { progress: '폐기' }),
    mkFile('60_Logs/2026-10-10-old', '## 남은 것\n- 잔재'),
    mkFile('60_Logs/2026-10-11-new', '## 남은 것\n- [[40_Projects/a/Requests/old]]'),
  ];
  const workChecks = classifyWorkDocChecks(files, '2026-10-11');
  assert.deepEqual(workChecks.overdue, [{ file: files[0].relPath, nextCheck: '2026-10-10' }]);
  assert.deepEqual(workChecks.missing.map((entry) => entry.file), [files[3].relPath, files[4].relPath]);
  assert.equal(workChecks.scheduledCount, 2);
  const results = { broken: [], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [],
    workChecks, staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  assert.equal(hasAnyIssue(results), true);
  const facts = buildHealthCheckFacts(results);
  assert.equal(facts.length, 3);
  assert.match(facts[0], /확인일 지난 작업 문서 1건/);
  assert.match(facts[1], /waitingOn·nextCheck 누락 작업 문서 2건/);
  assert.equal(facts[2], '확인일이 남은 작업 문서 2건');
  assert.ok(facts.every((line) => !line.includes('60_Logs') && !line.includes('남은 것')));
});

test('C1: 확인일이 남은 문서만 있으면 알림은 생략한다', () => {
  const workChecks = classifyWorkDocChecks([mkFile('40_Projects/a/Requests/later', '',
    { status: '진행중', waitingOn: '외부', nextCheck: '2026-10-12' })], '2026-10-11');
  const results = { broken: [], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [],
    workChecks, staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  assert.equal(hasAnyIssue(results), false);
});

test('doneWhen 전부 충족한 진행중 문서만 완료 질문 후보다', () => {
  const files = [mkFile('40_Projects/b/Requests/ready', '---\ndoneWhen: ["launchd:local.ready"]\n---\n', { status: '진행중' }),
    mkFile('40_Projects/c/Requests/closed', '---\ndoneWhen: ["launchd:local.ready"]\n---\n', { status: '완료' }),
    mkFile('40_Projects/d/Implementation/mismatch', '---\ndoneWhen: ["launchd:local.ready"]\n---\n', { status: '진행중', progress: '완료' })];
  assert.deepEqual(findCompletableWorkDocs(files, { vaultRoot: '/tmp/vault', repoPath: '/tmp/repo', launchctlList: () => '- 0 local.ready' })
    .map((entry) => entry.file.relPath), [files[0].relPath]);
});

test('완료 질문 생성 실패는 문서별로 격리하고 facts에 경로와 오류를 남긴다', async () => {
  const files = [mkFile('40_Projects/a/Requests/fail', '첫 문서'), mkFile('40_Projects/b/Requests/ok', '둘째 문서')];
  const attempted = [];
  const failures = await createCompletableQuestions(files.map((file) => ({ file, evidence: ['조건'] })), async (question) => {
    attempted.push(question.changePlan.notePath);
    if (question.changePlan.notePath === files[0].relPath) throw new Error('쓰기 실패\n상세 정보');
  });
  assert.deepEqual(attempted, files.map((file) => file.relPath), '첫 실패 후에도 다음 문서를 처리한다');
  assert.deepEqual(failures, [{ file: files[0].relPath, error: '쓰기 실패' }]);
  const results = { broken: [], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [],
    workChecks: { overdue: [], missing: [], scheduledCount: 0 }, questionFailures: failures,
    staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  assert.equal(hasAnyIssue(results), true);
  assert.match(buildHealthCheckFacts(results)[0], /완료 질문 생성 실패 1건: 40_Projects\/a\/Requests\/fail\(쓰기 실패\)/);
});

test('주간 점검은 클리오 정의를 존재하지 않는 부록 없이 읽는다', () => {
  const expected = { model: 'sonnet' };
  const loaded = loadHealthCheckAgent((name, options) => {
    assert.equal(name, 'clio');
    assert.deepEqual(options, { fallbackModel: 'sonnet' });
    return expected;
  });
  assert.equal(loaded, expected);
});

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
    mkFile('Knowledge/Topics/X', '내용 [[Y]]'),
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
    mkFile('Knowledge/Topics/X', '내용 [[동기화-인프라]]'),
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

test('findInvalidProgressFields: 캐노니컬 값은 전부 통과', () => {
  const records = CANONICAL_PROGRESS_VALUES.map((progress, i) => ({ progress, __relPath: `Log/Implementation/${i}` }));
  assert.equal(findInvalidProgressFields(records).length, 0);
});

test('findInvalidProgressFields: 예정과 차단됨은 유효한 progress 값으로 통과 — 상태표준 재발 방지', () => {
  const records = ['예정', '차단됨'].map((progress, i) => ({ progress, __relPath: `Log/Implementation/${i}` }));
  assert.deepEqual(findInvalidProgressFields(records), []);
});

test('findInvalidProgressFields: 캐노니컬 값 밖의 자유서술("부분완료" 등)은 잡음 — 2026-09-13 실측 재발 케이스', () => {
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
  const empty = { broken: [], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [], workChecks: { overdue: [], missing: [], scheduledCount: 0 }, staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  assert.equal(hasAnyIssue(empty), false);
});

test('hasAnyIssue: 하나라도 있으면 true', () => {
  const oneIssue = { broken: [{ file: 'A', target: 'B' }], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [], workChecks: { overdue: [], missing: [], scheduledCount: 0 }, staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
  assert.equal(hasAnyIssue(oneIssue), true);
});

test('buildHealthCheckFacts: 발견된 것만 줄로 나열, 빈 항목은 줄 자체가 안 생김', () => {
  const r = { broken: [{ file: 'A', target: 'B' }], ambiguous: [], orphaned: [], recentLegacy: [], fxAnomalies: [], missingCurrency: [], workChecks: { overdue: [], missing: [], scheduledCount: 0 }, staleAutoClaims: [], invalidProgress: [], staleEmptyClaims: [] };
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
