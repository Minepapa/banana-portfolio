#!/usr/bin/env node
/**
 * 주간 보고 스케쥴 — 매주 월요일 아침, 이번 주에 "이벤트와 무관하게 정해진 시각에
 * 자동으로 오는" 보고들이 언제·어느 부서에서 오는지 한 번에 알려준다(2026-08-23,
 * 오너 지시 — 무인 잡·부서 보고를 다 파악 못 하겠다는 지적에서 시작).
 *
 * ⚠️ 설계 판단 — 완전 정적 목록(하드코딩), Vault 조회·LLM 호출 없음. 이 잡의 역할은
 * "지금 시스템에 어떤 주기적 보고가 배선돼 있는지"를 알려주는 것뿐이라 매번 계산할
 * 게 없다 — launchd plist가 실제 스케줄의 정본이고, 이 목록은 그걸 사람이 읽기 좋게
 * 옮겨 적은 사본이다(므네모시네 Knowledge/Meta/부서별-텔레그램-보고.md의 "주기적" 표와
 * 동일 내용 — 그 문서와 이 배열 둘 다 갱신해야 함, 아래 SCHEDULE 주석 참고).
 *
 * ⚠️ 실사고(2026-08-29 오너 지적) — daily-execution-report(평일 16:15, 2026-08-24
 * 신설)가 딱 이 "이벤트 무관 매일 보고"에 해당하는데도 신설 당시 이 배열·아래 문서
 * 갱신을 빠뜨려 며칠간 이 요약에서 빠져있었다 — 위 세 곳 동시 갱신 규칙이 실제로
 * 어긴 사례, 추가함.
 *
 * ⚠️ 유지보수 — 새 주기적(이벤트 무관 스케줄) 보고가 추가되거나 시각이 바뀌면 반드시
 * ①아래 SCHEDULE 배열 ②Knowledge/Meta/부서별-텔레그램-보고.md의 "주기적" 표
 * ③해당 launchd plist 세 곳을 같이 갱신할 것 — 하나만 바꾸면 이 요약이 거짓말을 하게
 * 된다. 이벤트기반 보고(가격워치·신규현금배분·퀀트제안·잡경고 등)는 여기 안 넣는다
 * — "이벤트와 상관없이 주기적으로 일어나는 보고"만 다루기로 오너가 명시했다.
 *
 * 사용법: node scripts/jobs/weekly-schedule-summary.mjs [--dry-run]
 */
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '운영실 Hermes';

// 순수 데이터 — Knowledge/Meta/부서별-텔레그램-보고.md의 "주기적" 표와 반드시 일치시킬 것.
// script 필드(2026-08-29 추가)는 화면 표시엔 안 쓰이지만(buildWeeklyScheduleText 참고)
// vault-job-catalog-audit.test.js(코드 저장소)가 부서별-텔레그램-보고.md의 "**주기적**"
// 행과 이 배열을 스크립트 파일명 기준으로 자동 대조하는 데 쓴다 — daily-execution-report
// 누락 재발을 막는 구조적 가드.
// conditional 필드(2026-09-14 신설, 오너 지적 — "ISA 만기알람이 이번주 이벤트가
// 아닌데 몇 주째 스케줄에 뜬다") — 실제로 매번 발송되는 항목과 "조건 충족 시에만"
// 발송되는 항목이 이 배열 안에 구분 없이 섞여 있어, 매주 똑같은 조건부 항목이
// 마치 "이번 주 예정된 일"처럼 반복 노출되던 게 원인. 이 필드가 있으면 그 항목은
// buildWeeklyScheduleText에서 별도 [조건부] 그룹으로 묶이고, 값은 발송 조건을
// 짧게 설명하는 문구(사람이 읽는 텍스트에 그대로 붙음).
export const SCHEDULE = [
  { day: '평일', time: '08:00', dept: '운영실 Hermes', what: '아침 브리핑 — 자산현황+간밤 이벤트+거시 5신호', script: 'morning-briefing.mjs' },
  { day: '평일', time: '16:15', dept: '운영실 Hermes', what: '당일 체결 내역 보고', conditional: '체결 있을 때만', script: 'daily-execution-report.mjs' },
  { day: '평일', time: '16:30', dept: '투자전략실 Athena', what: '리밸런싱·거시 점검', conditional: '이상 있을 때만', script: 'daily-asset-allocation-check.mjs' },
  { day: '일요일', time: '07:00', dept: '리스크관리실 Themis', what: '주간 위험 재검토', script: 'themis-risk-review.mjs' },
  { day: '일요일', time: '07:30', dept: '비서실 Apollo', what: '므네모시네 주간 건강검진 — 구조·데이터 정합성·미완료 작업', conditional: '이상 있을 때만', script: 'weekly-vault-health-check.mjs' },
  { day: '일요일', time: '08:00', dept: '비서실 Apollo', what: '주간 리포트', script: 'weekly-report.mjs' },
  { day: '월요일', time: '07:10', dept: '투자전략실 Athena', what: 'ISA 3년 만기 감시', conditional: '만기 도달 임박 시에만', script: 'isa-maturity-check.mjs' },
];

// 순수함수 — SCHEDULE을 텔레그램 본문 텍스트로. 테스트 가능.
//
// [매주 고정]/[조건부] 두 그룹으로 나눠 표시(2026-09-14, 오너 지적 반영) — 조건부
// 항목(ISA 만기감시 등)이 나머지와 구분 없이 한 줄로 섞여 있으면 매주 똑같이
// 나열되는 것 자체가 "이번 주 예정된 일"처럼 잘못 읽힌다. 그룹 건수는 배열
// 길이에서 그대로 세므로(하드코딩 아님) 항목이 늘거나 줄어도 문구가 저절로 맞다
// — 예전엔 "아래 5건"이 고정 문자열이라 배열이 7건으로 늘어난 뒤에도 몇 주째
// "5건"으로 잘못 표시되고 있었다(같은 종류의 정체 버그).
export function buildWeeklyScheduleText(schedule = SCHEDULE) {
  const lineOf = (s) => `· ${s.day} ${s.time} [${s.dept}] ${s.what}${s.conditional ? `(${s.conditional})` : ''}`;
  const fixed = schedule.filter((s) => !s.conditional);
  const conditional = schedule.filter((s) => s.conditional);

  const lines = ['<b>주간 보고 스케쥴</b>', ''];
  if (fixed.length) {
    lines.push(`[매주 고정으로 옴 — ${fixed.length}건]`, ...fixed.map(lineOf), '');
  }
  if (conditional.length) {
    lines.push(`[조건부 — 웬만해선 조용함, ${conditional.length}건]`, ...conditional.map(lineOf), '');
  }
  lines.push(
    '이 외 나머지는 전부 이벤트 발생 시에만 오는 보고입니다(가격워치·신규현금배분·',
    '퀀트제안·잡경고 등) — 전체 목록은 Knowledge/Meta/부서별-텔레그램-보고.md 참고.',
  );
  return lines.join('\n');
}

async function main() {
  const body = buildWeeklyScheduleText();
  console.log(body);
  if (!DRY_RUN) {
    try {
      await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '안내', body }));
    } catch (e) { console.error('텔레그램 알림 실패:', e.message); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ weekly-schedule-summary 오류:', e.message); process.exit(1); });
}
