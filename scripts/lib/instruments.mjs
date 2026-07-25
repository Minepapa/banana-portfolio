// 종목명(시트 한글명) → 시장 식별자. KR=corp_code(OpenDart corpCode.xml 캐시), US=고정 맵.
// 매핑 실패는 절대 추정하지 않고 null → 호출측이 '데이터 부족' 행으로 처리(환각 차단).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache');
const CACHE_FILE = join(CACHE_DIR, 'corpcodes.json');
const KIS_MST_CACHE_FILE = join(CACHE_DIR, 'kis-mst.json');

const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

// US 종목 한글명 → 티커. 신규 매수 또는 매수 전 평가의뢰 시 여기 한 줄 추가(누락 시 drain-eval-queue가
// 헤드리스 호출 없이 즉시 '오류'+등록 안내 메모로 표면화 — 2026-07 사고: 매핑 누락이 조용히 빈
// 판단보류 카드로 적재됐었음. 지금은 즉시 드러나므로, 새 관심종목 평가 의뢰 시 먼저 여기 등록할 것).
const US_MAP = {
  '애플': 'AAPL', '테슬라': 'TSLA', '엔비디아': 'NVDA',
  // 보유종목 시트엔 "알파벳 Class A"로 등록돼 있지만 평가의뢰 등에서 "알파벳"(단독)로도
  // 들어올 수 있어 둘 다 등록.
  '알파벳 class a': 'GOOGL', '알파벳': 'GOOGL',
  '마이크론': 'MU',  // 미보유 관심종목(매수 전 평가) — 반도체 사이클
  '마이크로소프트': 'MSFT', '아마존': 'AMZN',
};

// KR 단축명 → DART 공식 법인명 별칭. 보유종목 시트의 한글 단축명과 DART 등재명이 다른 경우.
const KR_ALIAS = {
  '현대차': '현대자동차',
};

export function usTicker(name) {
  return US_MAP[norm(name)] ?? null;
}

export function parseCorpCodeXml(xml) {
  const map = {};
  // 공백·개행에 관대한 선형 정규식을 원본(29MB)에 직접 적용. 전체 .replace()는
  // 매 매치마다 재실행되면 수십 분 걸리므로 절대 루프 안에서 쓰지 않는다.
  // corp_name과 stock_code 사이에 corp_eng_name이 끼므로 선택적으로 건너뜀.
  const re = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>([^<]+)<\/corp_name>(?:\s*<corp_eng_name>[^<]*<\/corp_eng_name>)?\s*<stock_code>([^<]*)<\/stock_code>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[3].trim()) continue;
    const nm = m[2].trim();
    const stock = m[3].trim();
    // 실데이터엔 동일 corp_name이 서로 다른 corp_code를 갖는 상장사가 34건 존재
    // (미래에셋증권·우리금융지주 등). 어느 쪽이 맞는지 추정 불가 → null로 모호 표시.
    // 한 번 null이면 끝까지 고착(리셋 금지 — 환각 차단).
    if (nm in map) {
      if (map[nm] === null || map[nm].corp !== m[1]) map[nm] = null;
    } else {
      map[nm] = { corp: m[1], stock };
    }
  }
  return map;
}

// 캐시에서 name과 정규화 일치하는 항목의 field(corp|stock)를 찾되, 절대 추정하지 않는다.
// - 항목이 null(파싱 단계 모호) → null
// - 항목이 객체가 아님(구형 문자열 캐시 등 잘못된 shape) → null (undefined 누출 차단)
// - 정규화 후 서로 다른 값으로 충돌 → null
// 일치 항목이 없으면 found(null) 그대로 반환.
export function lookupField(cache, name, field) {
  const target = norm(name);
  let found = null;
  for (const [corpName, entry] of Object.entries(cache)) {
    if (norm(corpName) !== target) continue;
    if (typeof entry !== 'object' || entry === null) return null; // 모호/구형/잘못된 shape
    const value = entry[field];
    if (typeof value !== 'string') return null;  // 필드 누락 등 → null
    if (found && found !== value) return null;    // 정규화 후 충돌 → 환각 차단
    found = value;
  }
  return found;
}

