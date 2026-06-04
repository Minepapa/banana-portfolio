# 잡 헬스 + 실패 알림 (Job Health & Alerts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 각 launchd 무인 잡(parse-notifications·drain·risk-d·risk-b·report-sync)이 실행마다 "마지막 실행 OK/FAIL + 소요시간 + 로그꼬리"를 `잡상태` 시트에 기록하고, 실패 시 Telegram 으로 즉시 알리며, 앱이 실패·정체(stale) 잡을 배너로 보여준다.

**Architecture:** run.sh 가 잡을 `exec` 대신 포그라운드로 실행해 종료코드·소요시간을 포착하고, 신규 CLI `scripts/record-heartbeat.mjs` 를 호출해 `잡상태` 시트 1잡=1행을 upsert + FAIL 시 `sendTelegram`(sheets-common 재사용). 앱은 `잡상태` 를 별도 read 해 순수 함수 `computeJobHealth` 로 fail/stale 를 판정하고 배너를 띄운다. 순수 로직은 `scripts/lib/job-status.mjs` 와 `src/lib/jobHealth.js` 로 분리해 `node --test` 로 검증한다.

**Tech Stack:** Node ESM 스크립트(.mjs), launchd(macOS), Google Sheets REST(sheets-common.mjs), Telegram Bot API(sendTelegram), React 19(src/App.jsx), Node 내장 test runner.

---

## File Structure

- **Create** `scripts/lib/job-status.mjs` — 순수 upsert 위치 계산(`findStatusRow`).
- **Create** `scripts/lib/job-status.test.js` — `node --test`.
- **Create** `scripts/record-heartbeat.mjs` — CLI: `잡상태` ensureSheet→upsert→FAIL시 Telegram.
- **Create** `src/lib/jobHealth.js` — 순수 `parseJobStatus`, `computeJobHealth`.
- **Create** `src/lib/jobHealth.test.js` — `node --test`.
- **Modify** `scripts/launchd/run.sh` — `exec` 제거, 종료코드·소요시간 포착, record-heartbeat 호출.
- **Modify** `src/App.jsx` — `잡상태` 지연 로드 + 헬스 배너.

기존 sheets-common.mjs 의 `getToken/getRange/appendValues/setValues/ensureSheet/sendTelegram/nowKST` 를 재사용한다(추가 구현 없음).

**잡상태 시트 스키마:** `A=job B=lastRun(KST 'YYYY-MM-DD HH:mm') C=status(OK|FAIL) D=detail E=durationSec`, 1잡=1행.

---

## Task 1: upsert 위치 계산 순수 함수 + 테스트

**Files:**
- Create: `scripts/lib/job-status.mjs`
- Test: `scripts/lib/job-status.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

`scripts/lib/job-status.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStatusRow } from './job-status.mjs';

test('findStatusRow: 기존 잡은 1-based 시트행(A2=2) 반환', () => {
  const rows = [['drain', '2026-06-04 06:00', 'OK', '', '5'],
                ['risk-d', '2026-06-04 07:00', 'FAIL', 'limit', '12']];
  assert.equal(findStatusRow(rows, 'drain'), 2);
  assert.equal(findStatusRow(rows, 'risk-d'), 3);
});

test('findStatusRow: 없는 잡은 null(=append)', () => {
  assert.equal(findStatusRow([['drain', '', 'OK', '', '']], 'risk-b'), null);
  assert.equal(findStatusRow([], 'drain'), null);
  assert.equal(findStatusRow(null, 'drain'), null);
});

