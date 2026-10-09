// 므네모시네(Vault) 잡 카탈로그 문서 드리프트 구조적 가드 — 2026-08-29, 오너 지시
// ("절대로 기록이 누락되거나 뒤쳐진 정보가 있으면 안 된다").
//
// 배경 — 같은 날 세션에서 실제로 발견된 문서 드리프트 5건:
//   1. sync-firestore-mirror·update-holdings-prices·update-allocation-from-holdings가
//      2026-08-25에 30분→10분으로 단축됐는데 README.md엔 3주 가까이 "30분마다"로 잔존.
//   2. daily-execution-report(2026-08-24 신설)가 weekly-schedule-summary.mjs의
//      SCHEDULE 배열·텔레그램 발신 카탈로그 둘 다에서 누락.
//   3~5. rebalance-proposal·quarterly-allocation-review·proposal-execution-reminder가
//      신설 당시부터 텔레그램 발신 카탈로그에 한 번도 등록된 적 없음.
// 5건 다 "코드는 맞게 배선했는데 Vault 문서 갱신을 빠뜨림" — health-watcher.test.js가
// EXPECTED_INTERVALS_MS 누락을 막는 것과 정확히 같은 클래스의 실수다. 그 파일이 이미
// 증명한 원칙("기억해서 채워넣기는 구조적으로 안 지켜진다, 테스트로 강제해야 한다")을
// 여기 그대로 적용한다.
//
// 이 파일이 잡는 것: launchd로 실제 스케줄링되는 잡(run.sh 디스패치 대상)이
//   ① Knowledge/Jobs/무인잡-카탈로그.md에 이름이 아예 안 보이는 경우(신규 잡 완전 누락)
//   ② StartInterval(분 단위) 스케줄인데 그 문서의 잡 행에 적힌 분 표기가
//      실제 plist 값과 다른 경우(스케줄 변경 후 문서 미갱신)
//   ③ 소스가 DEPARTMENT_LABEL을 정의(오너에게 부서 라벨로 텔레그램을 보낼 수 있다는 뜻)
//      하는데 텔레그램 발신 카탈로그에 그 스크립트 파일명이 전혀 안 보이는 경우
// 안 잡는 것(의도적 범위 밖): launchd로 안 도는 이벤트 스크립트(process-telegram-
// reply.mjs 등, run.sh 디스패치 밖), StartCalendarInterval 스케줄의 숫자 검증(요일·
// 날짜 조합이 자유서술 문장과 1:1 대응이 안 돼 신뢰성 있게 파싱 불가 — 대신 ①로
// "그 잡 이름이 문서에 있는지"까지는 잡는다), 무인잡-카탈로그.md 외 다른 프로즈 정확성.
//
// ⚠️ 이 스위트는 이 Mac(로컬 개발 환경)에서만 의미가 있다 — `plutil`(macOS 전용)과
// 별도 Vault(`VAULT_PATHS.root`, CI엔 없음) 둘 다 필요하다. 이 저장소
// GitHub Actions(`deploy.yml`)는 애초에 npm test를 안 돌리므로 CI 파손 위험은 없지만,
// 혹시 다른 환경에서 돌 경우를 대비해 둘 다 없으면 조용히 스킵한다(실패가 아니라
// "이 환경에서 검증 불가"로 처리 — 로컬 개발 세션에서 항상 돈다는 게 핵심 보장이지,
// 모든 환경에서 강제하는 게 아니다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { SCHEDULE } from './weekly-schedule-summary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHD_DIR = join(__dirname, '..', 'launchd');
// 2026-08-29: README.md → 무인잡-카탈로그.md로 개명("README"는 어디서나 쓰이는 일반
// 명칭이라 무슨 노트인지 알기 어렵다는 오너 지적). 2026-09-04: Knowledge/Jobs/ →
// Knowledge/Meta/로 이동(므네모시네 대정리 — "볼트 전체가 바뀔 때 일괄 갱신해야
// 하는 문서"를 Index.md·사용안내·파일배선도와 한 폴더로 통합, 오너 지시).
const JOB_CATALOG_PATH = vaultAbs(VAULT_REL.jobCatalogFile);
const DEPT_DOC_PATH = vaultAbs(VAULT_REL.departmentReportFile);

const PLUTIL_AVAILABLE = (() => {
  try { execFileSync('plutil', ['-help'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const CAN_RUN = process.platform === 'darwin' && PLUTIL_AVAILABLE && existsSync(JOB_CATALOG_PATH) && existsSync(DEPT_DOC_PATH);

// run.sh의 case문에서 잡 이름 + 실제 스크립트 경로를 함께 뽑는다(health-watcher.test.js
// listDispatchedJobs와 같은 정규식 전략, 여기선 스크립트 경로까지 필요해 별도 구현).
function listDispatchedJobs() {
  const runSh = readFileSync(join(LAUNCHD_DIR, 'run.sh'), 'utf8');
  return [...runSh.matchAll(/^\s*([a-z][a-z0-9-]*)\)\s+CMD=\(([^)]+)\)/gm)]
    .map((m) => ({ job: m[1], scriptPath: m[2].trim() }));
}

function readPlistSchedule(job) {
  const plistPath = join(LAUNCHD_DIR, `com.banana2.${job}.plist`);
  if (!existsSync(plistPath)) return null;
  const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }));
  return { startIntervalSec: json.StartInterval ?? null };
}

