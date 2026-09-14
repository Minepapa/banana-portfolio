#!/usr/bin/env node
// update-breakout-price-cache.mjs — 돌파매매 전략(퀀트 트랙)의 개별종목 시세 캐시
// (scripts/.cache/historical-prices/)를 매 거래일 증분 갱신한다(2026-09-14 신설).
//
// ⚠️ 왜 필요한가 — 2026-09-14 15:33 KST 첫 실전 체결 테스트에서
// `daily-breakout-signal-scan.mjs`가 통과 후보 0종목을 냈다. 원인 조사 결과 "오늘
// 돌파 신호가 없었다"가 아니라 **캐시 정합성 버그**였다: 개별종목 시세 캐시는
// 2026-09-11(금)에 멈춰있는데(마지막 수동 재수집이 백테스트 데이터 검증용
// historical-universe.py cache-prices였을 뿐, 일별 자동갱신 잡 자체가 없었음) 코스피
// 지수 캐시(cacheIndexPrices, index-price-cache.mjs)는 매 실행마다 라이브로 갱신돼
// 오늘까지 있었다 — computeDailyCandidates의 엄격 날짜비교(그 날 정확히 거래됐어야
// 함)로 전 종목이 예외 없이 탈락했다. 상세 경위는 Log/Implementation/
// 2026-09-13-돌파매매-백테스트엔진-구현.md "실전 첫 테스트 결과"·"캐시 정합성 버그
// 수정 완료" 절 참고.
//
// ⚠️ 타이밍 설계 — `daily-breakout-signal-scan.mjs`는 장마감 직후(15:32 KST 실행
// 가정)라 전체 후보풀(4천여 종목)을 그 좁은 창 안에서 증분갱신할 시간이 없다(종목당
// 실제 네트워크 호출 1회 + 예의상 지연이 FinanceDataReader 관례). 이 잡은 대신
// **장 시작 전 아침**에 돌아 전날 거래일까지의 캐시를 미리 최신으로 만들어둔다 —
// `daily-breakout-signal-scan.mjs`가 실행될 땐 이미 전날까지는 현재이므로, 그날
// 라이브 조회(getKrQuote)로 얻는 당일 근사종가만 얹으면 된다(원래 설계 의도 그대로).
// historical-universe.py의 update_prices()가 장중 수동 실행 시 오늘자(미완성 봉)를
// 자동으로 제외하는 방어도 갖고 있다.
//
// 상장폐지 종목은 캐시 갱신 대상에서 제외(영구히 새 데이터가 없어 매일 헛조회만
// 반복하게 됨 — cachePrices()가 최초 백필을 이미 담당했고, 그 이후로 다시 안
// 건드릴 이유가 없음).
//
// ⚠️ 액면분할/병합 감지 — historical-universe.py의 update_prices()가 겹침재조회로
// 감지해 그런 종목은 전체 재수집으로 자동 전환한다(2026-09-14 코드리뷰 HIGH 지적
// 반영, 상세는 그 함수 docstring 참고) — 이 파일은 그 결과 상태
// (corporate-action-refetched)를 집계만 한다.
//
// ⚠️ 신규상장(캐시 파일 자체가 없는 종목) 자동 백필 — update_prices()는 최초 백필을
// 안 하고 'no-cache-file'로만 보고한다(관심사 분리). 이 잡이 그 종목들만 골라
// cachePrices()로 후속 백필을 시도한다(2026-09-14 코드리뷰 MEDIUM 지적 — 이전엔
// 이 상태를 감지할 방법 자체가 없어 신규상장 종목이 영원히 후보풀에 못 들어와도
// 아무 신호가 없었다).
//
// ⚠️ 아직 launchd 미배선(의도적, 2026-09-14 오너 지시 — "검증 후 배선") — 이 잡은
// 코드로는 완결됐으나 실제 스케줄 등록(launchctl load)은 오너가 결과를 확인한
// 뒤의 별도 결정으로 남겨둔다. 지금은 수동 실행(`node scripts/jobs/
// update-breakout-price-cache.mjs`)으로만 돈다.
//
// 사용법: node scripts/jobs/update-breakout-price-cache.mjs
import { buildCandidatePool, updatePrices, cachePrices } from '../lib/historical-universe.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

const JOB_NAME = 'update-breakout-price-cache';
// 신규상장 종목 자동 백필 시작일 — 이 프로젝트의 백테스트 기본 시작일(run-breakout-
// backtest.mjs 기본값)과 동일하게 맞춤. cachePrices는 codes 전체에 시작일 하나만
// 받으므로(종목별 상장일이 제각각이라도), 넉넉히 과거로 잡아 FDR이 알아서 실제
// 상장일 이전은 빈 값으로 클립하게 둔다(추정 안 함 원칙 — 상장일을 직접 계산해
// 맞추는 대신 데이터소스가 자연히 걸러내게 함, historical-universe.py 상단 주석의
// "listingDate=None" 관례와 같은 방향).
const BACKFILL_START_DATE = '2014-01-01';