test('findStatusRow: 앞뒤 공백 무시', () => {
  assert.equal(findStatusRow([[' drain ', '', 'OK', '', '']], 'drain'), 2);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test scripts/lib/job-status.test.js`
Expected: FAIL — `Cannot find module './job-status.mjs'`

- [ ] **Step 3: 최소 구현 작성**

`scripts/lib/job-status.mjs`:
```js
// 잡상태 시트(A2:E) upsert 위치 계산.
// rows: 기존 A2:E 값 2차원 배열. job 이 있으면 1-based 시트행(A2→2)을, 없으면 null(append) 반환.
export function findStatusRow(rows, job) {
  const target = String(job ?? '').trim();
  const idx = (rows || []).findIndex(r => String(r?.[0] ?? '').trim() === target);
  return idx < 0 ? null : idx + 2;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test scripts/lib/job-status.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**
```bash
git add scripts/lib/job-status.mjs scripts/lib/job-status.test.js
git commit -m "잡상태 upsert 위치 계산 순수함수(findStatusRow) + 테스트"
```

---

## Task 2: record-heartbeat CLI

**Files:**
- Create: `scripts/record-heartbeat.mjs`

CLI 규약: `node scripts/record-heartbeat.mjs <job> <status> <durationSec> [token]`. detail 은 env `HB_DETAIL`(≤200자). status≠OK 면 Telegram 알림.

- [ ] **Step 1: 구현 작성**

`scripts/record-heartbeat.mjs`:
```js
#!/usr/bin/env node
/**
 * 잡 하트비트 기록 — launchd run.sh 가 각 잡 종료 후 호출.
 * 잡상태 시트(1잡=1행)를 upsert 하고, FAIL 이면 Telegram 으로 알린다.
 * 사용: node scripts/record-heartbeat.mjs <job> <status> <durationSec> [token]
 *       HB_DETAIL=<로그꼬리> 환경변수로 detail 전달(선택).
 */
import {
  getToken, getRange, appendValues, setValues, ensureSheet, sendTelegram, nowKST,
} from './lib/sheets-common.mjs';
import { findStatusRow } from './lib/job-status.mjs';

const STATUS_SHEET = '잡상태';
const HEADER = ['job', 'lastRun', 'status', 'detail', 'durationSec'];

const job = process.argv[2];
const status = process.argv[3] || 'OK';
const durationSec = process.argv[4] || '';
const tokenArg = process.argv[5];
const detail = String(process.env.HB_DETAIL || '').slice(0, 200);

async function main() {
  if (!job) { console.error('usage: record-heartbeat <job> <status> <durationSec> [token]'); process.exit(2); }
  const token = await getToken(tokenArg?.trim() || null, { allowBrowser: false });
  await ensureSheet(token, STATUS_SHEET, HEADER);

  const rows = await getRange(token, `${STATUS_SHEET}!A2:E`);
  const rowNum = findStatusRow(rows, job);
  const values = [[job, nowKST(), status, detail, String(durationSec)]];
  if (rowNum) await setValues(token, `${STATUS_SHEET}!A${rowNum}:E${rowNum}`, values);
  else        await appendValues(token, `${STATUS_SHEET}!A2`, values);
  console.log(`🫀 ${job} ${status} ${durationSec}s (행 ${rowNum ?? 'append'})`);

  if (status !== 'OK') {
    try {
      await sendTelegram(`⚠️ <b>banana 잡 실패</b>\njob: <code>${job}</code>\n시각: ${nowKST()}\n${detail || '(detail 없음)'}`);
    } catch (e) { console.error('Telegram 알림 실패(무시):', e.message); }
  }
}

main().catch(e => { console.error('❌ 하트비트 기록 실패:', e.message); process.exit(1); });
```

- [ ] **Step 2: 토큰 없이 동작 점검(인자검증만)**

Run: `node scripts/record-heartbeat.mjs 2>&1 | head -1`
Expected: `usage: record-heartbeat <job> <status> <durationSec> [token]`
(job 누락 → exit 2. 시트 접근 전에 멈추므로 토큰 불필요.)

- [ ] **Step 3: 커밋**
```bash
git add scripts/record-heartbeat.mjs
git commit -m "record-heartbeat CLI — 잡상태 시트 upsert + FAIL 시 Telegram 알림"
```

---

## Task 3: run.sh 가 종료코드·소요시간 포착 후 하트비트 기록

**Files:**
- Modify: `scripts/launchd/run.sh` (33-40 의 case 블록 전체 교체)

`exec`(프로세스 치환)를 제거해야 종료코드를 포착할 수 있다. 잡의 stdout/stderr 는 launchd 가 같은 로그로 리다이렉트하므로, 종료 후 그 로그 꼬리 3줄을 detail 로 넘긴다.

- [ ] **Step 1: case 블록 교체**

run.sh 33-40, 기존:
```bash
case "${1:-}" in
  drain)               exec "$NODE" scripts/drain-eval-queue.mjs --auto ${TOKEN:+"$TOKEN"} ;;
  risk-d)              exec "$NODE" scripts/risk-monitor.mjs --mode=D ${TOKEN:+"$TOKEN"} ;;
  risk-b)              exec "$NODE" scripts/risk-monitor.mjs --mode=B ${TOKEN:+"$TOKEN"} ;;
  report-sync)         exec "$NODE" scripts/sync-reports.mjs ${TOKEN:+"$TOKEN"} ;;
  parse-notifications) exec "$NODE" scripts/parse-notifications.mjs ${TOKEN:+"$TOKEN"} ;;
  *) echo "usage: run.sh {drain|risk-d|risk-b|report-sync|parse-notifications}" >&2; exit 2 ;;
esac
```
교체 후:
```bash
JOB="${1:-}"
case "$JOB" in
  drain)               CMD=(scripts/drain-eval-queue.mjs --auto) ;;
  risk-d)              CMD=(scripts/risk-monitor.mjs --mode=D) ;;
  risk-b)              CMD=(scripts/risk-monitor.mjs --mode=B) ;;
  report-sync)         CMD=(scripts/sync-reports.mjs) ;;
  parse-notifications) CMD=(scripts/parse-notifications.mjs) ;;
  *) echo "usage: run.sh {drain|risk-d|risk-b|report-sync|parse-notifications}" >&2; exit 2 ;;
esac

# 잡을 포그라운드로 실행해 종료코드·소요시간 포착 (exec 금지)
START=$(date +%s)
set +e
"$NODE" "${CMD[@]}" ${TOKEN:+"$TOKEN"}
CODE=$?
set -e
DUR=$(( $(date +%s) - START ))
STATUS=OK; [ "$CODE" -ne 0 ] && STATUS=FAIL

# 하트비트 기록 (잡 실패해도 기록은 시도; 기록 실패는 잡 종료코드를 가리지 않음)
HB_DETAIL="$(tail -n 3 "$LOG_DIR/$JOB.log" 2>/dev/null | tr '\n' ' ' | cut -c1-200)" \
  "$NODE" scripts/record-heartbeat.mjs "$JOB" "$STATUS" "$DUR" ${TOKEN:+"$TOKEN"} || true

exit "$CODE"
```

- [ ] **Step 2: 문법 검사**

Run: `bash -n scripts/launchd/run.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: usage 경로 점검(잘못된 인자)**

Run: `scripts/launchd/run.sh bogus 2>&1 | tail -1; echo "exit=$?"`
Expected: usage 메시지 + `exit=2` (잘못된 잡 이름은 case `*` 에서 즉시 종료).

- [ ] **Step 4: 수동 통합 검증(정직한 한계)**

실제 잡 1회 수동 실행으로 하트비트 적재 확인(서비스 계정 토큰 필요, 이 환경에선 불가할 수 있음):
```bash
scripts/launchd/run.sh parse-notifications
```
Expected: 잡 정상 종료 후 로그 끝에 `🫀 parse-notifications OK <초>s ...`. 실패 시 Telegram 수신.
**한계:** SA 토큰/실시트/launchd 는 이 개발환경에서 완전 재현 불가. 실행자는 빌드·문법검사·단위테스트만 자동 검증하고, 실잡 적재·Telegram·배너는 실제 맥에서 수동 확인할 것(정직 보고).

- [ ] **Step 5: 커밋**
```bash
git add scripts/launchd/run.sh
git commit -m "run.sh: exec 제거·종료코드/소요시간 포착 후 하트비트 기록"
```

---

## Task 4: 앱 헬스 판정 순수 함수 + 테스트

**Files:**
- Create: `src/lib/jobHealth.js`
- Test: `src/lib/jobHealth.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/jobHealth.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobStatus, computeJobHealth } from './jobHealth.js';

const CADENCE = { 'parse-notifications': 1, drain: 6, 'risk-d': 80, 'risk-b': 200 };
const T0 = Date.parse('2026-06-04 12:00');

test('parseJobStatus: A2:E 행을 객체로', () => {
  const rows = [['drain', '2026-06-04 06:00', 'OK', '', '5']];
  assert.deepEqual(parseJobStatus(rows), [
    { job: 'drain', lastRun: '2026-06-04 06:00', status: 'OK', detail: '', durationSec: '5' },
  ]);
});

test('computeJobHealth: status FAIL 은 fail 문제', () => {
  const rows = [{ job: 'risk-d', lastRun: '2026-06-04 07:00', status: 'FAIL', detail: 'limit' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), [{ job: 'risk-d', problem: 'fail', detail: 'limit' }]);
});

test('computeJobHealth: 최근 OK 는 문제 없음', () => {
  const rows = [{ job: 'drain', lastRun: '2026-06-04 09:00', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), []);
});

test('computeJobHealth: cadence 초과 OK 는 stale', () => {
  const rows = [{ job: 'parse-notifications', lastRun: '2026-06-04 09:00', status: 'OK', detail: '' }];
  // parse cadence 1h, 3h 경과 → stale
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), [{ job: 'parse-notifications', problem: 'stale', detail: '' }]);
});

