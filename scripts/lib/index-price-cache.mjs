// 코스피·코스닥 지수 종가 캐싱 — 백테스트 벤치마크 비교용(구현계획서 Phase 10).
// historical-universe.py의 개별종목 시세 캐싱과 별도 파일인 이유: 대상이 지수 2개뿐이라
// 그 파일의 대량(4천여 종목) 후보풀·유동성 로직이 전혀 필요 없다 — 훨씬 작고 단순한
// 전용 캐시. FinanceDataReader의 지수 데이터(KS11·KQ11)는 개별종목과 달리
// 2014-05-19 바닥이 없음(실측 확인: 2014-01-02부터 정상 제공) — 그래도 백테스트
// 자체가 개별종목 시세의 2014-05-19 바닥에 묶여 있어 실질적 이득은 없지만, 벤치마크
// 쪽에서 추가 제약이 안 생긴다는 것만 확인해둔다.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'index-prices');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const INDEX_SYMBOLS = { KOSPI: 'KS11', KOSDAQ: 'KQ11' };

function cachePath(indexName) {
  return join(CACHE_DIR, `${indexName}.json`);
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function resolveCertPath() {
  const r = spawnSync('python3', ['-c', 'import certifi; print(certifi.where())'], { encoding: 'utf8' });
  const certPath = r.stdout?.trim();
  if (r.status !== 0 || !certPath) throw new Error(`certifi 인증서 경로 조회 실패: ${(r.stderr || '').slice(-200)}`);
  return certPath;
}

// ocf-history-cache.mjs와 동일한 이유로 캐시에 실제 조회 범위(startDate/endDate)도
// 같이 저장한다 — 파일 존재 여부만 보면 좁은 범위로 먼저 캐싱된 지수가 나중에 더
// 넓은 범위 요청을 영구히 가로막는다(코드리뷰 지적, 2026-08-08 — OCF 캐시에서 실제로
// 겪은 사고와 같은 버그 클래스, 여기서도 재발할 뻔했음을 확인).
function readCacheFile(indexName) {
  const path = cachePath(indexName);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function coversRange(cached, startDate, endDate) {
  if (!cached || !cached.startDate || !cached.endDate) return false;
  return cached.startDate <= startDate && cached.endDate >= endDate;
}

// indexName: 'KOSPI'|'KOSDAQ'. 캐시가 없거나 요청 범위를 못 덮으면 (재)조회 — 기존
// 범위와의 합집합으로 다시 전부 받는다(부분 병합 안 함, ocf-history-cache.mjs와 동일
// 단순화). 반환: 'cached'|'fetched'.
export function cacheIndexPrices(indexName, startDate, endDate) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const end = endDate || new Date().toISOString().slice(0, 10);
  const existing = readCacheFile(indexName);
  if (coversRange(existing, startDate, end)) return 'cached';

  const symbol = INDEX_SYMBOLS[indexName];
  if (!symbol) throw new Error(`알 수 없는 지수명: ${indexName}(허용: ${Object.keys(INDEX_SYMBOLS).join(', ')})`);
  const effStart = existing?.startDate ? (existing.startDate < startDate ? existing.startDate : startDate) : startDate;
  const effEnd = existing?.endDate ? (existing.endDate > end ? existing.endDate : end) : end;

  const certPath = resolveCertPath();
  // Python이 최종 경로에 바로 쓰지 않고 stdout으로 CSV를 돌려준다 — 여기(JS)에서
  // writeAtomic으로 임시파일→rename하기 위함(코드리뷰 지적, 2026-08-08: Python이
  // 직접 최종 경로에 df.to_csv()로 쓰면 타임아웃·중단 시 잘린 파일이 "캐시됨"으로
  // 영구 고정될 수 있었음 — historical-universe.py처럼 이미 있던 writeAtomic 헬퍼가
  // 정작 안 쓰이고 있었던 버그).
  const script = `
import sys, FinanceDataReader as fdr
df = fdr.DataReader(sys.argv[1], sys.argv[2], sys.argv[3])
if df is None or df.empty:
    print('', end='')
else:
    df[['Close']].to_csv(sys.stdout)
`;
  const r = spawnSync('python3', ['-c', script, symbol, effStart, effEnd], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, SSL_CERT_FILE: certPath },
  });
  if (r.status !== 0) throw new Error(`${indexName} 지수 조회 실패: ${(r.stderr || '').slice(-300)}`);
  if (!r.stdout.trim()) throw new Error(`${indexName} 지수 조회 결과가 비어있음(${effStart}~${effEnd}) — 데이터 소스 장애 의심`);

  const lines = r.stdout.trim().split('\n').slice(1); // 헤더(Date,Close) 제외
  const series = lines.map((l) => { const [date, close] = l.split(','); return { date, close: Number(close) }; })
    .filter((row) => DATE_RE.test(row.date) && Number.isFinite(row.close));
  if (!series.length) throw new Error(`${indexName} 지수 파싱 결과 0건(${effStart}~${effEnd}) — 응답 형식 확인 필요`);

  writeAtomic(cachePath(indexName), JSON.stringify({ startDate: effStart, endDate: effEnd, series }));
  return 'fetched';
}

function loadSeries(indexName) {
  return readCacheFile(indexName)?.series ?? null;
}

function assertDateString(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) {
    throw new Error(`날짜는 "YYYY-MM-DD" 문자열이어야 함(ocf-history-cache.mjs와 동일 계약): ${JSON.stringify(d)}`);
  }
}

// targetDate 이하 가장 최근 거래일 종가 — 캐시가 없거나 조건 만족 데이터가 없으면 null
// (추정 안 함, historical-universe.py price_at_or_before와 동일 원칙).
export function indexPriceAtOrBefore(indexName, targetDate) {
  assertDateString(targetDate);
  const series = loadSeries(indexName);
  if (!series || !series.length) return null;
  let best = null;
  for (const r of series) {
    if (r.date <= targetDate && (!best || r.date > best.date)) best = r;
  }
  return best ? best.close : null;
}

// indexName × targetDates 여러 개를 한 번에 조회(로드-후-질의 패턴).
export function indexPricesAt(indexName, targetDates) {
  targetDates.forEach(assertDateString);
  const series = loadSeries(indexName);
  const out = {};
  for (const d of targetDates) {
    if (!series || !series.length) { out[d] = null; continue; }
    let best = null;
    for (const r of series) {
      if (r.date <= d && (!best || r.date > best.date)) best = r;
    }
    out[d] = best ? best.close : null;
  }
  return out;
}