function isDepartmentFacing(scriptPath) {
  const abs = join(__dirname, '..', '..', scriptPath);
  if (!existsSync(abs)) return false;
  return readFileSync(abs, 'utf8').includes('SENDER_AGENT');
}

function senderAgentFor(scriptPath) {
  const source = readFileSync(join(__dirname, '..', '..', scriptPath), 'utf8');
  return source.match(/const SENDER_AGENT = '([a-z]+)'/)?.[1] ?? null;
}

function documentedAgentFor(deptDoc, filename) {
  let section = '';
  for (const line of deptDoc.split('\n')) {
    if (line.startsWith('## ')) section = line;
    if (section.startsWith('## 주기적 발신 한눈에 보기')) continue; // 요약표(담당 절 아님)는 대조하지 않는다
    if (line.startsWith('|') && line.includes(`\`${filename}\``)) {
      const englishName = section.match(/(Athena|Kairos|Themis|Hermes|Apollo|Plutus|Clio|Zeus)$/)?.[1];
      return englishName?.toLowerCase() ?? '(부서 표기 불명)';
    }
  }
  return null;
}

function catalogRowForJob(catalog, job) {
  return catalog.split('\n').find((line) => line.trimStart().startsWith('|') && (
    line.includes(`\`${job}\``)
    || line.includes(`[[${relative(VAULT_PATHS.root, VAULT_PATHS.state.jobHealth)}/${job}|${job}]]`)
    || line.includes(`[[${job}|${job}]]`)
  ));
}

// 텔레그램 발신 카탈로그 표에서 "**주기적**"이면서 보고시점에 "분기"·"매월"·"매년"이
// 없는(=매주 반복되는) 행의 스크립트 파일명만 뽑는다. 분기 단위 잡(rebalance-proposal·
// quarterly-allocation-review)·월 단위 잡(pension-balance-reminder, 2026-09-04
// 신설, monthly-macro-tilt-proposal, 2026-09-06 신설)·연 단위 잡(annual-instrument-
// rescore, 2026-09-06 신설)은 weekly-schedule-summary.mjs가 "이번 주" 요약이라 설계상
// 의도적으로 빠지므로 제외한다(그 잡 헤더 주석 참고).
function listWeeklyPeriodicSenders(deptDoc) {
  const result = [];
  for (const row of deptDoc.split('\n')) {
    if (!row.includes('**주기적**')) continue;
    const cells = row.split('|').map((c) => c.trim());
    const senderCell = cells[1] ?? '';
    const timingCell = cells[3] ?? '';
    if (timingCell.includes('분기') || timingCell.includes('매월') || timingCell.includes('매년')) continue;
    const m = senderCell.match(/`([a-zA-Z0-9_-]+\.mjs)`/);
    if (m) result.push(m[1]);
  }
  return result;
}

test('vault-job-catalog-audit: launchd로 도는 잡은 전부 무인잡-카탈로그.md 표 행에 있어야 함(신규 잡 누락 방지)', { skip: !CAN_RUN }, () => {
  const catalog = readFileSync(JOB_CATALOG_PATH, 'utf8');
  const jobs = listDispatchedJobs();
  assert.ok(jobs.length > 10, 'run.sh case문 파싱이 깨졌을 가능성 — 잡 이름이 거의 안 뽑힘');
  const missing = jobs.filter(({ job }) => !catalogRowForJob(catalog, job)).map(({ job }) => job);
  assert.deepEqual(missing, [], `무인잡-카탈로그.md에 이름이 없는 잡: ${missing.join(', ')} — 90_Delphi/Schema/무인잡-카탈로그.md 스케줄 표에 행을 추가할 것`);
});

test('vault-job-catalog-audit: StartInterval(분 단위) 잡은 무인잡-카탈로그.md 표기 분이 실제 plist 값과 일치해야 함(스케줄 변경 후 문서 미갱신 방지)', { skip: !CAN_RUN }, () => {
  const catalog = readFileSync(JOB_CATALOG_PATH, 'utf8');
  const jobs = listDispatchedJobs();
  const mismatched = [];
  for (const { job } of jobs) {
    const schedule = readPlistSchedule(job);
    if (!schedule || schedule.startIntervalSec == null) continue; // StartCalendarInterval 잡은 범위 밖(위 헤더 주석 참고)
    const minutes = schedule.startIntervalSec / 60;
    const row = catalogRowForJob(catalog, job);
    if (!row) continue; // 첫 번째 테스트가 이미 누락을 잡음 — 여기선 중복 보고 안 함
    if (!row.includes(`${minutes}분마다`)) {
      mismatched.push(`${job}(plist=${minutes}분마다, 카탈로그 행에서 "${minutes}분마다" 못 찾음)`);
    }
  }
  assert.deepEqual(mismatched, [], `무인잡-카탈로그.md 분 표기가 plist와 다른 잡: ${mismatched.join('; ')}`);
});