// corpCode.xml(zip) 다운로드 → 상장사만 {corp_name: corp_code} 캐시. 30일 지나면 갱신.
export function krCorpCode(name, apiKey = process.env.DART_API_KEY) {
  const dartName = KR_ALIAS[norm(name)] ?? name;
  let cache = null;
  if (existsSync(CACHE_FILE)) {
    try {  // 중단된 쓰기로 캐시가 깨졌으면 throw 대신 재다운로드로 폴백
      const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - c.fetchedAt < 30 * 86400e3) cache = c.map;
    } catch { cache = null; }
  }
  if (!cache) {
    if (!apiKey) return null;
    mkdirSync(CACHE_DIR, { recursive: true });
    const zip = join(CACHE_DIR, 'corpcode.zip');
    execSync(`curl -sf "https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}" -o "${zip}"`);
    const xml = execSync(`unzip -p "${zip}" CORPCODE.xml`, { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
    cache = parseCorpCodeXml(xml);
    writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), map: cache }));
  }
  return lookupField(cache, dartName, 'corp');
}

// ── KIS 종목마스터(KOSPI·KOSDAQ, ETF 포함) — DART 폴백용 ──────────────────────
// DART corpCode.xml은 "상장기업"만 등록돼 있어 ETF(TIGER·KODEX·PLUS 등)가 원천적으로
// 안 잡힌다(2026-07 실사고: 보유종목 18개 중 15개가 ETF라 krStockCode 전멸). 한국투자증권이
// 인증 없이 공개하는 종목마스터 파일(KOSPI/KOSDAQ 전종목, ETF 포함)을 DART 실패 시 폴백으로
// 쓴다. 출처: github.com/koreainvestment/open-trading-api stocks_info/kis_ko{spi,sdaq}_code_mst.py
//
// 공식 샘플은 "종목명 필드가 row 끝에서 정확히 228(KOSPI)·222(KOSDAQ)자 앞까지"라는 고정
// 오프셋을 가정하는데, 실측 결과 틀렸다 — 종목유형(주식/ETF/ETN 등)마다 뒤따르는 필드 개수가
// 달라 전체 행 길이가 271~290자 사이에서 들쭉날쭉하다(예: "TIGER 미국배당다우존스타겟데일리
// 커버드콜EF..."를 228 오프셋으로 자르면 이름이 통째로 날아감 — 2026-07 발견). 대신 "그룹코드
// (대문자 2자, ST/EF/EN 등) + 공백 0~3칸 + 숫자 9자리 이상"이라는 part2 시작부의 안정적
// 패턴을 앵커로 이름의 끝을 찾는다 — 그룹코드 전체 목록을 몰라도 동작하고, 실측 KOSPI
// 2567/2567·KOSDAQ 1822/1822 전건 성공(실패 0건) 확인됨.
const KIS_MST_URLS = [
  { url: 'https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip', file: 'kospi_code.mst' },
  { url: 'https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip', file: 'kosdaq_code.mst' },
];
const KIS_MST_NAME_END_RE = /[A-Z]{2}\s{0,3}\d{9,}/;

// name→code 한 건을 map에 병합 — 이미 다른 코드로 존재하면(모호) null로 고착.
// parseKisMasterText 내부(파일 내 중복)와 downloadKisMasterCodes(파일 간 중복, 예:
// KOSPI·KOSDAQ에 같은 짧은 이름이 동시 존재) 양쪽에서 공유 — 병합 순서와 무관하게 항상
// "다른 코드 두 번 = null"이 성립해야 한다(code-reviewer 지적: Object.assign으로 그냥
// 덮어쓰면 나중 소스가 조용히 이기는데, 그건 틀린 코드를 조용히 확정하는 것이라 DART
// parseCorpCodeXml의 "모호하면 추정 안 함" 원칙보다 더 나쁘다).
export function mergeMstEntry(map, name, code) {
  if (name in map) { if (map[name] !== null && map[name] !== code) map[name] = null; }
  else map[name] = code;
}

