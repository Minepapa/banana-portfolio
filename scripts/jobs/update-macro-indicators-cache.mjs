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
// 캐시 갱신의 반환값은 쓰지 않는다 — 부수효과(오늘자 캐시를 미리 계산해 State에
// 저장)가 목적이다. 환율 12개월 볼린저 돌파는 이 아래에서 별도로 판정·보고한다.
// getCachedMacroIndicators가
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
// 사용법: node scripts/jobs/update-macro-indicators-cache.mjs [--no-send|--dry-run]
// --no-send: 캐시는 갱신하되 볼린저 메시지는 미리보기만 하고 판정 상태는 저장하지 않는다.
// --dry-run: 캐시·볼린저 판정 상태를 저장하지 않고 메시지만 미리 본다.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCachedMacroIndicators } from '../lib/macro-cache.mjs';
import { fetchMacroIndicators } from '../lib/fundamentals.mjs';
import { computeSimpleBollingerSignal } from '../lib/macro-overlay.mjs';
import { fetchCloses } from '../tools/macro-overlay-facts.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { renderAgentMessage, sendAgentMessage } from '../lib/pantheon-send.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { sanitizeWarningDetail } from '../lib/warning-event-journal.mjs';

const JOB_NAME = 'update-macro-indicators-cache';
const USDKRW_TICKER = { USDKRW: 'KRW=X' };

function todayKST(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
}

export function readBollingerState(filepath) {
  try { return JSON.parse(readFileSync(filepath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    // 손상된 상태를 정상으로 간주하면 같은 돌파를 중복 발송한다.
    throw new Error(`볼린저 상태 파일 읽기 실패 (${filepath}): ${error.message}`, { cause: error });
  }
}

// yfinance의 기존 1년 일봉 경로는 종가 배열만 반환한다. 기준일은 원천 봉의 날짜가
// 아니라 이 잡이 판정한 KST 날짜로 명시한다(최근값의 시장 날짜를 추정하지 않음).
export async function checkUsdKrwBollinger({
  now = new Date(), dryRun = false, noSend = false,
  fetch = () => fetchCloses(USDKRW_TICKER),
  readState = readBollingerState, write = writeAtomic, ensureDir = mkdirSync,
  send = sendAgentMessage, warn = collectWarning, output = console,
  stateFile = VAULT_PATHS.state.usdkrwBollingerState,
} = {}) {
  let raw;
  try { raw = await fetch(); }
  catch (error) {
    warn(`USDKRW 12개월 볼린저 최근값 결측 — 조회 실패: ${error.message}`);
    return { status: 'missing' };
  }
  const closes = raw?.['KRW=X'] ?? raw?.USDKRW;
  const validCloses = Array.isArray(closes) ? closes.filter(Number.isFinite) : [];
  // computeBollingerBands 자체는 반년치에도 값을 내지만, 결정 7번의 12개월
  // 판정에는 최소 250개 유효 일봉이 필요하다. 부족하면 직전 상태를 보존한다.
  if (validCloses.length < 250) {
    warn(`USDKRW 12개월 볼린저 최근값 결측 — 유효 일봉 ${validCloses.length}/250개`);
    return { status: 'missing' };
  }
  const signal = computeSimpleBollingerSignal(validCloses);
  if (!signal?.bands) {
    warn('USDKRW 12개월 볼린저 판정 결측 — 밴드 계산 불가');
    return { status: 'missing' };
  }

  const direction = signal.breached ? (signal.bands.zscore > 0 ? 'upper' : 'lower') : null;
  const previous = readState(stateFile);
  const date = todayKST(now);
  const state = { breached: signal.breached, direction, date };
  const newlyBreached = signal.breached && (!previous?.breached || previous.direction !== direction);
  let message = null;
  if (newlyBreached) {
    const format = (value) => Number(value).toFixed(2);
    message = {
      agent: 'plutus', kind: '판단', topic: '환율 감시',
      conclusion: previous === null
        ? `원/달러 환율이 12개월 볼린저 ${direction === 'upper' ? '상단' : '하단'} 밖에 있습니다(감시 시작 시점 기준)`
        : direction === 'upper'
          ? '원/달러 환율이 12개월 볼린저 상단을 넘었습니다'
          : '원/달러 환율이 12개월 볼린저 하단 밑으로 내려갔습니다',
      facts: [
        `원/달러 최근값 ${format(signal.current)}원 · 이동평균 ${format(signal.bands.ma)}원`,
        `상단 ${format(signal.bands.upper)}원 · 하단 ${format(signal.bands.lower)}원 · z점수 ${format(signal.bands.zscore)}`,
        `기준일 ${date}(KST 판정일, 최근값의 시장 날짜는 제공되지 않음) · 유효 일봉 ${validCloses.length}개`,
      ],
      context: '결정 거시-위험-트리거 7번 감시, 보고 전용',
      decisions: ['분기 점검에서 환헤지 비중을 함께 보세요'],
    };
    if (dryRun || noSend) output.log(`[USDKRW 볼린저 메시지 미리보기]\n${renderAgentMessage(message)}`);
    else await send(message);
  }
  // 실제 발송 실패 시 상태를 기록하지 않아 다음 실행이 돌파를 다시 보고할 수 있다.
  // --no-send와 --dry-run은 미리보기만 하며 판정 상태를 기록하지 않는다.
  if (!dryRun && !noSend) {
    ensureDir(dirname(stateFile), { recursive: true });
    write(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
  return { status: 'checked', signal, state, message };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const noSend = process.argv.includes('--no-send');
  console.error(dryRun
    ? '[1/1] 거시지표 조회·환율 볼린저 판정 중(dry-run, 캐시·상태 저장 없음)...'
    : '[1/1] 거시지표 캐시 갱신 중(오늘자로 이미 계산돼 있으면 재사용, 없으면 새로 계산)...');
  const macro = dryRun ? await fetchMacroIndicators() : await getCachedMacroIndicators();
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
    collectWarning(dryRun
      ? `거시지표 결측 — dry-run 조회에서 값 없음(캐시 저장 안 함): ${missing.join(', ')}`
      : `거시지표 결측 — 값 없이 오늘자 캐시에 기록됨(오늘 하루 재계산 안 됨, yfinance 일시 장애 등 의심): ${missing.join(', ')}`);
  }
  console.log(`✅ 거시지표 ${dryRun ? '조회' : '캐시 갱신'} 완료 — ${keys.length}개 지표(${keys.join(', ')})${missing.length ? ` — 결측 ${missing.length}건` : ''}`);
  await checkUsdKrwBollinger({ dryRun, noSend });
  await flushWarnings(JOB_NAME, { dryRun: dryRun || noSend });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ update-macro-indicators-cache 오류:', e.message);
    const reason = sanitizeWarningDetail(e.message);
    collectWarning(`잡 실행 중단: ${reason}`);
    // 정상 경로와 동일하게 미발송 플래그를 적용한다. 조회·판정 중 예외가 나도
    // --dry-run/--no-send가 경고 배치 경로에서 텔레그램을 열면 안 된다.
    await flushWarnings(JOB_NAME, {
      dryRun: process.argv.includes('--dry-run') || process.argv.includes('--no-send'),
    }).catch(() => {});
    process.exit(1);
  });
}
