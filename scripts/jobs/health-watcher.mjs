#!/usr/bin/env node
/**
 * 독립 장애감지 워처 (v2) — docs/ARCHITECTURE-V2.md "장애감지 — 독립 워처 + 하트비트" 절.
 *
 * 다른 잡들의 성공 여부와 무관하게 **이 잡 스스로** 30분마다 launchd로 실행돼(다른
 * 잡·상시 세션과 완전히 독립) 두 가지를 확인한다:
 *   1) 각 잡의 하트비트(State/JobHealth/*.md)가 기대 주기의 2배 이상 조용한지
 *   2) 상시 텔레그램 세션(claude --channels ...) 프로세스가 살아있는지 — Phase 5에서
 *      그 세션이 실제로 생기기 전까지는 WATCH_TELEGRAM_SESSION=1 환경변수가 없으면
 *      건너뛴다(아직 없는 프로세스를 "죽었다"고 오탐하지 않기 위함)
 * 이상 감지 시 텔레그램으로 직접 알림을 보낸다(sendTelegram — 상시 세션과 무관하게
 * 독립 동작 가능, telegram.mjs 참고).
 *
 * 사용법: node scripts/jobs/health-watcher.mjs [--dry-run]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, isStale } from '../lib/job-health.mjs';
import { sendTelegram, getTelegramWebhookInfo } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';
import { describeJob, JOB_REMEDIATION } from '../lib/job-labels.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { isProcessAlive, isPollingStuck, TELEGRAM_SESSION_PROCESS_PATTERN } from '../lib/telegram-session-liveness.mjs';

// telegram-session-health-check.mjs와 공유하는 isPollingStuck을 예전 import 경로
// (`from './health-watcher.mjs'`)로도 계속 쓸 수 있게 재수출(2026-08-31, 코드리뷰
// 지적으로 lib/telegram-session-liveness.mjs로 이관 — health-watcher.test.js가
// 기존 경로로 이미 import하고 있어 그 파일은 안 건드림).
export { isPollingStuck };

const DRY_RUN = process.argv.includes('--dry-run');

// 이 잡(health-watcher) 자체가 보내는 텔레그램 알림의 부서 라벨 — 판테온 조직에서
// "장부·데이터·인프라 배관"을 담당하는 운영실(Hermes) 소관(v1 JOB_DEPARTMENT 매핑의
// 'backup'·'parse-notifications'·'realtime-quotes' 등이 전부 hermes였던 것과 동일 원칙).
// 2026-08-14 오너 지적 — 알림에 어느 잡을 감시하는 건지·어느 부서 소관인지 표기 안 돼
// 있어 헷갈렸음, formatDepartmentMessage(기존 부서 메시지 포맷)로 통일.
const DEPARTMENT_LABEL = '운영실 Hermes';

// 잡별 기대 실행 주기 — 새 v2 잡이 생길 때마다 여기 추가한다(구현계획서 Phase 5+).
// 값이 없는 잡은 기본값(EXPECTED_INTERVAL_DEFAULT_MS)을 쓴다.
//
// ⚠️ 전수 재점검(2026-08-23, 오너 지시 — "지금 적용한 사항 모든 잡에 동일하게") —
// update-monthly-balance-snapshot·weekly-report 오알람을 고치면서, 등록된 launchd
// 잡 16개 전체를 실제 StartCalendarInterval/StartInterval과 대조했다. 이 표가
// "새 잡 추가 시 누락"뿐 아니라 "평일 전용 잡의 주말 간격"도 놓치고 있었다 —
// 둘 다 여기서 함께 고친다.
export const EXPECTED_INTERVALS_MS = {
  // ⚠️ 재수정(2026-08-28, 오너 지시) — 평일 16:00 하루 1회(StartCalendarInterval)에서
  // 상시 10분 간격(StartInterval=600)으로 변경. 아래 sync-firestore-mirror 등과 동일
  // 이유로 등록값도 실제 주기와 같이 움직여야 한다.
  'parse-notifications-to-vault': 10 * 60 * 1000,
  // ⚠️ 버그 수정(2026-08-14, 오너 신고 — 30분마다 알람 반복) — backup-vault는 밤 23:50
  // 하루 1회만 도는 잡인데(scripts/launchd/com.banana2.backup-vault.plist,
  // StartCalendarInterval) 여기 항목이 없어 기본값(1시간)이 적용됐다. 그 결과 정상
  // 실행 후 2시간(기대주기×2)만 지나면 매일 "조용하다"고 오판해 다음날 23:50까지
  // 22시간 동안 30분마다 계속 알림이 나갔다 — 이 잡을 처음 활성화할 때(2026-08-13)
  // backup-vault의 실제(하루 1회) 주기를 안 넣은 설정 누락. (⚠️ 이 잡은 요일 제한이
  // 없는 매일 실행이라 위 평일전용 잡들과 달리 24h를 그대로 유지 — 주말 간격 문제
  // 없음.)
  'backup-vault': 24 * 60 * 60 * 1000,
  // telegram-session-handoff(2026-08-29 신설) — 매일 03:55 KST 하루 1회, 요일 제한
  // 없음(텔레그램 세션 자체가 주말에도 응답하므로 restart와 동일 원칙) — backup-vault와
  // 같은 클래스.
  'telegram-session-handoff': 24 * 60 * 60 * 1000,
  // daily-asset-allocation-check도 backup-vault와 같은 이유로 하루 1회 잡 — 처음부터
  // 여기 넣어 같은 오탐이 재발하지 않게 한다(2026-08-14). ⚠️ 평일 전용이라 2026-08-23
  // 48h로 상향(위 parse-notifications-to-vault 주석과 동일 사유).
  'daily-asset-allocation-check': 48 * 60 * 60 * 1000,
  // update-holdings-from-executions(2026-08-15 신설 스케줄) — 로직 자체는 이미 있었지만
  // (퀀트 체결은 KIS API가 정본이라 skip, 그 외 자산분배 트랙 체결만 반영) 무인 스케줄이
  // 없어 watch-order-fill.mjs의 퀀트 트리거에만 의존하던 잡. 평일 16:05 KST 하루 1회
  // (parse-notifications-to-vault 16:00 직후). ⚠️ 평일 전용, 2026-08-23 48h로 상향.
  'update-holdings-from-executions': 48 * 60 * 60 * 1000,
  // new-cash-allocation은 2026-08-16 신설 다음날(08-17) 10배 부풀림 사고로 잠정
  // 중단됐다가, 예수금앵커 배선 완료 후 실잔고 기반으로 전면 재작성돼 2026-08-18
  // 재활성화됐다(오너 확인) — 상세 경위는 job-labels.mjs·new-cash-allocation.mjs
  // 헤더 주석 참고. 평일 16:13 하루 1회(update-cash-from-ledger 16:10 직후).
  // ⚠️ 평일 전용, 2026-08-23 48h로 상향.
  'new-cash-allocation': 48 * 60 * 60 * 1000,
  // reconcile-irp·update-cash-from-ledger(2026-08-18 신설 — 예수금앵커 배선 마지막
  // 조립) 둘 다 평일 16:07·16:10 하루 1회. ⚠️ 평일 전용, 2026-08-23 48h로 상향.
  // ⚠️ 2026-09-03(마이그레이션 3단계, "통일 루프 깸") — reconcile-irp는 이제
  // CashEvent가 아니라 State/Holdings를 직접 기록. update-cash-from-ledger는
  // API 없는 ISA·연금저축 2계좌만 처리(6→2계좌 범위축소). reconcile-nh-cash 신설
  // (위탁·CMA·금현물, 평일 16:08) — 같은 배치그룹이라 동일 48h 간격.
  'reconcile-irp': 48 * 60 * 60 * 1000,
  'reconcile-nh-cash': 48 * 60 * 60 * 1000,
  'update-cash-from-ledger': 48 * 60 * 60 * 1000,
  // reconcile-irp-executions(평일 15:50)·reconcile-nh-executions(평일 15:55) —
  // 마이그레이션 2·4단계(2026-09-03 신설), update-holdings-from-executions(16:05)
  // 보다 먼저 돌아 그날 체결을 그날 안에 반영. 같은 배치그룹 관례로 48h.
  'reconcile-irp-executions': 48 * 60 * 60 * 1000,
  'reconcile-nh-executions': 48 * 60 * 60 * 1000,
  // ⚠️ 버그 수정(2026-08-23, 오너 신고 — 리포트는 실제로 발행됐는데 "조용하다" 오알람) —
  // backup-vault와 완전히 같은 클래스의 재발이다: 이 두 잡을 추가할 때 기본값(1시간)
  // 이 적용된 채 여기 등록을 안 해서, 정상 실행 후 2시간만 지나면 매번 오탐이 났다.
  // update-monthly-balance-snapshot은 매일 23:50 KST 1회(com.banana2.update-monthly-
  // balance-snapshot.plist StartCalendarInterval) — 요일 제한 없이 매일이라 24h 유지.
  'update-monthly-balance-snapshot': 24 * 60 * 60 * 1000,
  // weekly-report는 매주 일요일 08:00 KST 1회(com.banana2.weekly-report.plist
  // Weekday:0, 2026-08-23 03:00→08:00 재조정). 60분 기준이면 실행 직후에도 항상
  // "조용하다"로 잘못 잡힌다.
  'weekly-report': 7 * 24 * 60 * 60 * 1000,
  // ── 2026-08-23 전수 재점검에서 새로 발견한 누락(이전엔 오탐이 아니라 "실제보다
  // 느슨하게"만 감시되고 있었다 — 60분 기본값이 각 잡의 실제 주기보다 커서, 진짜
  // 멈춰도 최대 2시간까지는 못 잡았다는 뜻. false negative 쪽 갭이라 오너 신고가
  // 없었을 뿐 같은 종류의 설정 누락) ──
  // execute-quant: com.banana2.execute-quant.plist StartInterval=300(5분마다). 퀀트
  // 트랙 실주문 집행 잡이라 감시 지연이 가장 부담스러운 축 — 5분 그대로 등록.
  'execute-quant': 5 * 60 * 1000,
  // sync-firestore-mirror·update-allocation-from-holdings·update-holdings-prices
  // 셋 다 StartInterval=600(10분마다, 2026-08-25 오너 지시로 30분→10분 단축) —
  // 대시보드가 읽는 미러/시세/자산분배 갱신. 세 잡이 항상 같은 주기여야 한다는 원칙은
  // 그대로(위 update-allocation-from-holdings.plist 주석 참고) — 여기 값도 실제
  // StartInterval과 같이 움직여야 한다(등록값이 실제 주기보다 느슨하면 진짜 정지를
  // 늦게 잡는다, 2026-08-24 EXPECTED_INTERVALS_MS 신설 취지와 동일).
  'sync-firestore-mirror': 10 * 60 * 1000,
  'update-allocation-from-holdings': 10 * 60 * 1000,
  'update-holdings-prices': 10 * 60 * 1000,
  // intraday-portfolio-sync(2026-09-03 신설) — 같은 10분 패턴(StartInterval=600).
  // 위 세 잡과 동일 원칙: 등록값이 실제 주기와 정확히 같아야 진짜 정지를 늦게
  // 안 잡는다.
  'intraday-portfolio-sync': 10 * 60 * 1000,
  // telegram-session-health-check(2026-08-31 신설) — 상시 텔레그램 세션 MCP 연결
  // 끊김 감지·자동복구 잡 자체도 StartInterval=600(10분마다). 이 잡이 조용해지면
  // "그 조용해짐을 감지해 복구할 다른 무엇"이 없다는 게 health-watcher 자기 자신과
  // 같은 구조적 한계(바로 아래 주석 참고) — 그래도 최소한 이 등록으로 health-watcher
  // 자신이 살아있는 한은 잡힌다.
  'telegram-session-health-check': 10 * 60 * 1000,
  // intraday-market-move-monitor(2026-09-01 신설) — 텔레그램 메시지 2단계, 장중 시장
  // 급변 감시. StartInterval=600(10분), telegram-session-health-check와 동일 클래스.
  // ⚠️ 이 잡은 장 마감 후·주말엔 실행돼도 즉시 조용히 종료하는 게 정상 동작(isKrMarketOpen
  // ||isUsMarketOpen 게이트) — run.sh가 종료코드 0으로 하트비트를 남기므로 stale 오탐 없음.
  'intraday-market-move-monitor': 10 * 60 * 1000,
  // health-watcher 자기 자신도 StartInterval=1800(30분마다)이라 등록 — 다만 여기 등록해도
  // 구조적 사각은 남는다: findStaleJobs는 health-watcher **자신이 실행될 때만** 호출된다.
  // health-watcher 프로세스 자체가(launchd unload·크래시 등으로) 아예 안 돌기 시작하면
  // 아무도 그 정지를 감지하지 못한다 — "감시자가 감시자 자신의 죽음은 못 본다"는
  // 구조적 한계, 이 등록 하나로는 못 고친다(별도 외부 워치독이 필요, 아직 없음).
  'health-watcher': 30 * 60 * 1000,

  // ── 2026-08-24 다섯 번째 재발(오너 신고 — weekly-schedule-summary 오알람) ──
  // 이 파일 자체가 "새 v2 잡이 생길 때마다 여기 추가한다"고 2026-08-14부터 프로즈로
  // 적어뒀는데도 그새 backup-vault·daily-asset-allocation-check(08-14), update-monthly-
  // balance-snapshot·weekly-report(08-23), 그리고 이번 6개(08-24)까지 같은 클래스의
  // 누락이 다섯 번째로 반복됐다 — "기억해서 채워넣기"는 구조적으로 안 지켜진다는 뜻.
  // 그래서 이번엔 프로즈 주석 추가에서 그치지 않고, health-watcher.test.js에 "run.sh가
  // 디스패치하는 모든 잡은 반드시 여기 등록돼 있어야 한다"는 걸 강제하는 테스트를
  // 추가했다(scripts/launchd/*.plist ↔ EXPECTED_INTERVALS_MS 키 대조) — 앞으로 새 잡을
  // run.sh에 추가하고 여기 등록을 빠뜨리면 npm test가 그 자리에서 실패한다. 프로즈
  // 규칙을 CI가 강제하는 불변식으로 승격한 것 — 이게 이 세션 전체가 반복해온 원칙
  // ("기억하지 말고 구조로 막을 것")과 같은 결의 수정이다.
  //
  // weekly-schedule-summary·themis-risk-review — 매주 1회(월요일 07:00·일요일 07:00
  // KST). weekly-report와 동일 패턴이라 그대로 7일.
  'weekly-schedule-summary': 7 * 24 * 60 * 60 * 1000,
  'themis-risk-review': 7 * 24 * 60 * 60 * 1000,
  // morning-briefing·proposal-execution-reminder — 평일 전용 하루 1회(각각 08:00·
  // 09:10 KST). 위 parse-notifications-to-vault 등과 동일 사유로 48h(금~월 72시간
  // 간격에 여유를 더한 값). rebalance-proposal은 2026-08-29 분기 전환으로 아래
  // quarterly-allocation-review와 같은 그룹으로 이동했다(바로 아래 참고).
  'morning-briefing': 48 * 60 * 60 * 1000,
  'proposal-execution-reminder': 48 * 60 * 60 * 1000,
  // daily-execution-report(2026-08-24 신설, 오너 명시 요청 — 장마감 이후 당일 체결내역
  // 텔레그램 보고) — 평일 16:15 KST 하루 1회. 위 평일전용 잡들과 동일 사유로 48h
  // (금~월 72시간 간격에 여유를 더한 값).
  'daily-execution-report': 48 * 60 * 60 * 1000,
  // quarterly-allocation-review — 분기 시작월(1·4·7·10월) 1~3일에 launchd가 3일 연속
  // 실행되지만(run.sh가 매번 record-heartbeat-vault를 부르므로 heartbeat 자체는 3일
  // 연속 남음), 잡 내부 dedup(shouldRunToday)으로 실제 판단·발송은 분기당 1회뿐이다.
  // 즉 실제 heartbeat 간격은 "3일 연속 찍힘 → 최대 약 92일(10/3→1/1) 공백"인 불규칙
  // 패턴 — 짧은 쪽(하루~이틀)에 맞추면 분기 사이 공백에서 매번 오알람, 긴 쪽에
  // 맞추면 그 며칠의 burst 안에서는 문제 없다. 최대 공백(약 92일)+여유를 100일로 잡고
  // ×2=200일 문턱 — 분기 burst를 두 번 연속 통째로 놓쳐야만(약 6개월 무응답) 알람이
  // 뜬다. 분기 1회짜리 순수 의견보고 잡이라 이 정도 지연 허용은 합리적(daily 배관
  // 잡처럼 즉각 감지가 필요한 성격이 아님).
  'quarterly-allocation-review': 100 * 24 * 60 * 60 * 1000,
  // rebalance-proposal — 2026-08-29 평일 매일→분기 전환(위 quarterly-allocation-review와
  // 완전히 동일한 트리거 패턴, 같은 이유로 같은 값). daily-asset-allocation-check(거시
  // 오버레이 전용으로 축소)와 혼동하지 말 것 — 그 잡은 계속 매일 돈다.
  'rebalance-proposal': 100 * 24 * 60 * 60 * 1000,
  // isa-maturity-check(2026-08-29 신설) — 매주 월 07:10, 실제 이벤트(ISA 3년 만기
  // 2028-04-06)는 ~1.5년 뒤 1회뿐이지만 heartbeat 자체는 매주 남는다 — weekly-
  // schedule-summary와 동일 클래스(7일).
  'isa-maturity-check': 7 * 24 * 60 * 60 * 1000,
  // weekly-vault-health-check(2026-09-04 신설) — 매주 일 07:30, isa-maturity-check와
  // 동일 클래스(저정보 억제라 텔레그램 발송 없는 주도 많지만 heartbeat 자체는 매주).
  'weekly-vault-health-check': 7 * 24 * 60 * 60 * 1000,
  // pension-balance-reminder(2026-09-04 신설) — 매월 22일, rebalance-proposal(분기,
  // 100일)과 동일 원칙으로 달 길이(28~31일) 편차를 흡수하는 여유(35일)를 둔다.
  'pension-balance-reminder': 35 * 24 * 60 * 60 * 1000,
};
const EXPECTED_INTERVAL_DEFAULT_MS = 60 * 60 * 1000;

// 텔레그램 상시세션 프로세스 감시 — 그 세션 자체가 Phase 5 산출물이라 아직 없다.
// 환경변수로 명시적으로 켜지 않으면 이 체크는 건너뛴다(오탐 방지).
const WATCH_TELEGRAM_SESSION = process.env.WATCH_TELEGRAM_SESSION === '1';

export function findStaleJobs(jobHealthDir, { now = new Date(), expectedIntervals = EXPECTED_INTERVALS_MS, defaultIntervalMs = EXPECTED_INTERVAL_DEFAULT_MS } = {}) {
  if (!existsSync(jobHealthDir)) return [];
  const stale = [];
  for (const file of readdirSync(jobHealthDir)) {
    if (!file.endsWith('.md')) continue;
    const job = file.replace(/\.md$/, '');
    const record = parseFrontmatter(readFileSync(join(jobHealthDir, file), 'utf8'));
    const expectedIntervalMs = expectedIntervals[job] ?? defaultIntervalMs;
    if (isStale({ lastRun: record.lastRun, expectedIntervalMs, now })) {
      stale.push({ job, lastRun: record.lastRun ?? null, expectedIntervalMs });
    }
  }
  return stale;
}

// s: findStaleJobs()가 반환한 { job, lastRun, expectedIntervalMs } 하나. 순수 함수 —
// describeJob·JOB_REMEDIATION 조회만 하고 I/O 없음. 잡 이름만 영어로 나오면 오너가
// 어떤 잡인지 못 알아본다(2026-08-17 지적) — describeJob으로 한글 설명을 괄호로
// 덧붙인다. 2026-08-23(오너 지시) — 알려진 조치사항이 있는 잡이면 바로 뭘 확인해야
// 하는지 덧붙인다(JOB_REMEDIATION). 없는 잡은 그냥 안 붙는다 — 근거 없는 일반론을
// 채우지 않는다는 그 파일의 원칙 그대로.
export function formatStaleJobIssue(s) {
  const lastRunDesc = s.lastRun ? `마지막 실행 ${s.lastRun}` : '실행 기록 없음';
  let line = `잡 <code>${describeJob(s.job)}</code>이(가) 조용합니다 — ${lastRunDesc}(기대주기 ${Math.round(s.expectedIntervalMs / 60000)}분의 2배 초과)`;
  const remediation = JOB_REMEDIATION[s.job];
  if (remediation) line += `\n  → 확인: ${remediation}`;
  return line;
}

async function main() {
  const issues = findStaleJobs(VAULT_PATHS.state.jobHealth).map(formatStaleJobIssue);

  if (WATCH_TELEGRAM_SESSION) {
    if (!isProcessAlive(TELEGRAM_SESSION_PROCESS_PATTERN)) {
      issues.push('텔레그램 상시 세션이 응답하지 않습니다(프로세스 없음).');
    } else {
      // 프로세스는 살아있어도 폴링이 멈췄을 수 있다(좀비 상태, 위 isPollingStuck 주석
      // 참고) — 이 체크는 실패해도(네트워크 오류 등) 다른 잡의 stale 판정을 막지 않게
      // 별도로 감싼다.
      try {
        const info = await getTelegramWebhookInfo();
        if (isPollingStuck({ pendingUpdateCount: info.pending_update_count })) {
          issues.push(
            `텔레그램 상시 세션이 좀비 상태로 보입니다 — 프로세스는 살아있지만\n` +
            `미수신 메시지 ${info.pending_update_count}건이 큐에 쌓여있습니다(폴링 중단 의심).\n세션 재시작 필요.`,
          );
        }
      } catch (e) {
        issues.push(`텔레그램 폴링 상태 확인 실패(getWebhookInfo): ${e.message}`);
      }
    }
  }

  if (!issues.length) {
    console.log('✅ health-watcher: 이상 없음');
    return;
  }

  console.log(`🚨 health-watcher: 이상 ${issues.length}건 감지`);
  issues.forEach((i) => console.log(`  ${i}`));
  if (!DRY_RUN) {
    try {
      // 이 잡은 LLM을 아예 안 부르는 순수 운영 감시라 해석 문단 없이 사실(불릿)만
      // 나간다 — 오너 확정 표준 구조의 "변형" 허용 범위(2026-08-17).
      await sendTelegram(formatFactsMessage({
        departmentLabel: DEPARTMENT_LABEL,
        tag: '경고',
        facts: [`<b>장애감지 ${issues.length}건</b>`, ...issues],
      }));
    } catch (e) {
      console.error('텔레그램 알림 실패:', e.message);
    }
  }
}

// 직접 실행될 때만 main()을 돈다 — findStaleJobs를 테스트에서 import할 때 전체 잡이
// 실행되고 텔레그램까지 시도되는 사고를 막는다(drain-eval-queue.mjs와 동일 관례).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ health-watcher 오류:', e.message); process.exit(1); });
}
