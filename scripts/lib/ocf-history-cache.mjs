// 역사적 OCF(영업활동현금흐름) 대량 수집 + 로컬 캐시 — 구현계획서 Phase 10, 백테스트
// 전용. fetchOcfPointInTime(Phase 9, fundamentals.mjs)은 "한 시점"만 보는 라이브 월간
// 리컨스티튜션용이라 워크포워드 백테스트(수십~백여 개 재계산 시점)에 그대로 반복 호출하면
// 종목당 시점 수만큼 OpenDart를 다시 부른다 — historical-universe.mjs의 시세 캐싱과
// 같은 이유로, 종목당 전체 분기 보고서 이력을 **한 번만** 수집해 로컬에 캐싱하고
// 여러 재계산 시점에서 재사용한다(회사당 최대 48회 호출/12년, 시점 수와 무관).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCfList, extractOcf, disclosureDateFromRceptNo } from './fundamentals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache', 'ocf-history');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 회계연도 내 4개 보고서 종류를 공시 순서대로(1분기→반기→3분기→사업보고서, 구현계획서
// Phase 9 reprtCodeForDate 컨벤션과 동일 코드값).
const QUARTERLY_ORDER = ['11013', '11012', '11014', '11011'];

// 배치 전체(여러 회사) 중 "유효 이력 0건"인 회사 비율 상한 — 개별 회사가 신규상장·
// 조기상장폐지로 이력이 짧은 건 정상이지만, 이 비율 자체가 비정상적으로 높으면
// DART_API_KEY 만료·전역 레이트리밋 같은 시스템 장애로 의심한다(quant-ranking.mjs
// MAX_OCF_FAIL_RATIO와 같은 관례). MIN_BATCH_FOR_RATIO_GUARD: 이 값 미만이면 비율
// 자체를 안 본다 — 재개 실행이 "1곳 남았는데 그 1곳이 마침 신규상장이라 이력 0건"
// 같은 정상 케이스에서 분모가 작아 100% 비율로 오탐하는 걸 막는다(코드리뷰 지적,
// 2026-08-08).
export const MAX_ZERO_HISTORY_RATIO = 0.5;
export const MIN_BATCH_FOR_RATIO_GUARD = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePath(corpCode) {
  return join(CACHE_DIR, `${corpCode}.json`);
}

// 임시파일에 먼저 쓰고 rename — 같은 파일시스템 내 rename은 원자적이라 쓰는 도중
// 프로세스가 죽어도 절반만 쓰인 JSON이 "캐시됨"으로 영구 오염되지 않는다
// (state-writer.mjs writeAtomic과 동일 관례 — 이 캐시는 동시쓰기 경합이 없어 락까지는
// 필요 없지만 크래시 안전성은 Vault 파일과 똑같이 중요하다, 코드리뷰 지적 2026-08-08).
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// corpCode 하나의 [fromYear, toYear] 전체 분기 이력을 수집(디스크 I/O 없음, 순수 네트워크
// 조회) — 배열([{bsnsYear, reprtCode, disclosureDate, operCf}, ...], 공시일 오름차순).
// 데이터 없는 분기는 조용히 스킵(fetchCfList가 이미 "실제로 OCF를 뽑아낼 수 있는" 응답만
// 반환 — extractOcf가 null이면 애초에 이 항목이 안 생김, fetchOcfPointInTime과 동일 보장).
export async function fetchOcfHistory(corpCode, { fromYear, toYear }, apiKey, { onProgress } = {}) {
  const out = [];
  let attempted = 0;
  const total = (toYear - fromYear + 1) * QUARTERLY_ORDER.length;
  for (let year = fromYear; year <= toYear; year++) {
    for (const reprtCode of QUARTERLY_ORDER) {
      attempted++;
      const period = { bsnsYear: String(year), reprtCode };
      const list = await fetchCfList(corpCode, period, apiKey).catch(() => null);
      if (list) {
        const disclosureDate = disclosureDateFromRceptNo(list[0].rcept_no);
        const operCf = extractOcf(list);
        if (disclosureDate && operCf != null) out.push({ bsnsYear: period.bsnsYear, reprtCode, disclosureDate, operCf });
      }
      onProgress?.(attempted, total);
      await sleep(50); // OpenDart 배려(quant-ranking.mjs와 동일 관례)
    }
  }
  out.sort((a, b) => a.disclosureDate.localeCompare(b.disclosureDate));
  return out;
}

