// 종목명(시트 한글명) → 시장 식별자. KR=corp_code(OpenDart corpCode.xml 캐시), US=고정 맵.
// 매핑 실패는 절대 추정하지 않고 null → 호출측이 '데이터 부족' 행으로 처리(환각 차단).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, '..', '.cache');
const CACHE_FILE = join(CACHE_DIR, 'corpcodes.json');

const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

// US 보유종목 한글명 → 티커. 신규 매수 시 여기 한 줄 추가(누락 시 잡이 '데이터 부족'으로 알려줌).
const US_MAP = {
  '애플': 'AAPL', '테슬라': 'TSLA', '엔비디아': 'NVDA',
  '알파벳 class a': 'GOOGL', '마이크로소프트': 'MSFT',
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

// corpCode.xml(zip) 다운로드 → 상장사만 {corp_name: corp_code} 캐시. 30일 지나면 갱신.
export function krCorpCode(name, apiKey = process.env.DART_API_KEY) {
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
  const target = norm(name);
  let found = null;
  for (const [corpName, entry] of Object.entries(cache)) {
    if (norm(corpName) !== target) continue;
    if (entry === null) return null;             // 파싱 단계에서 모호로 판정된 동명사
    if (found && found !== entry.corp) return null; // 정규화 후 충돌(다른 코드) → 환각 차단
    found = entry.corp;
  }
  return found;
}

// KR 6자리 종목코드 (yfinance .KS/.KQ 라우팅용). 미상장·모호·미발견 → null.
export function krStockCode(name, apiKey = process.env.DART_API_KEY) {
  krCorpCode(name, apiKey); // 캐시 보장(부수효과)
  const cache = (() => {
    try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')).map; } catch { return null; }
  })();
  if (!cache) return null;
  const target = norm(name);
  let found = null;
  for (const [corpName, entry] of Object.entries(cache)) {
    if (norm(corpName) !== target || !entry) continue;
    if (found && found !== entry.stock) return null;
    found = entry.stock;
  }
  return found;
}
