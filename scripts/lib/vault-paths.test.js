// vault-paths.mjs 테스트 — VAULT_PATH 환경변수로 경로가 바뀌는지, 4대분류 하위경로가
// 전부 그 루트 밑에 걸리는지 확인. 모듈은 import 시점에 env를 한 번 읽으므로, 오버라이드
// 테스트는 자식 프로세스로 분리 실행한다(같은 프로세스에서 재-import해도 캐시돼 반영 안 됨).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { VAULT_ROOT, VAULT_PATHS, VAULT_REL, vaultAbs, vaultYearDir, vaultYearFiles } from './vault-paths.mjs';
import { mapLegacyPath } from './vault-layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('기본값: VAULT_PATH 미설정 시 ~/Pantheon/Mouseion', () => {
  const script = join(HERE, 'vault-paths.mjs');
  const env = { ...process.env };
  delete env.VAULT_PATH;
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import { VAULT_ROOT } from '${script.replace(/\\/g, '\\\\')}'; console.log(VAULT_ROOT);`],
    { env },
  ).toString().trim();
  assert.equal(out, join(homedir(), 'Pantheon', 'Mouseion'));
});

// facts.ledger는 이벤트 종류별 하위폴더가 있는 중첩 객체라(2026-08-04 확정) 재귀로 편다.
function flattenPaths(obj) {
  const out = [];
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') out.push(v);
    else out.push(...flattenPaths(v));
  }
  return out;
}

test('5대분류 하위경로가 전부 VAULT_ROOT 밑에 걸린다', () => {
  const flat = [
    ...flattenPaths(VAULT_PATHS.facts),
    ...flattenPaths(VAULT_PATHS.state),
    ...flattenPaths(VAULT_PATHS.decisions),
    ...flattenPaths(VAULT_PATHS.knowledge),
    ...flattenPaths(VAULT_PATHS.log),
  ];
  // facts: ledgerRoot(1) + ledger 하위 9종(Phase 7에서 profits·dailySnapshots 추가,
  // 2026-08-21 monthlyBalances 추가, 2026-09-03 fundValuations 추가) = 10
  // (marketPolls는 2026-08-17 삭제됨 — 전제였던 추세추종이 기각돼 한 번도 안 쓰임),
  // state 18(+jobHealth, +Phase 8 macroOverlay,
  // +Phase 9 killSwitch·executionMode, +Phase 11 executedOrders, +2026-08-16
  // cashAccumulator, +2026-08-29 proposalMode·telegramSessionLastRead, +2026-09-01
  // marketMoveMonitor, +2026-09-06 macroIndicators(macro-cache.mjs — 거시지표
  // 하루 1회 계산 공유 캐시), +2026-09-06 macroTiltProposal(monthly-macro-tilt-
  // proposal.mjs 전용 Faber 상태 — daily-asset-allocation-check.mjs와 분리),
  // +2026-09-13 breakoutPositions(돌파매매 전략 포지션 상태, breakout-position-
  // vault.mjs) + breakoutPendingEntries(장후시간외 미체결→다음날시가 폴백 대기열,
  // breakout-pending-entry-vault.mjs) + breakoutScanRuns(일별 신호스캔 하루1회
  // 실행보장 마커, daily-breakout-signal-scan.mjs — 코드리뷰 지적 재발방지),
  // +2026-09-29 executionConfirmations(자동 판별이 불완전한 체결의 오너 확인 대기열)),
  // decisions 4
  // (+riskMonitor), knowledge 6(2026-09-04 므네모시네 대정리 — preferenceObservations를
  // profile로 통합, PreferenceObservations/ 하위폴더 평탄화 후 +hubs·meta·infra 3개
  // 신설분(weekly-vault-health-check.mjs가 읽음)), log 3(2026-08-29 신설 —
  // telegramSession, Log/ 최초로 코드가 직접 쓰는 경로가 생겨 VAULT_PATHS에 처음
  // 등록됨. 2026-09-04 +implementation·devRequests(weekly-vault-health-check.mjs가
  // progress 필드·"남은 것" 섹션을 읽음))
  assert.equal(flat.length, 41);
  for (const p of flat) assert.ok(p.startsWith(VAULT_ROOT), `${p} should start with ${VAULT_ROOT}`);
});

test('Ledger 이벤트 종류별 하위폴더 9종이 전부 Facts/Ledger 밑에 걸린다', () => {
  const subfolders = Object.values(VAULT_PATHS.facts.ledger);
  assert.equal(subfolders.length, 9);
  for (const p of subfolders) assert.ok(p.startsWith(VAULT_PATHS.facts.ledgerRoot));
});

test('VAULT_REL과 겹치는 기존 절대경로는 동일하다', () => {
  const overlappingPaths = [
    [VAULT_PATHS.facts.ledger.executions, VAULT_REL.factsLedgerExecutions],
    [VAULT_PATHS.facts.ledger.profits, VAULT_REL.factsLedgerProfits],
    [VAULT_PATHS.state.breakoutPositions, VAULT_REL.stateBreakoutPositions],
    [VAULT_PATHS.state.breakoutPendingEntries, VAULT_REL.stateBreakoutPendingEntries],
    [VAULT_PATHS.state.macroTiltProposal, VAULT_REL.stateMacroTiltProposal],
    [VAULT_PATHS.log.implementation, VAULT_REL.logImplementation],
    [VAULT_PATHS.log.devRequests, VAULT_REL.logDevRequests],
    [VAULT_PATHS.decisions.proposals, VAULT_REL.decisionsProposals],
    [VAULT_PATHS.decisions.profile, VAULT_REL.decisionsProfile],
    [VAULT_PATHS.knowledge.topics, VAULT_REL.knowledgeTopics],
    [VAULT_PATHS.knowledge.meta, VAULT_REL.knowledgeMeta],
    [VAULT_PATHS.knowledge.infra, VAULT_REL.knowledgeInfra],
  ];
  for (const [absolute, relativePath] of overlappingPaths) {
    assert.equal(absolute, vaultAbs(relativePath));
  }
});

test('VAULT_REL 값은 슬래시로 구분한 상대경로이며 끝 슬래시가 없다', () => {
  for (const [key, rel] of Object.entries(VAULT_REL)) {
    assert.equal(typeof rel, 'string', key);
    assert.ok(rel && !rel.startsWith('/') && !rel.endsWith('/') && !rel.includes('\\'), key);
  }
});

test('VAULT_PATH 환경변수로 루트를 오버라이드할 수 있다', () => {
  const script = join(HERE, 'vault-paths.mjs');
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', `import { VAULT_ROOT } from '${script.replace(/\\/g, '\\\\')}'; console.log(VAULT_ROOT);`],
    { env: { ...process.env, VAULT_PATH: '/tmp/custom-vault' } },
  ).toString().trim();
  assert.equal(out, '/tmp/custom-vault');
});

const LEGACY_REL = {
  logImplementation: 'Log/Implementation',
  logDevRequests: 'Log/DevRequests',
  logStrategy: 'Log/Strategy',
  logSessions: 'Log/Sessions',
  logWarningEvents: 'Log/WarningEvents',
  decisionsProposals: 'Decisions/Proposals',
  decisionsProfile: 'Decisions/Profile',
  knowledge: 'Knowledge',
  knowledgeTopics: 'Knowledge/Topics',
  knowledgeMeta: 'Knowledge/Meta',
  knowledgeInfra: 'Knowledge/Infra',
  knowledgeApi: 'Knowledge/API',
  knowledgeIndexFile: 'Knowledge/Index.md',
  knowledgeMetaIndexFile: 'Knowledge/Meta/Index.md',
  wiringMapFile: 'Knowledge/Meta/므네모시네-파일배선도.md',
  stateBreakoutPositions: 'State/BreakoutPositions',
  stateBreakoutPendingEntries: 'State/BreakoutPendingEntries',
  stateTelegramSession: 'State/TelegramSession',
  stateTelegramSessionHealth: 'State/TelegramSessionHealth',
  stateWikiQuestions: 'State/WikiQuestions',
  stateInstrumentRescoring: 'State/InstrumentRescoring',
  stateQuarterlyAllocationReview: 'State/QuarterlyAllocationReview',
  stateMorningBriefing: 'State/MorningBriefing',
  stateIsaMaturity: 'State/IsaMaturity',
  stateRebalanceProposal: 'State/RebalanceProposal',
  stateRebalanceReminder: 'State/RebalanceReminder',
  stateProposalResponseReminder: 'State/ProposalResponseReminder',
  stateMacroTiltProposal: 'State/MacroTiltProposal',
  factsLedgerExecutions: 'Facts/Ledger/Executions',
  factsLedgerProfits: 'Facts/Ledger/Profits',
  factsRawNotificationsApiCovered: 'Facts/RawNotifications/ExecutionApiCovered',
};

const LEGACY_ABSOLUTE = [
  'Facts/Ledger',
  'Facts/Ledger/Executions',
  'Facts/Ledger/Dividends',
  'Facts/Ledger/FundPurchases',
  'Facts/Ledger/FundValuations',
  'Facts/Ledger/CashEvents',
  'Facts/Ledger/Exchanges',
  'Facts/Ledger/Profits',
  'Facts/Ledger/DailySnapshots',
  'Facts/Ledger/MonthlyBalances',
  'State/Holdings',
  'State/Allocation',
  'State/Baselines',
  'State/JobHealth',
  'State/MarketMoveMonitor',
  'State/MacroOverlay',
  'State/CashAccumulator',
  'State/KillSwitch/KillSwitch.md',
  'State/ExecutionMode/ExecutionMode.md',
  'State/ProposalMode/ProposalMode.md',
  'State/ExecutedOrders/ExecutedOrders.md',
  'State/TelegramSession/last-read.md',
  'State/MacroIndicators/MacroIndicators.md',
  'State/MacroTiltProposal',
  'State/BreakoutPositions',
  'State/BreakoutPendingEntries',
  'State/BreakoutScanRuns/last-run.md',
  'State/ExecutionConfirmations',
  'Log/TelegramSession',
  'Log/Reports',
  'Log/Implementation',
  'Log/DevRequests',
  'Decisions/Evaluations',
  'Decisions/PositionJournal',
  'Decisions/Proposals',
  'Decisions/Profile',
  'Decisions/RiskMonitor',
  'Knowledge/Playbook',
  'Knowledge/Topics',
  'Knowledge/Meta',
  'Knowledge/Infra',
];

test('경로 상수는 고정된 옛 값의 매핑 결과와 같다', () => {
  for (const [key, old] of Object.entries(LEGACY_REL)) {
    assert.equal(VAULT_REL[key], mapLegacyPath(old).to, key);
  }
  const current = Object.entries(VAULT_PATHS).filter(([key]) => key !== 'root' && key !== 'location' && key !== 'spending')
    .flatMap(([, value]) => flattenPaths(value));
  // 신규 Vault 경로가 늘어나도 이관된 옛 경로의 매핑은 계속 존재해야 한다.
  assert.equal(VAULT_PATHS.todoLog, vaultAbs(VAULT_REL.todoLog));
  assert.equal(VAULT_PATHS.spending, vaultAbs(VAULT_REL.spending));
  assert.equal(VAULT_PATHS.location.root, vaultAbs(VAULT_REL.location));
  assert.equal(VAULT_PATHS.location.candidates, vaultAbs(VAULT_REL.locationCandidates));
  for (const old of LEGACY_ABSOLUTE) {
    assert.ok(current.includes(vaultAbs(mapLegacyPath(old).to)), old);
  }
});

test('연도 폴더는 KST 연도를 쓰고 연도 하위 마크다운을 읽는다', () => {
  assert.equal(vaultYearDir('/vault/reports', new Date('2025-12-31T15:00:00Z')), '/vault/reports/2026');
  assert.deepEqual(vaultYearFiles('/path/that/does/not/exist'), []);
  const root = mkdtempSync(join(tmpdir(), 'vault-year-files-'));
  try {
    for (const year of ['2025', '2026']) {
      mkdirSync(join(root, year));
      writeFileSync(join(root, year, `${year}-report.md`), 'report');
    }
    writeFileSync(join(root, 'ignored.md'), 'direct child');
    assert.deepEqual(vaultYearFiles(root).map((file) => file.slice(root.length + 1)).sort(), [
      '2025/2025-report.md', '2026/2026-report.md',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
