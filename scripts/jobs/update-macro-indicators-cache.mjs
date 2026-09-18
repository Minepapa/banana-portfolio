#!/usr/bin/env node
// update-macro-indicators-cache.mjs — 거시지표 캐시(State/MacroIndicators, USD/KRW
// 환율 포함)를 매 평일 아침 갱신한다(2026-09-18 신설).
//
// ⚠️ 왜 필요한가 — 실사고(Log/DevRequests/2026-09-18-macro-cache-데이터신선도-
// 알람공백.md, 오너 신고): 오너가 텔레그램에서 "오늘 환율 얼마야"라고 물었는데
// 캐시값(1341.05원, asof 2026-09-13)을 그대로 답한 게 실제 그날(2026-09-18) 환율
// (1383.40원)과 5일·3%+ 괴리된 상태였다. `macro-cache.mjs`(`getCachedMacroIndicators`)
// 는 "그 값을 쓰는 잡이 실행될 때만" 계산하는 지연(lazy) 캐시인데, 실제 소비처가
// themis-risk-review.mjs(일요일)·weekly-report.mjs(일요일)·quarterly-allocation-
// review.mjs(분기)·risk-facts.mjs(오너 수동)뿐이라 평일 자동 갱신 자체가 없었다.
//
// ⚠️ python3 PATH 버그가 근본원인 중 하나였다는 점도 확인됨(같은 날 다른 사고
// 조사로 이미 수정됨, run.sh 참고) — 다만 **그 버그가 없었더라도 이 설계 자체가
// 주 1회(일요일)만 갱신되는 구조**라, 평일 중간에 물으면 최대 6일 묵은 값이
// 나올 수 있는 문제는 그대로 남는다. 이 잡은 그 간격을 매일로 좁힌다(설계상의
// 근본 보강 — python3 버그 수정과는 별개로 필요).
//
// 이 잡 자체는 캐시를 쓰지 않는다(반환값을 아무 데도 안 씀) — 부수효과(오늘자
// 캐시를 미리 계산해 State에 저장)가 유일한 목적이다. getCachedMacroIndicators가
// 이미 "오늘(KST) 캐시가 있으면 재사용"이라 이 잡이 실패해도(예: yfinance 일시
// 장애) 기존 값이 그대로 유지될 뿐 데이터가 사라지지 않는다.
//
// ⚠️ 잔여 신선도 한계(코드리뷰 지적, 2026-09-18) — 이 잡은 07:05에 딱 한 번
// 계산해 KST 달력일 경계까지 그 값을 고정한다(macro-cache.mjs 설계). USD/KRW는
// yfinance 소스 자체가 ~10시간 지연이라(fundamentals.mjs의 'yfinance(FX,~10h지연)'
// 표기 참고), 오너가 오후 늦게 물으면 계산시점+지연을 합쳐 최대 ~22시간 묵은
// 값을 받을 수 있다 — 이번 사고(5일·3%+ 괴리)보다는 훨씬 낫지만 "실시간"은
// 아니다. 장중 실시간 환율이 필요하면 별도 라이브 조회 경로가 필요(이 잡의
// 범위 밖).
//
// 사용법: node scripts/jobs/update-macro-indicators-cache.mjs
import { getCachedMacroIndicators } from '../lib/macro-cache.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

const JOB_NAME = 'update-macro-indicators-cache';

async function main() {
  console.error('[1/1] 거시지표 캐시 갱신 중(오늘자로 이미 계산돼 있으면 재사용, 없으면 새로 계산)...');
  const macro = await getCachedMacroIndicators();
  const keys = Object.keys(macro || {});
  // 코드리뷰 HIGH 지적(2026-09-18) — yf-macro.py는 티커별로 예외를 삼키고 빈 값을
  // 채운 뒤 exit 0으로 끝난다(fundamentals.mjs가 그 결과를 { value: null }로 그대로
  // 통과시킴, throw 없음). 즉 지표 하나가 일시적으로 실패해도 이 잡·getCachedMacro
  // Indicators 양쪽 다 "성공"으로 보고 오늘자 캐시에 null을 그대로 박제한다 —
  // macro-cache.mjs의 "오늘 캐시 있으면 그대로 재사용" 설계상 그날 나머지 시간
  // 동안 아무도 재계산하지 않는다(이 잡이 매일 도는 것 자체가 그 결측을 "오늘의
  // 정답"으로 확정시켜버리는 셈 — 이번 잡 신설이 만든 새로운 노출 경로). 값이
  // 없는 지표는 결측으로 명시 경고해 최소한 오너가 눈치챌 수 있게 한다(근본 수정
  // 은 macro-cache.mjs 자체를 손봐야 하지만 공유 모듈이라 범위 밖으로 남김).
  const missing = Object.entries(macro || {})
    .filter(([, v]) => v?.value == null)
    .map(([k]) => k);
  if (missing.length) {
    collectWarning(`거시지표 결측 — 값 없이 오늘자 캐시에 기록됨(오늘 하루 재계산 안 됨, yfinance 일시 장애 등 의심): ${missing.join(', ')}`);
  }
  console.log(`✅ 거시지표 캐시 갱신 완료 — ${keys.length}개 지표(${keys.join(', ')})${missing.length ? ` — 결측 ${missing.length}건` : ''}`);
  await flushWarnings(JOB_NAME);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ update-macro-indicators-cache 오류:', e.message);
    collectWarning(`잡 실행 중단: ${e.message}`);
    await flushWarnings(JOB_NAME).catch(() => {});
    process.exit(1);
  });
}