test('vault-job-catalog-audit: SENDER_AGENT를 정의하는 잡은 전부 텔레그램 발신 카탈로그에 파일명이 있어야 함(신규 발신처 누락 방지)', { skip: !CAN_RUN }, () => {
  const deptDoc = readFileSync(DEPT_DOC_PATH, 'utf8');
  const jobs = listDispatchedJobs();
  const missing = jobs
    .filter(({ scriptPath }) => isDepartmentFacing(scriptPath))
    .map(({ scriptPath }) => basename(scriptPath))
    .filter((filename) => !deptDoc.includes(filename));
  assert.deepEqual(missing, [], `텔레그램 발신 카탈로그에 없는 발신처: ${missing.join(', ')} — 해당 부서 표에 행을 추가할 것`);
});

test('vault-job-catalog-audit: 발신 잡의 SENDER_AGENT와 볼트 보고 카탈로그 부서가 일치', { skip: !CAN_RUN }, () => {
  const deptDoc = readFileSync(DEPT_DOC_PATH, 'utf8');
  const mismatches = listDispatchedJobs().flatMap(({ scriptPath }) => {
    const agent = senderAgentFor(scriptPath);
    if (!agent) return [];
    const filename = basename(scriptPath);
    const documented = documentedAgentFor(deptDoc, filename);
    return documented && documented !== agent ? [`${filename}: 코드=${agent}, 볼트=${documented}`] : [];
  });
  assert.deepEqual(mismatches, [], `텔레그램 발신 카탈로그 표기 불일치(문서는 사람이 수정):\n${mismatches.join('\n')}`);
});

test('vault-job-catalog-audit: 텔레그램 발신 카탈로그의 "매주" 주기적 발신처는 전부 weekly-schedule-summary.mjs SCHEDULE 배열에도 있어야 함(daily-execution-report 누락 재발 방지)', { skip: !CAN_RUN }, () => {
  const deptDoc = readFileSync(DEPT_DOC_PATH, 'utf8');
  const weeklyPeriodic = listWeeklyPeriodicSenders(deptDoc);
  assert.ok(weeklyPeriodic.length > 0, '텔레그램 발신 카탈로그 파싱이 깨졌을 가능성 — 매주 주기적 발신처가 하나도 안 뽑힘');
  const scheduledScripts = new Set(SCHEDULE.map((s) => s.script));
  const missing = weeklyPeriodic.filter((script) => !scheduledScripts.has(script));
  assert.deepEqual(missing, [], `weekly-schedule-summary.mjs SCHEDULE 배열에 없는 주기적 발신처: ${missing.join(', ')} — SCHEDULE 배열에 항목을 추가할 것(분기 단위 잡은 의도적으로 제외 대상)`);
});

// 2026-10-10: 발신 카탈로그의 "주기적 발신 한눈에 보기" 표(사람이 읽는 사본)가 SCHEDULE 정본과 어긋나지 않게 한다.
// 이 표는 예전 6건 그대로 옛 부서명(운영실·투자전략실 등)이 남은 채 방치됐었다(오너 지적).
function readWeeklySummaryTable(deptDoc) {
  const start = deptDoc.indexOf('## 주기적 발신 한눈에 보기');
  if (start < 0) return null;
  const end = deptDoc.indexOf('\n## ', start + 1);
  return deptDoc.slice(start, end < 0 ? undefined : end).split('\n')
    .filter((line) => /^\|\s*(매일|평일|주말|일요일|월요일|화요일|수요일|목요일|금요일|토요일)\s*\|/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map((cells) => `${cells[1]} ${cells[2]} ${cells[5].match(/`([a-zA-Z0-9_-]+\.mjs)`/)?.[1] ?? '?'}`);
}

test('vault-job-catalog-audit: 발신 카탈로그 "주기적 발신 한눈에 보기" 표는 SCHEDULE(요일·시각·발신처)과 정확히 같아야 함', { skip: !CAN_RUN }, () => {
  const rows = readWeeklySummaryTable(readFileSync(DEPT_DOC_PATH, 'utf8'));
  assert.ok(rows, '"## 주기적 발신 한눈에 보기" 절이 없음');
  const expected = SCHEDULE.map((s) => `${s.day} ${s.time} ${s.script}`).sort();
  assert.deepEqual([...rows].sort(), expected, '발신 카탈로그 요약표를 weekly-schedule-summary.mjs SCHEDULE과 맞출 것(요일·시각·발신처)');
});