test('computeJobHealth: cadence 미정의 잡은 stale 판정 제외', () => {
  const rows = [{ job: 'unknown', lastRun: '2000-01-01 00:00', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), []);
});

test('computeJobHealth: lastRun 파싱 불가 + cadence 있으면 stale', () => {
  const rows = [{ job: 'drain', lastRun: '', status: 'OK', detail: '' }];
  assert.deepEqual(computeJobHealth(rows, CADENCE, T0), [{ job: 'drain', problem: 'stale', detail: '' }]);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test src/lib/jobHealth.test.js`
Expected: FAIL — `Cannot find module './jobHealth.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/lib/jobHealth.js`:
```js
// 잡상태 시트(A2:E) → 헬스 판정 순수 로직. App.jsx 배너와 테스트가 공유.
export function parseJobStatus(rows) {
  return (rows || [])
    .filter(r => String(r?.[0] ?? '').trim())
    .map(r => ({
      job: String(r[0]).trim(),
      lastRun: String(r[1] ?? '').trim(),
      status: String(r[2] ?? '').trim(),
      detail: String(r[3] ?? '').trim(),
      durationSec: String(r[4] ?? '').trim(),
    }));
}

// cadence: { job: maxAgeHours }. 반환: 문제 잡 [{ job, problem:'fail'|'stale', detail }].
export function computeJobHealth(statusRows, cadence, now = Date.now()) {
  const out = [];
  for (const s of statusRows || []) {
    if (s.status && s.status !== 'OK') { out.push({ job: s.job, problem: 'fail', detail: s.detail || '' }); continue; }
    const maxH = cadence[s.job];
    if (maxH == null) continue;
    const ts = Date.parse(s.lastRun);
    if (isNaN(ts) || (now - ts) > maxH * 3600000) out.push({ job: s.job, problem: 'stale', detail: s.detail || '' });
  }
  return out;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test src/lib/jobHealth.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**
```bash
git add src/lib/jobHealth.js src/lib/jobHealth.test.js
git commit -m "잡 헬스 판정 순수함수(parseJobStatus/computeJobHealth) + 테스트"
```

---

## Task 5: 앱에 헬스 배너 연결

**Files:**
- Modify: `src/App.jsx` (import 구역; 상태/effect 추가; 배너 JSX 삽입)

`잡상태` 를 지연 로드(로그인 시)해 헬스 배너를 띄운다. 기존 `sheets.readRange(...)` 패턴(예: 2020 의 체결내역 지연 로드)과 동일.

- [ ] **Step 1: 삽입 지점 확인(grep)**

Run: `grep -n "kpiTrades === null" src/App.jsx | head -1`
이 effect(체결내역 지연 로드, 2019 부근) 바로 다음에 잡상태 effect 를 둔다. 배너 삽입 지점은:
Run: `grep -n "{/\* ── 체결내역 탭 ── \*/}" src/App.jsx`
앱 셸에서 탭 콘텐츠가 시작되기 직전(탭 네비 직후)을 배너 자리로 쓴다 — 다음 grep 으로 탭 네비 컨테이너를 찾는다:
Run: `grep -n "key: \"체결내역\"" src/App.jsx`

- [ ] **Step 2: import 추가**

App.jsx 상단 import 구역에 추가:
```js
import { parseJobStatus, computeJobHealth } from './lib/jobHealth.js';
```

- [ ] **Step 3: cadence 상수 + 상태 추가**

App.jsx 상단 상수 구역(다른 const 묶음 근처, 예: REBAL_TARGET_START 208 부근)에 추가:
```js
// 잡 헬스 배너용 — 잡별 최대 허용 무갱신 시간(시간). 주말 갭 고려해 risk 류는 넉넉히.
const JOB_CADENCE = { 'parse-notifications': 1, drain: 6, 'risk-d': 80, 'risk-b': 200 };
```
App.jsx 컴포넌트 상태 구역(kpiTrades useState 1399 부근)에 추가:
```js
  const [jobStatus, setJobStatus] = useState(null); // null=미로딩
```

- [ ] **Step 4: 지연 로드 effect 추가**

App.jsx 의 체결내역 지연 로드 effect(`tab === 'kpi' && ... kpiTrades === null` 2019 부근) 다음에 추가:
```js
  useEffect(() => {
    if (sheets.auth === 'signed-in' && jobStatus === null) {
      sheets.readRange('잡상태!A2:E')
        .then(rows => setJobStatus(parseJobStatus(rows)))
        .catch(() => setJobStatus([]));   // 시트 없거나 실패 → 배너 숨김
    }
  }, [sheets.auth, jobStatus]);
```

- [ ] **Step 5: 배너 JSX 삽입**

Step 1 에서 찾은 탭 네비 컨테이너 직후(탭 콘텐츠 시작 전)에 삽입:
```jsx
        {jobStatus && (() => {
          const problems = computeJobHealth(jobStatus, JOB_CADENCE);
          if (problems.length === 0) return null;
          const anyFail = problems.some(p => p.problem === 'fail');
          return (
            <div style={{
              margin: '8px 12px', padding: '8px 12px', borderRadius: 8,
              background: anyFail ? '#2A1416' : '#241F12',
              border: `1px solid ${anyFail ? '#7F1D1D' : '#78510F'}`,
              fontSize: 11, color: anyFail ? '#FCA5A5' : '#FCD34D', textAlign: 'left',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                ⚠️ 무인 잡 점검 필요 {problems.length}건
              </div>
              {problems.map((p, i) => (
                <div key={i} style={{ fontSize: 10, opacity: 0.9 }}>
                  {p.job} — {p.problem === 'fail' ? '실패' : '갱신 정체'}{p.detail ? ` (${p.detail.slice(0, 60)})` : ''}
                </div>
              ))}
            </div>
          );
        })()}
```

- [ ] **Step 6: 빌드 확인**

Run: `npm run build 2>&1 | tail -3`
Expected: 에러 없이 완료.

- [ ] **Step 7: 수동 검증(정직한 한계)**

잡상태 채워진 뷰는 로그인 필요라 시각검증 제한. 빌드 통과 + 콘솔 에러 없음 확인. 배포 후, 실제 잡이 한 번 돌아 `잡상태` 시트가 생긴 뒤 모바일에서 배너 동작 확인. FAIL 행을 시트에 수동 입력해 배너 적색 표시를 미리 검증해도 됨.

- [ ] **Step 8: 커밋 + 푸시**
```bash
git add src/App.jsx
git commit -m "앱 헬스 배너 — 잡상태 지연 로드 + fail/stale 판정 표시"
git push
```

---

## Self-Review

**Spec coverage:**
- "각 잡 마지막 실행 OK/실패 기록" → Task 2(record-heartbeat) + Task 3(run.sh). ✓
- "비정상 종료/실패 시 Telegram" → Task 2(status≠OK → sendTelegram). ✓
- "앱에 stale 배너" → Task 4(computeJobHealth) + Task 5(배너). ✓
- 한도 도달 자동 재시도(별도 제안 4번)는 이 플랜 범위 밖 — FAIL 로 기록·알림까지만. ✓

**Placeholder scan:** 모든 코드 스텝에 실제 코드. Task 5 의 삽입 지점만 grep 으로 특정(셸 구조 미열람분) — 좌표가 아닌 앵커 탐색으로 명시, 컴포넌트 코드는 완전. ✓

**Type consistency:** `findStatusRow(rows, job)` 1-based 반환을 Task2 가 `잡상태!A${rowNum}:E${rowNum}` 에 사용 — 일치. `parseJobStatus` 출력 객체 키(job/lastRun/status/detail/durationSec)가 `computeJobHealth` 입력·Task5 배너 사용과 일치. 시트 스키마 A2:E 5열이 HEADER·record-heartbeat values·parseJobStatus 인덱스에서 모두 동일. ✓

**검증 한계(정직):** SA 토큰·실시트·launchd·Telegram 은 개발환경 재현 불가. 자동 검증은 단위테스트(node --test)·빌드·`bash -n` 까지. 실잡 적재/알림/배너는 실제 맥 수동 확인.

---

## Execution Handoff

Plan complete. Two execution options:
1. **Subagent-Driven (recommended)** — task별 신규 서브에이전트 + 중간 리뷰.
2. **Inline Execution** — 이 세션에서 executing-plans 로 체크포인트 배치 실행.

**권장 순서:** 본 플랜(잡 헬스)부터 — 빠르게 관측성 확보 후 종목 정체성 플랜 진행.