// 마스터 파일 원문(UTF-8 변환 후) → {한글명: 단축코드}. 순수함수 — 테스트 가능.
export function parseKisMasterText(text) {
  const map = {};
  for (const rawRow of String(text ?? '').split('\n')) {
    const row = rawRow.replace(/\r$/, '');
    if (row.length < 25) continue;   // 코드(9)+표준코드(12)+이름 최소 여유
    const code = row.slice(0, 9).trim();
    const nameSeg = row.slice(21);
    const m = nameSeg.match(KIS_MST_NAME_END_RE);
    if (!code || !m) continue;
    const name = nameSeg.slice(0, m.index).trimEnd();
    // 이름이 1자 이하면 앵커 정규식이 이름 자체를 먹어버린 오탐 가능성 — 신뢰 안 함.
    if (name.length < 2) continue;
    mergeMstEntry(map, name, code);
  }
  return map;
}

// KOSPI+KOSDAQ 마스터 다운로드·병합. curl/unzip/iconv 셸아웃 — 이 환경에서 Python urllib가
// SSL 문제로 깨지는 전례가 있어(project-headless-automation 메모리) curl로 통일.
// 파일 간 병합도 mergeMstEntry로 — 두 시장에 동일 이름이 다른 코드로 존재하면(드묾) null.
function downloadKisMasterCodes() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const map = {};
  for (const m of KIS_MST_URLS) {
    const zip = join(CACHE_DIR, `${m.file}.zip`);
    execSync(`curl -sfL "${m.url}" -o "${zip}"`);
    execSync(`unzip -o -q "${zip}" -d "${CACHE_DIR}"`);
    const mstPath = join(CACHE_DIR, m.file);
    const utf8 = execSync(`iconv -f cp949 -t utf-8//IGNORE "${mstPath}"`, { maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
    for (const [name, code] of Object.entries(parseKisMasterText(utf8))) mergeMstEntry(map, name, code);
  }
  return map;
}

// 캐시(30일) 보장 후 이름 조회. lookupField와 달리 값이 평문 문자열(코드)이라 field 없이 직접 대조.
function kisMasterStockCode(name) {
  let cache = null;
  if (existsSync(KIS_MST_CACHE_FILE)) {
    try {
      const c = JSON.parse(readFileSync(KIS_MST_CACHE_FILE, 'utf8'));
      if (Date.now() - c.fetchedAt < 30 * 86400e3) cache = c.map;
    } catch { cache = null; }
  }
  if (!cache) {
    try {
      const fresh = downloadKisMasterCodes();
      // 파싱 결과가 비면(레이아웃 변경 등) 30일간 재시도 없이 null 고착되는 걸 막기 위해
      // 캐시하지 않는다 — 다음 실행이 다시 다운로드를 시도하게 둔다.
      if (!Object.keys(fresh).length) return null;
      cache = fresh;
      writeFileSync(KIS_MST_CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), map: cache }));
    } catch { return null; }   // 다운로드 실패(네트워크 등) — 추정 없이 null
  }
  const target = norm(name);
  let found = null;
  for (const [mstName, code] of Object.entries(cache)) {
    if (norm(mstName) !== target) continue;
    if (code === null) return null;               // 원본에서 이미 모호 처리됨
    if (found && found !== code) return null;      // 정규화 후 충돌
    found = code;
  }
  return found;
}

// KR 6자리 종목코드 (yfinance .KS/.KQ 라우팅용). 미상장·모호·미발견 → null.
// DART 우선(기존 KR_ALIAS 튜닝 보존) → 실패 시 KIS 종목마스터 폴백(ETF 등 DART 미등재분 커버).
export function krStockCode(name, apiKey = process.env.DART_API_KEY) {
  const dartName = KR_ALIAS[norm(name)] ?? name;
  krCorpCode(name, apiKey); // 캐시 보장(부수효과)
  const cache = (() => {
    try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')).map; } catch { return null; }
  })();
  const dartResult = cache ? lookupField(cache, dartName, 'stock') : null;
  if (dartResult) return dartResult;
  return kisMasterStockCode(name);
}