// 순수함수 — pool에서 "지금 갱신할 가치가 있는" 종목코드만 추림(상장폐지 제외).
// 테스트 가능하도록 main()에서 분리.
export function selectCodesToUpdate(pool) {
  return pool.filter((p) => !p.delistingDate).map((p) => p.code);
}

// 순수함수 — update_prices() 결과({code: 상태문자열})를 요약 집계 + 후속 백필이
// 필요한 종목코드 목록을 뽑아냄. 테스트 가능하도록 main()에서 분리.
//
// 가능한 상태값(historical-universe.py update_prices() 참고, 2026-09-14 코드리뷰
// 반영으로 확장): 'updated+N' · 'already-current' · 'no-new-rows' ·
// 'corporate-action-refetched+N'(액면분할/병합 감지 후 전체 재수집) ·
// 'no-cache-file'(최초 백필 자체가 안 됨 — 이 함수가 별도로 추려냄) ·
// 'empty-confirmed'(조회했지만 데이터 없음으로 이미 확정됨, 정상) · 'error:...'.
export function summarizeUpdateResult(result) {
  const summary = {
    updated: 0, 'already-current': 0, 'no-new-rows': 0,
    'corporate-action-refetched': 0, 'no-cache-file': 0, 'empty-confirmed': 0, error: 0,
  };
  const errors = [];
  const noCacheFileCodes = [];
  for (const [code, status] of Object.entries(result)) {
    if (status.startsWith('updated')) summary.updated += 1;
    else if (status === 'already-current') summary['already-current'] += 1;
    else if (status === 'no-new-rows') summary['no-new-rows'] += 1;
    else if (status.startsWith('corporate-action-refetched')) summary['corporate-action-refetched'] += 1;
    else if (status === 'no-cache-file') { summary['no-cache-file'] += 1; noCacheFileCodes.push(code); }
    else if (status === 'empty-confirmed') summary['empty-confirmed'] += 1;
    else if (status.startsWith('error')) { summary.error += 1; errors.push(`${code}: ${status}`); }
  }
  return { summary, errors, noCacheFileCodes, total: Object.keys(result).length };
}

async function main() {
  console.error('[1/3] 후보풀 조회 중...');
  const pool = buildCandidatePool();
  const codes = selectCodesToUpdate(pool);
  console.error(`  전체 ${pool.length}종목 중 상장폐지 제외 ${codes.length}종목 갱신 대상`);

  console.error('[2/3] 증분 시세 갱신 중(이미 최신인 종목은 네트워크 호출 없이 스킵)...');
  const result = updatePrices(codes);
  const { summary, errors, noCacheFileCodes, total } = summarizeUpdateResult(result);

  console.log(
    `✅ 시세 캐시 증분갱신 완료 — 대상 ${total}건: `
    + `갱신 ${summary.updated} · 이미최신 ${summary['already-current']} · `
    + `액면조정감지 ${summary['corporate-action-refetched']} · 신규변동없음 ${summary['no-new-rows']} · `
    + `빈결과확정 ${summary['empty-confirmed']} · 최초백필필요 ${summary['no-cache-file']} · 오류 ${summary.error}`,
  );
  for (const e of errors.slice(0, 20)) collectWarning(`시세 캐시 갱신 실패: ${e}`);
  if (errors.length > 20) collectWarning(`… 외 오류 ${errors.length - 20}건(로그 확인 필요)`);

  if (noCacheFileCodes.length) {
    console.error(`[3/3] 최초 백필이 안 된 종목 ${noCacheFileCodes.length}건 발견 — cachePrices()로 자동 백필 시도...`);
    try {
      const backfillResult = cachePrices(noCacheFileCodes, BACKFILL_START_DATE);
      console.log(`  백필 결과: ${JSON.stringify(backfillResult.summary ?? backfillResult)}`);
      if (backfillResult.summary?.error) {
        collectWarning(`시세 캐시 최초 백필 ${noCacheFileCodes.length}건 중 오류 ${backfillResult.summary.error}건 발생`);
      }
    } catch (e) {
      collectWarning(`시세 캐시 최초 백필 실패(${noCacheFileCodes.length}종목): ${e.message}`);
    }
  } else {
    console.error('[3/3] 최초 백필 필요 종목 없음 — 스킵');
  }

  await flushWarnings(JOB_NAME);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ update-breakout-price-cache 오류:', e.message);
    collectWarning(`잡 실행 중단: ${e.message}`);
    await flushWarnings(JOB_NAME).catch(() => {});
    process.exit(1);
  });
}