// 캐시 파일에 실제 이력 배열뿐 아니라 "어느 [fromYear,toYear] 범위로 조회해서 만들어진
// 캐시인지"도 같이 저장한다 — 그냥 배열만 저장하면, 좁은 범위(예: 파일럿 검증용
// 2023~2025)로 먼저 캐싱된 회사가 나중에 더 넓은 범위(예: 전체 백테스트 구간
// 2014~2026)로 다시 요청될 때 "파일이 이미 있으니 스킵"으로 오판해 **좁은 범위의
// 캐시가 넓은 범위 요청을 영구히 가로막는** 사고가 난다(2026-08-08 직접 겪음 —
// 삼성전자를 파일럿에서 2023~2025로 먼저 캐싱해뒀더니, 전체 구간 수집이 "이미
// 캐시됨"으로 보고 2014~2022 데이터를 영영 못 채움 — 2014~2022 재계산 시점에서
// 삼성전자가 통째로 랭킹에서 빠지는 결과로 이어짐). 이제 캐시가 실제로 요청 범위를
// 덮는지 검사하고, 못 덮으면(좁은 캐시든 아예 없든) 그 회사를 다시 수집 대상에 넣는다.
function readCacheFile(corpCode) {
  const path = cachePath(corpCode);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // 구버전 캐시(배열만 저장) 호환 — range 정보가 없으면 "범위를 모른다"로 취급해
    // 항상 재수집 대상이 되게 한다(추정하지 않음).
    if (Array.isArray(parsed)) return { fromYear: null, toYear: null, history: parsed };
    return parsed;
  } catch { return null; }
}

function coversRange(cached, fromYear, toYear) {
  if (!cached || cached.fromYear == null || cached.toYear == null) return false;
  return cached.fromYear <= fromYear && cached.toYear >= toYear;
}

// entries: [{ stockCode, corpCode, fromYear?, toYear? }, ...] — 캐시가 없거나 요청
// 범위를 덮지 못하는 corpCode만 (재)수집 대상(재실행 안전, 중단 후 재개 가능 — 단
// "범위가 넓어짐"도 재수집 트리거가 됨, 위 주석 참고). 항목별 fromYear/toYear가 있으면
// 그걸 쓰고, 없으면 옵션의 전역 fromYear/toYear를 쓴다(회사마다 실제 유니버스 편입
// 구간이 달라 전체기간을 일괄 조회하면 낭비가 크다). 기존 캐시 범위가 새 요청 범위와
// 겹치되 완전히 못 덮으면(예: 기존 2023~2025, 요청 2014~2026) 두 범위의 합집합을
// 다시 처음부터 전부 수집한다(부분 병합은 안 함 — 단순하고 안전한 쪽 선택, 약간의
// 중복 조회는 감수).
// fetchOne 주입 가능(기본 fetchOcfHistory) — 테스트에서 네트워크 없이 가짜 결과를
// 넣어 가드 로직만 검증할 수 있게(코드리뷰 지적, 2026-08-08).
//
// ⚠️ batchSize 단위로 모아 그 배치의 실패율을 판정하고, 통과한 배치만 디스크에 쓴다
// (기본 무한대=한 배치 — 소규모 호출에서는 이전과 동일 동작). 원래는 회사마다 즉시
// 파일을 썼는데, 그러면 DART_API_KEY가 도중에 만료돼 절반이 빈 이력([])으로 끝나도
// 그 빈 파일들이 이미 디스크에 남아있어서 (1) 이번 실행은 실패율 가드로 예외를 던지지만
// (2) **다음 재개 실행은 그 회사들이 "이미 캐시됨"으로 보여 재시도조차 안 하고 영구히
// 빈 이력으로 고정**되는 심각한 버그가 있었다(코드리뷰 CRITICAL급 지적, 2026-08-08 —
// 가드가 정확히 막으려던 실패 모드를 재개 시점에 그대로 통과시켜버림). 배치 단위로
// 나눈 이유: 수백~수천 개짜리 장시간 실행에서 "끝까지 다 모았다가 한 번에 검증"이면
// 중간에 크래시할 때 이미 성공한 수백 건까지 통째로 날아간다 — 배치별로 검증·기록해
// 장시간 작업에서도 진행 상황이 안전하게 누적되게 한다(오너 승인, 2026-08-08).
export async function cacheOcfHistory(entries, { fromYear, toYear, apiKey, maxZeroHistoryRatio = MAX_ZERO_HISTORY_RATIO, minBatchForRatioGuard = MIN_BATCH_FOR_RATIO_GUARD, batchSize = Infinity, fetchOne = fetchOcfHistory, onProgress } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const withRange = entries.map((e) => ({ ...e, fromYear: e.fromYear ?? fromYear, toYear: e.toYear ?? toYear }));
  const toFetch = withRange.filter((e) => !coversRange(readCacheFile(e.corpCode), e.fromYear, e.toYear));
  let fetched = 0, zeroHistory = 0, done = 0;

  for (let start = 0; start < toFetch.length; start += batchSize) {
    const chunk = toFetch.slice(start, start + batchSize);
    const results = [];
    let chunkZero = 0;
    for (const entry of chunk) {
      // 기존 캐시가 있지만 범위를 못 덮으면 합집합 범위로 다시 전부 수집(부분 병합 안 함).
      const existing = readCacheFile(entry.corpCode);
      const effFromYear = existing?.fromYear != null ? Math.min(existing.fromYear, entry.fromYear) : entry.fromYear;
      const effToYear = existing?.toYear != null ? Math.max(existing.toYear, entry.toYear) : entry.toYear;
      const history = await fetchOne(entry.corpCode, { fromYear: effFromYear, toYear: effToYear }, apiKey);
      results.push({ corpCode: entry.corpCode, fromYear: effFromYear, toYear: effToYear, history });
      if (history.length === 0) chunkZero++;
      done++;
      onProgress?.(done, toFetch.length);
    }

    if (chunk.length >= minBatchForRatioGuard) {
      const zeroRatio = chunkZero / chunk.length;
      if (zeroRatio > maxZeroHistoryRatio) {
        throw new Error(
          `OCF 이력 수집 결과 유효이력 0건 비율 과다(배치 ${start}~${start + chunk.length - 1}): `
          + `${chunkZero}/${chunk.length}건(${(zeroRatio * 100).toFixed(0)}%) — `
          + `DART_API_KEY 만료·전역 레이트리밋 의심(개별 회사의 짧은 상장이력만으론 이 정도 비율이 안 나옴). `
          + `이 배치는 디스크에 안 썼으니(이전 배치들은 이미 안전하게 기록됨) 다음 실행이 이 지점부터 재시도한다.`,
        );
      }
    }

    for (const { corpCode, fromYear: f, toYear: t, history } of results) {
      writeAtomic(cachePath(corpCode), JSON.stringify({ fromYear: f, toYear: t, history }));
    }
    fetched += results.length;
    zeroHistory += chunkZero;
  }

  return { fetched, cached: entries.length - toFetch.length, zeroHistory, total: entries.length };
}

