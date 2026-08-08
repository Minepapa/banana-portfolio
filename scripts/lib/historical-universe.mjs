// 과거 시점 유니버스 재구성 — historical-universe.py 래퍼 + 순위 판정 순수함수
// (구현계획서 Phase 10, 백테스트 생존편향 방지). fdr-universe.py/quant-universe.mjs와
// 동일한 역할분담: Python은 데이터 조회만(후보풀·시세 캐싱·조회), 순위·필터 판정은
// 여기 Node 순수함수(computePointInTimeUniverse)가 담당.
//
// ⚠️ 시가총액은 근사다 — 현재상장종목은 "지금" 발행주식수, 상장폐지종목은 상장 시점
// 발행주식수를 그대로 과거 전 기간에 적용한다(historical-universe.py 파일 상단 주석
// 참고, 받아들이는 트레이드오프).
import { spawnSync } from 'node:child_process';

const PY = new URL('./historical-universe.py', import.meta.url).pathname;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 날짜는 반드시 "YYYY-MM-DD" 문자열이어야 한다 — Date 객체를 넘기면 JSON.stringify와
// 문자열 보간(String(date))의 결과가 서로 달라(각각 ISO 타임스탬프 vs toString() 로케일
// 표현) Python이 돌려준 키와 조용히 안 맞아 모든 날짜가 빈 유니버스([])로 나올 수
// 있었다(코드리뷰 지적, 2026-08-08 — 오류 없이 조용히 실패하는 경로). 여기서 미리
// 걸러 잘못된 입력이 시끄럽게 실패하게 한다.
function assertDateStrings(dates) {
  for (const d of dates) {
    if (typeof d !== 'string' || !DATE_RE.test(d)) {
      throw new Error(`날짜는 "YYYY-MM-DD" 문자열이어야 함(Date 객체 금지 — 키 불일치로 조용히 실패하는 걸 막기 위함): ${JSON.stringify(d)}`);
    }
  }
}

function resolveCertPath() {
  const certResult = spawnSync('python3', ['-c', 'import certifi; print(certifi.where())'], { encoding: 'utf8' });
  const certPath = certResult.stdout?.trim();
  if (certResult.status !== 0 || !certPath) {
    throw new Error(`certifi 인증서 경로 조회 실패(python3/certifi 확인 필요): ${(certResult.stderr || '').slice(-200)}`);
  }
  return certPath;
}

function runPy(args, { timeout = 300_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const certPath = resolveCertPath();
  const r = spawnSync('python3', [PY, ...args], {
    encoding: 'utf8', timeout, maxBuffer, env: { ...process.env, SSL_CERT_FILE: certPath },
  });
  if (r.status !== 0) throw new Error(`historical-universe.py 실행 실패(${args[0]}): ${(r.stderr || '').slice(-500)}`);
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (!lastLine) throw new Error(`historical-universe.py 빈 출력(${args[0]})`);
  return JSON.parse(lastLine);
}

// 현재상장(코스피+코스닥) ∪ 상장폐지(KRX-DELISTING) 통합 후보풀 — 네트워크 호출 없이
// 이미 받아온 상장목록을 필터링만 하므로 빠르다(초 단위). 반환 항목: {code, name,
// market, sharesOutstanding, listingDate, delistingDate}(가격·시가총액 없음 — 그건
// fetchPricesAt+computePointInTimeUniverse가 시점별로 계산).
export function buildCandidatePool() {
  return runPy(['build-pool']);
}

// codes의 일별 종가를 로컬 캐시(scripts/.cache/historical-prices/)에 채운다 — 이미
// 캐시된 종목은 스킵(재실행 안전, 중단 후 재개 가능). 수천 종목이면 실제로 수십 분
// 걸릴 수 있어(종목당 실제 네트워크 호출 1회 + 예의상 지연) 기본 timeout을 30분으로
// 넉넉히 잡는다.
export function cachePrices(codes, startDate, { timeout = 30 * 60 * 1000 } = {}) {
  return runPy(['cache-prices', startDate, codes.join(',')], { timeout });
}

// codes × targetDates 조합의 "그 날짜 이하 가장 최근 거래일 종가"를 캐시에서 조회.
// 캐시가 없거나(cachePrices 선행 필요) 그 시점 거래 데이터가 없으면 해당 (code,date)는
// null. 반환: { [code]: { [date]: price|null } }.
export function fetchPricesAt(codes, targetDates, opts = {}) {
  assertDateStrings(targetDates);
  return runPy(['prices-at', JSON.stringify(targetDates), codes.join(',')], opts);
}

// pool: buildCandidatePool() 결과. pricesByCode: fetchPricesAt() 결과의 code 하나
// 엔트리 형태({ [date]: price|null })가 targetDate 키를 갖고 있다고 가정.
// 순수함수 — 테스트 가능. 상장일 이후·상장폐지일 이전이고 그 날짜에 가격이 있는
// 후보만 대상, 시가총액 내림차순 상위 nKospi+nKosdaq만 반환. 가격이 없으면(캐시
// 미조회·그 시점 거래 데이터 없음) 추정하지 않고 제외.
//
// 상장폐지일 경계(<=, 당일 제외) — DelistingDate는 "마지막 거래일의 다음날" 컨벤션임을
// 실측 확인(한진해운: 마지막 거래 2017-03-06 종가12원, DelistingDate=2017-03-07) — 그래서
// 상장폐지일 당일을 제외해도 실제 마지막 거래일은 유니버스에서 누락되지 않는다.
export function computePointInTimeUniverse(pool, pricesByCode, targetDate, { nKospi = 200, nKosdaq = 150 } = {}) {
  assertDateStrings([targetDate]);
  const td = new Date(targetDate);
  const candidates = [];
  for (const c of pool) {
    if (c.listingDate && new Date(c.listingDate) > td) continue;
    if (c.delistingDate && new Date(c.delistingDate) <= td) continue;
    const price = pricesByCode[c.code]?.[targetDate];
    if (price == null) continue;
    candidates.push({ ...c, price, marcap: price * c.sharesOutstanding });
  }
  const out = [];
  for (const [market, n] of [['KOSPI', nKospi], ['KOSDAQ', nKosdaq]]) {
    const ranked = candidates.filter((c) => c.market === market).sort((a, b) => b.marcap - a.marcap).slice(0, n);
    out.push(...ranked);
  }
  return out;
}

// 여러 targetDates를 한 번의 pool 조회 + 한 번의 가격조회 배치로 재구성 — 워크포워드
// 백테스트가 매달 재계산 시점마다 유니버스를 새로 뽑아야 하므로, pool·가격 조회를
// targetDates 개수만큼 반복하는 낭비를 막는다. 반환: { [date]: candidates[] }
// (computePointInTimeUniverse 결과와 동일 형태).
export function universeAtBatch(targetDates, { nKospi = 200, nKosdaq = 150, pool, pricesByCode } = {}) {
  const resolvedPool = pool ?? buildCandidatePool();
  const codes = resolvedPool.map((c) => c.code);
  const resolvedPrices = pricesByCode ?? fetchPricesAt(codes, targetDates);
  const out = {};
  for (const date of targetDates) {
    out[date] = computePointInTimeUniverse(resolvedPool, resolvedPrices, date, { nKospi, nKosdaq });
  }
  return out;
}
