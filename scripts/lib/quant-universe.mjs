// 퀀트 트랙 유니버스·유동성 필터 — 순수 함수(구현계획서 Phase 9).
// docs/ARCHITECTURE-V2.md "유니버스·유동성·종목수·포지션 사이징" 절 그대로.
//
// ⚠️ 공식 코스피200·코스닥150 지수 구성종목이 아니라 시가총액 상위 200(코스피)+150
// (코스닥) 종목으로 근사한다(오너 확정, 2026-08-07) — 공식 지수 API(pykrx
// get_index_portfolio_deposit_file)가 이 환경에서 KRX 정보데이터시스템 실계정
// 로그인을 요구하는 걸 직접 확인(일반 종목리스트·시세 조회는 로그인 없이 가능하지만
// 지수구성종목 리포트만 서버가 명시적으로 거부 — "LOGOUT"). 유동성이 강한 대형주
// 위주 지수라 시가총액 근사가 실질적으로 크게 다르지 않지만, 완전히 동일하지는
// 않다(업종배분 등 KRX의 추가 선정기준 제외) — 후보군 산출은 `scripts/lib/
// fdr-universe.py`(FinanceDataReader, 로그인 불필요) 담당.

import { spawnSync } from 'node:child_process';

export const LIQUIDITY_MIN_KRW = 3_000_000_000; // 일평균 거래대금 30억원(오너 확정)
export const UNIVERSE_N_KOSPI = 200;
export const UNIVERSE_N_KOSDAQ = 150;
export const LIQUIDITY_LOOKBACK_DAYS = 20;

// candidates: fdr-universe.py 출력 배열({ Code, Name, Marcap, avgTradingValue }).
// avgTradingValue가 null(데이터 부족·조회실패)이면 **추정하지 않고 제외**한다 — 유동성을
// 모르는 종목을 "통과"로 잘못 넘기는 것보다 "이번 달은 후보에서 빠짐"이 안전하다.
export function filterByLiquidity(candidates, minKrw = LIQUIDITY_MIN_KRW) {
  return candidates.filter((c) => c.avgTradingValue != null && c.avgTradingValue >= minKrw);
}

// fdr-universe.py 실행 — Python 표준 urllib의 SSL 인증서 검증이 이 환경에서 깨져있어
// (project-headless-automation 메모리 참고, yfinance는 requests+certifi라 문제없지만
// FinanceDataReader의 pd.read_csv 경로는 urllib을 타서 필요) SSL_CERT_FILE로 certifi
// 번들을 명시적으로 지정해야 한다 — 다른 파이썬 스크립트(yf-macro.py)는 이 주입이
// 필요 없어서 이 파일에서만 한다.
export function fetchQuantUniverse({ nKospi = UNIVERSE_N_KOSPI, nKosdaq = UNIVERSE_N_KOSDAQ, liquidityDays = LIQUIDITY_LOOKBACK_DAYS } = {}) {
  // certifi 경로 조회 자체가 실패하면(certifi 미설치·python3 없음 등) 빈 문자열이 그대로
  // SSL_CERT_FILE에 주입돼 모든 종목이 SSL 에러로 null이 되고, fdr-universe.py의 실패율
  // 가드가 그걸 "장애"로 잡긴 하지만 원인이 SSL 인증서 조회 실패라는 게 안 보인다
  // (코드리뷰 지적, 2026-08-05) — 여기서 먼저 명확한 원인으로 실패시킨다.
  const certResult = spawnSync('python3', ['-c', 'import certifi; print(certifi.where())'], { encoding: 'utf8' });
  const certPath = certResult.stdout?.trim();
  if (certResult.status !== 0 || !certPath) {
    throw new Error(`certifi 인증서 경로 조회 실패(python3/certifi 확인 필요): ${(certResult.stderr || '').slice(-200)}`);
  }

  const py = new URL('./fdr-universe.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, String(nKospi), String(nKosdaq), String(liquidityDays)], {
    encoding: 'utf8', timeout: 300_000, env: { ...process.env, SSL_CERT_FILE: certPath },
  });
  if (r.status !== 0) throw new Error(`퀀트 유니버스 조회 실패: ${(r.stderr || '').slice(-300)}`);
  // 스크립트의 유일한 stdout 출력은 마지막의 JSON 한 줄이지만, 의존 라이브러리가 언젠가
  // stderr가 아닌 stdout에 경고를 흘릴 가능성에 대비해(코드리뷰 지적) 마지막 비어있지
  // 않은 줄만 파싱한다 — 앞쪽에 낀 잡음이 있어도 안전.
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) throw new Error('퀀트 유니버스 조회 실패: 빈 출력');
  return JSON.parse(lastLine);
}