function loadHistory(corpCode) {
  return readCacheFile(corpCode)?.history ?? null;
}

function assertDateString(d) {
  if (typeof d !== 'string' || !DATE_RE.test(d)) {
    throw new Error(`날짜는 "YYYY-MM-DD" 문자열이어야 함(historical-universe.mjs와 동일 계약 — Date 객체를 넘기면 문자열 비교가 조용히 틀어짐): ${JSON.stringify(d)}`);
  }
}

// history: [{bsnsYear, reprtCode, disclosureDate, operCf}, ...](정렬 여부 무관 — 여기서
// 직접 비교). targetDate 이하 공시일 중 가장 최근 것 — 없으면 null(추정 안 함, 룩어헤드
// 방지: 공시일 기준으로만 "그 시점에 이미 알려져 있던" 값만 고른다). 순수함수 — 테스트
// 가능(파일 I/O와 분리, price_at_or_before/computePointInTimeUniverse와 동일 설계 원칙).
export function findOcfAtOrBefore(history, targetDate) {
  let best = null;
  for (const h of history ?? []) {
    if (h.disclosureDate <= targetDate && (!best || h.disclosureDate > best.disclosureDate)) best = h;
  }
  return best;
}

// targetDate 이하 가장 최근 공시분 OCF — 캐시가 없으면 null(추정 안 함).
export function ocfAtOrBefore(corpCode, targetDate) {
  assertDateString(targetDate);
  const history = loadHistory(corpCode);
  if (!history || !history.length) return null;
  return findOcfAtOrBefore(history, targetDate);
}

// corpCodes × targetDates 조합별 ocfAtOrBefore — 종목당 캐시를 한 번만 읽고 메모리에서
// 여러 날짜를 조회(historical-universe.py prices_at과 동일 로드-후-질의 패턴). 반환:
// { [corpCode]: { [date]: {bsnsYear, reprtCode, disclosureDate, operCf}|null } }.
export function ocfAt(corpCodes, targetDates) {
  targetDates.forEach(assertDateString);
  const out = {};
  for (const corpCode of corpCodes) {
    const history = loadHistory(corpCode);
    if (!history || !history.length) {
      out[corpCode] = Object.fromEntries(targetDates.map((d) => [d, null]));
      continue;
    }
    out[corpCode] = Object.fromEntries(targetDates.map((d) => [d, findOcfAtOrBefore(history, d)]));
  }
  return out;
}
