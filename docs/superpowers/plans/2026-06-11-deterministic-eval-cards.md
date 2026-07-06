# 평가 카드 결정론화 (drain-eval-queue --auto)

## Goal

`scripts/drain-eval-queue.mjs --auto`(launchd cron `drain`)가 LLM에게 Bash를 주고 PER·PBR·ROE·RSI·52주·FCF 같은 **raw 숫자를 직접 fetch하게** 시키던 구조를 끝낸다. risk-monitor(B/D)에서 이미 적용한 3계층 원칙을 그대로 이식한다:

1. **Node가 숫자를 결정론적으로 산출** — OpenDart(재무) + yfinance(시세·밸류에이션·모멘텀)를 Node가 호출, RSI·52주위치·FCF yield는 Node 순수함수로 계산.
2. **LLM은 Read 전용 판단만** — `runHeadlessClaude(prompt, MODEL, 'Read')`. Bash 제거 → 숫자를 못 만들고 못 지어낸다.
3. **Node 숫자를 axisItems에 그대로 적재** — 시트 종목투자노트 axisItems 칼럼에는 LLM 텍스트가 아니라 Node가 만든 검증된 값이 들어간다. LLM은 등급(🟢🟡🔴)과 근거/리스크/액션 산문만 생성.

**현재 문제(왜 이걸 하나):** mode D 환각(KOSPI 8,096 vs 실측 7,763)과 동일한 위험이 평가 큐에도 있다. `--auto`는 무인 cron이라 LLM이 SSL 깨진 python·잘못된 corp_code·환각 PER로 카드를 발행해도 아무도 못 잡는다. 사용자가 "그 동안 분석한 게 잘못되고 있었네"라고 한 바로 그 구멍.

**범위 밖(명시):** 반자동 경로(`--auto` 없이 사람이 Claude Pro에 붙여넣는 흐름)는 사람이 검증하므로 그대로 둔다. 프롬프트 본문(카드 양식·5축 설명)은 유지하고, 데이터 조달 책임만 LLM→Node로 옮긴다.

## Architecture

```
[Node] drain-eval-queue.mjs --auto
  └─ buildEvalFacts(entry, identifiers, fetchers)        ← 신규 (assembler)
        ├─ fetchKrFundamentals(corpCode)  [기존, OpenDart] → 수익성·안정성·현금흐름 일부
        │   or fetchUsFundamentals(ticker) [기존, yfinance]
        ├─ fetchMarketData(yahooTicker)    [신규, yfinance] → PER·PBR·52주·시총·FCF·closes
        │     └─ computeRsi14(closes)        [신규 순수]
        │     └─ compute52wPosition(...)     [신규 순수]
        │     └─ computeFcfYield(fcf, mktcap)[신규 순수]
        └─ → { facts(축별 검증값 배열), axisItems(시트 적재용) }
  └─ buildBuyPrompt/buildSellPrompt(entry, facts, ...)   ← 개조: facts 주입, "재조회 금지"
  └─ runHeadlessClaude(prompt, MODEL, 'Read')            ← 개조: Bash 제거
  └─ parseEvalJson → buildRow(obj, facts.axisItems)      ← 개조: Node axisItems 우선
```

식별자 매핑(`instruments.mjs`): KR은 `krCorpCode`(OpenDart 8자리, 재무용) + 신규 `krStockCode`(6자리, yfinance `.KS`/`.KQ`용). US는 `usTicker`. 매핑 실패 = null → 해당 축 "데이터 부족"으로 표기(추정 금지).

## Tech Stack

- Node 빌트인 테스트(`node:test` + `node:assert/strict`), ESM `.mjs`, 새 의존성 0.
- yfinance(python3 서브프로세스) — 시세·info. raw만 받고 계산은 Node.
- OpenDart REST(기존 `fetchKrFundamentals`).
- 주석은 한국어 WHY 주석(기존 `fundamentals.mjs` 스타일).

---

## Task 1 — 순수 계산 함수 (RSI·52주·FCF) + 테스트

`scripts/lib/fundamentals.mjs`에 순수 함수 3개 추가. 시세 raw(종가 배열·고저·시총)에서 결정론적으로 지표를 만든다. **숫자는 여기서만 만든다 — LLM 금지.**

### 1a. 실패하는 테스트 작성

`scripts/lib/fundamentals.test.js` 상단 import에 `computeRsi14, compute52wPosition, computeFcfYield` 추가하고 맨 끝에 추가:

```js
test('computeRsi14: Wilder 평활 RSI — 표준 14기간', () => {
  // 첫 상승만 있는 단조 증가 → RSI 100 수렴
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(computeRsi14(up), 100);
  // 단조 하락 → RSI 0 수렴
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(computeRsi14(down), 0);
  // 15개 미만(계산 불가) → null
  assert.equal(computeRsi14([1, 2, 3]), null);
  // Wilder 평활 RSI(14)를 최신 종가 기준으로 산출 — 이 20개 종가열의 마지막 시점 값 = 57.92
  const sample = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,
                  45.89,46.03,45.61,46.28,46.28,46.00,46.03,46.41,46.22,45.64];
  assert.equal(computeRsi14(sample), 57.92);
});

test('compute52wPosition: (현재-저)/(고-저)*100, 경계·결측 방어', () => {
  assert.equal(compute52wPosition(150, 200, 100), 50);   // 중앙
  assert.equal(compute52wPosition(200, 200, 100), 100);  // 고점
  assert.equal(compute52wPosition(100, 200, 100), 0);    // 저점
  assert.equal(compute52wPosition(150, 100, 100), null); // 고=저(0 분모)
  assert.equal(compute52wPosition(null, 200, 100), null);
});

test('computeFcfYield: FCF/시총*100, 결측·0분모 → null', () => {
  assert.equal(computeFcfYield(5e9, 1e11), 5);
  assert.equal(computeFcfYield(-1e9, 1e11), -1);
  assert.equal(computeFcfYield(5e9, 0), null);
  assert.equal(computeFcfYield(null, 1e11), null);
});
```

### 1b. 테스트 실행 → 실패 확인

```bash
node --test scripts/lib/fundamentals.test.js 2>&1 | grep -E "fail|pass|RSI|52주|FcfYield" | tail -15
```

(import 실패로 전체 fail이면 정상 — 함수 미존재.)

### 1c. 구현

`scripts/lib/fundamentals.mjs` 의 `computeMacroChange` 바로 위(거시 섹션 앞)에 추가:

```js
// ── 평가 카드용 순수 지표 (drain --auto) ────────────────────────────
// 시세 raw에서 결정론적으로 산출 — LLM이 RSI·52주·FCF를 지어내던 환각을 차단.

// RSI(14) — Wilder 평활. closes: 과거→현재 종가배열. 15개 미만이면 null.
export function computeRsi14(closes, period = 14) {
  const a = (closes || []).filter(x => Number.isFinite(x));
  if (a.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rsi = 100 - 100 / (1 + avgGain / avgLoss);
  return Math.round(rsi * 100) / 100;
}

// 52주 위치(%) = (현재-저)/(고-저)*100. 분모 0·결측 → null.
export function compute52wPosition(current, high, low) {
  if (![current, high, low].every(Number.isFinite)) return null;
  if (high === low) return null;
  return Math.round((current - low) / (high - low) * 1000) / 10;
}

// FCF yield(%) = 잉여현금흐름/시가총액*100. 결측·0분모 → null.
export function computeFcfYield(fcf, marketCap) {
  if (!Number.isFinite(fcf) || !Number.isFinite(marketCap) || marketCap === 0) return null;
  return Math.round(fcf / marketCap * 1000) / 10;
}
```

### 1d. 테스트 통과 확인

```bash
node --test scripts/lib/fundamentals.test.js 2>&1 | grep -E "tests|pass|fail" | tail -5
```

전부 pass여야 함. (RSI는 "최신 종가 기준" 모멘텀이므로 표본의 마지막 시점 값=57.92가 정답. 구현이 57.92를 내는지 Node로 먼저 확인 후 단언할 것.)

### 1e. 커밋

```bash
git add scripts/lib/fundamentals.mjs scripts/lib/fundamentals.test.js
git commit -m "평가 카드 순수 지표 함수 추가 (RSI14·52주위치·FCF yield)"
```

---

## Task 2 — KR 6자리 종목코드 매핑 (instruments.mjs)

yfinance `.KS`/`.KQ`로 KR 시세·밸류에이션·모멘텀을 받으려면 6자리 stock_code가 필요하다. `corpCode.xml`엔 이미 stock_code가 있지만 현재 `parseCorpCodeXml`은 버린다. 이를 보존해 `krStockCode(name)`을 추가한다.

### 2a. 기존 테스트 확인 + 수정 (계약 변경)

기존 `instruments.test.js`는 `parseCorpCodeXml`이 **문자열 corp_code**를 반환한다고 단언한다(확인된 3건):
- L16 `assert.equal(m['삼성바이오로직스'], '00877059')`
- L22 `assert.equal(parseCorpCodeXml(xml)['삼성전자'], '00126380')`
- L29 `assert.equal(parseCorpCodeXml(xml)['미래에셋증권'], null)` ← 동명 모호는 **null 유지**

맵 값을 `{ corp, stock }` 객체로 바꾸므로 이 3건을 `.corp`로 수정한다(L29는 null 그대로):

```js
assert.equal(m['삼성바이오로직스'].corp, '00877059');
assert.equal(m['삼성바이오로직스'].stock, '207940');
// ...
assert.equal(parseCorpCodeXml(xml)['삼성전자'].corp, '00126380');
// ...
assert.equal(parseCorpCodeXml(xml)['미래에셋증권'], null); // 모호 → null 유지(변경 없음)
```

그리고 신규 테스트 추가:

```js
test('parseCorpCodeXml: stock_code도 함께 보존 (KR 시세용)', () => {
  const xml = `<list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SEC</corp_eng_name><stock_code>005930</stock_code></list>`;
  assert.equal(parseCorpCodeXml(xml)['삼성전자'].stock, '005930');
});

test('parseCorpCodeXml: 동명 3건 — null 고착(리셋 안 됨)', () => {
  const xml = `<list><corp_code>001</corp_code><corp_name>A</corp_name><stock_code>111</stock_code></list>
<list><corp_code>002</corp_code><corp_name>A</corp_name><stock_code>222</stock_code></list>
<list><corp_code>001</corp_code><corp_name>A</corp_name><stock_code>111</stock_code></list>`;
  assert.equal(parseCorpCodeXml(xml)['A'], null); // 한 번 null이면 끝까지 null
});
```

> **계약 변경 안전책**: `krCorpCode`는 `.corp`를 읽도록 동시 수정. 캐시(`corpcodes.json`)는 30일 TTL + 깨짐 try/catch 폴백이 있어 구 형식(문자열) 캐시는 1회 재다운로드로 신 형식(객체)으로 흡수된다. Task 2c에서 캐시를 먼저 지워 강제 재생성.

### 2b. 구현

`instruments.mjs`:

```js
// parseCorpCodeXml: 값으로 { corp, stock } 보존 (stock은 yfinance .KS/.KQ용)
export function parseCorpCodeXml(xml) {
  const map = {};
  const re = /<corp_code>(\d+)<\/corp_code>\s*<corp_name>([^<]+)<\/corp_name>(?:\s*<corp_eng_name>[^<]*<\/corp_eng_name>)?\s*<stock_code>([^<]*)<\/stock_code>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[3].trim()) continue;
    const nm = m[2].trim();
    const stock = m[3].trim();
    // 동명 상장사 모호 → null, 한 번 null이면 끝까지 고착(리셋 금지 — 환각 차단)
    if (nm in map) {
      if (map[nm] === null || map[nm].corp !== m[1]) map[nm] = null;
    } else {
      map[nm] = { corp: m[1], stock };
    }
  }
  return map;
}
```

`krCorpCode` 내부 루프에서 `code`(문자열) → `entry.corp`로 변경:

```js
  for (const [corpName, entry] of Object.entries(cache)) {
    if (norm(corpName) !== target) continue;
    if (entry === null) return null;
    if (found && found !== entry.corp) return null;
    found = entry.corp;
  }
  return found;
```

신규 export 추가:

```js
// KR 6자리 종목코드 (yfinance .KS/.KQ 라우팅용). 미상장·모호·미발견 → null.
export function krStockCode(name, apiKey = process.env.DART_API_KEY) {
  krCorpCode(name, apiKey); // 캐시 보장(부수효과)
  // krCorpCode가 채운 캐시를 재읽기 — 중복 다운로드 없음
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
```

### 2c. 테스트 통과 + 캐시 재생성 확인

```bash
rm -f scripts/.cache/corpcodes.json   # 구 형식 캐시 제거 (신 형식 재생성 강제)
node --test scripts/lib/instruments.test.js 2>&1 | grep -E "tests|pass|fail" | tail -5
node -e "import('./scripts/lib/instruments.mjs').then(m=>console.log('삼성전자',m.krCorpCode('삼성전자'),m.krStockCode('삼성전자')))"
```

`삼성전자 00126380 005930` 출력 기대.

### 2d. 커밋

```bash
git add scripts/lib/instruments.mjs scripts/lib/instruments.test.js
git commit -m "instruments: KR 6자리 종목코드(krStockCode) 추가 — yfinance .KS 라우팅용"
```

---

## Task 3 — 시세·밸류에이션 페처 (yfinance, 네트워크)

KR/US 공통으로 yfinance에서 밸류에이션(PER/PBR)·52주 고저·시총·FCF·종가배열을 받는 페처. raw만 받고 RSI/52주위치/FCF yield 계산은 Task 1 순수함수가 한다. (네트워크 함수 → 단위테스트 없음, 라이브 스모크로 검증 — 기존 `fetchMacroIndicators` 패턴과 동일.)

### 3a. python raw 수집기

`scripts/lib/yf-marketdata.py` 생성:

```python
#!/usr/bin/env python3
"""yfinance 시세·밸류에이션 raw → JSON. 사용: python3 yf-marketdata.py AAPL
계산(RSI·52주위치·FCF yield)은 Node(fundamentals.mjs)가 한다 — 여기선 raw만 넘긴다."""
import json, sys
import yfinance as yf

tk = sys.argv[1]
t = yf.Ticker(tk)
info = t.info or {}
num = lambda v: float(v) if isinstance(v, (int, float)) else None
try:
    h = t.history(period="2mo", interval="1d")
    closes = [float(x) for x in h["Close"].tolist() if x == x][-30:]  # RSI14 여유분
except Exception:
    closes = []
print(json.dumps({
    'trailingPE': num(info.get('trailingPE')),
    'forwardPE':  num(info.get('forwardPE')),
    'priceToBook': num(info.get('priceToBook')),
    'fiftyTwoWeekHigh': num(info.get('fiftyTwoWeekHigh')),
    'fiftyTwoWeekLow':  num(info.get('fiftyTwoWeekLow')),
    'currentPrice': num(info.get('currentPrice') or info.get('regularMarketPrice')),
    'marketCap': num(info.get('marketCap')),
    'freeCashflow': num(info.get('freeCashflow')),
    'payoutRatio': num(info.get('payoutRatio')),
    'dividendYield': num(info.get('dividendYield')),
    'closes': closes,
}, ensure_ascii=False))
```

### 3b. Node 페처

`scripts/lib/fundamentals.mjs` 의 `fetchUsFundamentals` 아래에 추가:

```js
// 시세·밸류에이션 (KR/US 공통, yfinance). yahooTicker: US='AAPL', KR='005930.KS'.
// RSI·52주위치·FCF yield는 Node 순수함수로 계산 — raw만 python에서 받는다.
export function fetchMarketData(yahooTicker) {
  const py = new URL('./yf-marketdata.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, yahooTicker], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 시세 조회 실패(${yahooTicker}): ${(r.stderr || '').slice(-200)}`);
  const d = JSON.parse(r.stdout);
  return {
    forwardPE: d.forwardPE ?? d.trailingPE ?? null,
    pbr: d.priceToBook ?? null,
    rsi14: computeRsi14(d.closes),
    pos52w: compute52wPosition(d.currentPrice, d.fiftyTwoWeekHigh, d.fiftyTwoWeekLow),
    fcfYield: computeFcfYield(d.freeCashflow, d.marketCap),
    payoutRatio: d.payoutRatio != null ? Math.round(d.payoutRatio * 1000) / 10 : null,
    dividendYield: d.dividendYield != null ? Math.round(d.dividendYield * 1000) / 10 : null,
    source: `yfinance ${yahooTicker}`,
  };
}

// KR 6자리 → yahoo 티커. KOSPI .KS 우선, 빈 응답이면 .KQ 재시도(코스닥).
export function fetchKrMarketData(stockCode) {
  for (const sfx of ['.KS', '.KQ']) {
    try {
      const d = fetchMarketData(`${stockCode}${sfx}`);
      if (d.rsi14 != null || d.pos52w != null || d.forwardPE != null) return d;
    } catch { /* 다음 접미사 시도 */ }
  }
  return null;
}
```

### 3c. 라이브 스모크

```bash
node -e "import('./scripts/lib/fundamentals.mjs').then(m=>{console.log('US',m.fetchMarketData('AAPL'));console.log('KR',m.fetchKrMarketData('005930'));})"
```

US/KR 모두 rsi14·pos52w·forwardPE에 숫자가 나오는지 확인. (값 자체는 시점 의존 — null만 아니면 OK. 전부 null이면 yfinance 응답 구조 점검.)

### 3d. 커밋

```bash
git add scripts/lib/yf-marketdata.py scripts/lib/fundamentals.mjs
git commit -m "시세·밸류에이션 페처 추가 (fetchMarketData/fetchKrMarketData, yfinance raw→Node 계산)"
```

---

## Task 4 — buildEvalFacts 조립기 + 테스트

식별자 매핑 + 페처 결과를 5축 facts와 시트 적재용 axisItems로 조립. **페처를 인자로 주입**해 순수 테스트(스텁) 가능하게 만든다. 매핑/페처 실패는 추정 없이 "데이터 부족"으로 표기.

### 4a. 실패 테스트

`scripts/lib/eval-facts.test.js` 생성:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvalFacts } from './eval-facts.mjs';

const krFundStub = () => ({ market: 'KR', source: 'OpenDart 2026 1Q(연결)',
  revenueYoY: 12.3, opMargin: 18.5, roe: 9.2, debtRatio: 51.4, opYoYCurr: 5, opYoYPrev: 3 });
const mktStub = () => ({ forwardPE: 14.2, pbr: 1.3, rsi14: 47.5, pos52w: 38.0,
  fcfYield: 4.1, payoutRatio: 25.0, dividendYield: 2.1, source: 'yfinance 005930.KS' });

test('buildEvalFacts: KR 정상 — 5축 axisItems 채움, 숫자는 Node값', () => {
  const f = buildEvalFacts({ name: '삼성전자', market: 'KR' },
    { corpCode: '00126380', stockCode: '005930' },
    { krFund: krFundStub, usFund: null, krMkt: mktStub, usMkt: null });
  assert.equal(f.axisItems.수익성.find(i => i.metric === 'operating_margin').value, '18.5%');
  assert.equal(f.axisItems.밸류에이션.find(i => i.label.includes('PER')).value, '14.2');
  assert.equal(f.axisItems.모멘텀.find(i => i.metric === 'rsi').value, '47.5');
  // source는 반드시 Node 페처 출처 — LLM 표기 금지
  assert.ok(f.axisItems.수익성[0].source.includes('OpenDart'));
});

test('buildEvalFacts: 매핑 실패 — 추정 없이 데이터부족 표기', () => {
  const f = buildEvalFacts({ name: '미지의종목', market: 'KR' },
    { corpCode: null, stockCode: null },
    { krFund: krFundStub, usFund: null, krMkt: mktStub, usMkt: null });
  assert.ok(f.factsText.includes('데이터 부족'));
  assert.deepEqual(f.axisItems.수익성, []); // corpCode 없으면 재무 비움
});
```

### 4b. 테스트 실행 → 실패 확인

```bash
node --test scripts/lib/eval-facts.test.js 2>&1 | tail -5
```

### 4c. 구현

`scripts/lib/eval-facts.mjs` 생성:

```js
// 평가 카드 facts 조립기 — Node 결정론 숫자를 5축 axisItems + 프롬프트 텍스트로 만든다.
// 페처는 인자 주입(테스트용 스텁 가능). 매핑·페처 실패는 추정 없이 '데이터 부족' 표기(환각 차단).

const fmtPct = (v) => v == null ? null : `${v}%`;
const fmtNum = (v) => v == null ? null : String(v);
const item = (label, value, source, metric) =>
  value == null ? null : { label, value, source, ...(metric ? { metric } : {}) };
const compact = (arr) => arr.filter(Boolean);

export function buildEvalFacts(entry, ids, fetchers) {
  const isKr = (entry.market || '').toUpperCase() === 'KR'
    || (!entry.market && ids.corpCode != null);
  const missing = [];

  // 재무 (수익성·안정성·현금흐름 일부)
  let fund = null;
  if (isKr && ids.corpCode && fetchers.krFund) fund = fetchers.krFund(ids.corpCode);
  else if (!isKr && ids.ticker && fetchers.usFund) fund = fetchers.usFund(ids.ticker);
  else missing.push(isKr ? 'corp_code 매핑 실패(재무)' : 'US 티커 매핑 실패(재무)');

  // 시세·밸류에이션·모멘텀
  let mkt = null;
  if (isKr && ids.stockCode && fetchers.krMkt) mkt = fetchers.krMkt(ids.stockCode);
  else if (!isKr && ids.ticker && fetchers.usMkt) mkt = fetchers.usMkt(ids.ticker);
  if (!mkt) missing.push(isKr ? '종목코드 매핑 실패(시세)' : 'US 티커 매핑 실패(시세)');

  const fs = fund?.source || '데이터 부족';
  const ms = mkt?.source || '데이터 부족';

  const axisItems = {
    수익성: compact([
      item('영업이익률', fmtPct(fund?.opMargin), fs, 'operating_margin'),
      item('매출성장률 YoY', fmtPct(fund?.revenueYoY), fs),
      item('ROE', fmtPct(fund?.roe), fs),
    ]),
    안정성: compact([
      item('부채비율', fmtPct(fund?.debtRatio), fs),
    ]),
    밸류에이션: compact([
      item('Forward PER', fmtNum(mkt?.forwardPE), ms, 'fwd_per_band'),
      item('PBR', fmtNum(mkt?.pbr), ms),
    ]),
    현금흐름: compact([
      item('FCF yield', fmtPct(mkt?.fcfYield), ms, 'fcf_yield'),
      item('배당성향', fmtPct(mkt?.payoutRatio), ms),
    ]),
    모멘텀: compact([
      item('RSI(14)', fmtNum(mkt?.rsi14), ms, 'rsi'),
      item('52주 위치', fmtPct(mkt?.pos52w), ms, '52w_position'),
    ]),
  };

  // 프롬프트용 사람이 읽는 텍스트
  const lines = [];
  for (const ax of ['수익성', '안정성', '밸류에이션', '현금흐름', '모멘텀']) {
    const items = axisItems[ax];
    lines.push(`- ${ax}: ${items.length ? items.map(i => `${i.label} ${i.value}`).join(', ') : '데이터 부족'}`);
  }
  if (missing.length) lines.push(`- ⚠️ 데이터 부족: ${missing.join('; ')} → 해당 축은 "(데이터 부족)" 표기, 추정 금지`);

  return { axisItems, factsText: lines.join('\n'), market: isKr ? 'KR' : 'US' };
}
```

### 4d. 테스트 통과

```bash
node --test scripts/lib/eval-facts.test.js 2>&1 | grep -E "tests|pass|fail" | tail -5
```

### 4e. 커밋

```bash
git add scripts/lib/eval-facts.mjs scripts/lib/eval-facts.test.js
git commit -m "평가 facts 조립기 추가 (buildEvalFacts — Node 숫자→5축 axisItems, 매핑실패=데이터부족)"
```

---

## Task 5 — drain-eval-queue --auto 결정론화 (프롬프트 주입 + Read 전용)

`--auto` 경로에서만 Node facts를 만들어 프롬프트에 주입하고 LLM의 데이터 조달 지시를 제거한다. 반자동 경로는 무변경.

### 5a. import 추가

`scripts/drain-eval-queue.mjs` 상단:

```js
import { fetchKrFundamentals, fetchUsFundamentals, fetchKrMarketData, fetchMarketData } from './lib/fundamentals.mjs';
import { krCorpCode, krStockCode, usTicker } from './lib/instruments.mjs';
import { buildEvalFacts } from './lib/eval-facts.mjs';
```

### 5b. facts 구성 헬퍼 추가 (메인 루프 위)

```js
// --auto 전용: Node가 결정론 facts를 만든다. 실패해도 throw하지 않고 null facts로
// 폴백(프롬프트는 '데이터 부족'으로 진행) — 환각보다 공백이 낫다.
function buildAutoFacts(entry) {
  try {
    const ids = { corpCode: krCorpCode(entry.name), stockCode: krStockCode(entry.name), ticker: usTicker(entry.name) };
    return buildEvalFacts(entry, ids, {
      krFund: (c) => fetchKrFundamentals(c),
      usFund: (t) => fetchUsFundamentals(t),
      krMkt: (s) => fetchKrMarketData(s),
      usMkt: (t) => fetchMarketData(t),
    });
  } catch (e) {
    console.error(`  ⚠️ facts 조립 실패(${entry.name}): ${e.message} — 데이터 부족으로 진행`);
    return null;
  }
}
```

### 5c. buildBuyPrompt에 facts 주입 + LLM 조달 지시 제거

`buildBuyPrompt(entry, cachedEval, holdings, allocationData)` 시그니처에 `facts` 추가:
`buildBuyPrompt(entry, cachedEval, holdings, allocationData, facts)`. 함수 안에서 데이터 최신성/조달 블록(현재 410~416줄, "데이터 최신성 필수"부터 끝까지)을 아래로 교체:

```js
  const factsSection = facts ? `
✅ 검증된 펀더멘털 (Node가 OpenDart·yfinance로 결정론 산출 — 절대 재조회·수정 금지)
${facts.factsText}

⚠️ 위 숫자만 사용하세요. PER·ROE·RSI·52주 등 어떤 수치도 직접 fetch하거나 추정하지 마세요.
당신의 역할은 이 검증된 숫자로 5축 등급(🟢🟡🔴)과 근거·리스크·액션을 판단하는 것뿐입니다.
axisItems는 위 값을 그대로 옮기고, 데이터 부족 항목만 "(데이터 부족)"으로 두세요.`
    : `
⚠️ 검증된 펀더멘털을 산출하지 못했습니다. 모든 수치 항목을 "(데이터 부족)"으로 표기하고
정성적 판단만 하세요. 숫자를 추정하지 마세요.`;

  return `다음 종목을 5축 평가해줘 (Trading Agent/playbooks/active-evaluation.md 따라):

종목: ${sanitizeField(entry.name, 60)}
시장: ${market}${memo}

${posSection}
${allocationSection}${cacheSection}${factsSection}
출력 조건:
1. active-evaluation.md §5 표준 카드 양식으로 먼저 보여줘
2. 마지막에 \`\`\`json 펜스로 JSON 블록 출력 (queue-evaluation.md §2.4 양식)
3. JSON에 "axisItems" 포함 — 위 검증된 펀더멘털 값을 그대로 옮길 것
4. status는 항상 "보류"
5. 데이터 부족 항목은 추정 금지, "(데이터 부족)" 표기

⚠️ Frank 액션 권고 필수 (위 포지션·검증된 RSI/52주 기반으로 구체화):
- 현재 포지션 상태: 보유/미보유, 보유 시 평균단가 대비 갭
- 매수/추가 진입 조건: RSI + 구체적 가격대
- 1회 진입 금액: 500만원 이하 원칙
- 차익실현/손절 조건: 52주 위치 또는 RSI 기반 레벨
- 보유 중: 추가매수/홀딩 의견 / 미보유: 진입 우선순위`;
```

> `HEADLESS_NOTE`(496~506줄, Bash 조달 안내)는 더 이상 쓰지 않으므로 **제거**한다. 625줄 `const prompt = AUTO ? basePrompt + HEADLESS_NOTE : basePrompt;` 도 `const prompt = basePrompt;`로 단순화(facts가 이미 프롬프트에 포함).

### 5d. buildSellPrompt에도 facts 주입

`buildSellPrompt(entry, buyCard)` → `buildSellPrompt(entry, buyCard, facts)`. 출력 조건 3번 "현재 펀더멘털 재산출…"을 검증된 facts 사용으로 교체하고, `cardSection` 뒤에 `factsSection`(5c와 동일 변수, 함수 내 재구성) 삽입. JSON 스키마 블록은 유지하되 "axisItems는 위 검증된 펀더멘털 값을 옮길 것" 문구 추가.

### 5e. 호출부 수정 (메인 루프 624줄 부근)

```js
    const facts = AUTO ? buildAutoFacts(entry) : null;
    const basePrompt = sellMode
      ? buildSellPrompt(entry, buyCard, facts)
      : buildBuyPrompt(entry, cachedEval, holdings, allocationData, facts);
    const prompt = basePrompt;
```

640줄 헤드리스 호출을 Read 전용으로:

```js
        rawJson = await runHeadlessClaude(prompt, MODEL, 'Read');
```

### 5f. Node axisItems를 시트에 우선 적재

`buildRow(obj)` → `buildRow(obj, nodeAxis)`로 확장. 242줄 axisItems 적재를 Node값 우선으로:

```js
    nodeAxis ? JSON.stringify(nodeAxis) : (obj.axisItems ? JSON.stringify(obj.axisItems) : ''),
```

676줄 호출부: `const row = buildRow(obj, facts?.axisItems || null);`

> 이유: LLM이 검증된 숫자를 옮기다 실수해도 시트엔 Node 원본이 남는다. facts 없으면(매핑 실패) LLM axisItems로 폴백.

### 5g. dry-run 프롬프트 육안 검증

```bash
node scripts/drain-eval-queue.mjs --dry-run --auto <<< "" 2>&1 | head -60
```

> `--dry-run`이 큐를 읽으려면 토큰이 필요하므로, 실제로는 facts 단위 검증을 우선:

```bash
node -e "
import('./scripts/drain-eval-queue.mjs');
" 2>&1 | head -3   # import 에러(문법) 없는지
node -e "import('./scripts/lib/eval-facts.mjs').then(async m=>{
  const f=await import('./scripts/lib/fundamentals.mjs');
  const i=await import('./scripts/lib/instruments.mjs');
  const facts=m.buildEvalFacts({name:'삼성전자',market:'KR'},
    {corpCode:i.krCorpCode('삼성전자'),stockCode:i.krStockCode('삼성전자')},
    {krFund:f.fetchKrFundamentals,krMkt:f.fetchKrMarketData});
  console.log(facts.factsText); console.log(JSON.stringify(facts.axisItems,null,1));
})"
```

검증된 숫자(영업이익률·PER·RSI·52주)가 채워지는지 확인.

### 5h. lint + 전체 테스트

```bash
npm run lint && node --test scripts/lib/*.test.js 2>&1 | grep -E "tests|pass|fail" | tail -5
```

### 5i. 커밋

```bash
git add scripts/drain-eval-queue.mjs
git commit -m "drain --auto 결정론화: Node facts 주입·Read 전용·axisItems Node값 적재 (LLM 데이터 조달 제거)"
```

---

## Task 6 — E2E 라이브 검증

실제 큐 한 건(또는 임시 대기 건)으로 `--auto`를 돌려 카드가 검증된 숫자로 발행되는지 확인. **시트 쓰기 전 `--dry-run`으로 프롬프트를 먼저 눈으로 본다.**

```bash
# 1) dry-run: 프롬프트에 "검증된 펀더멘털" 블록이 들어가고 HEADLESS_NOTE(Bash 안내)가 사라졌는지
node scripts/drain-eval-queue.mjs --dry-run --auto <서비스토큰> 2>&1 | grep -A20 "검증된 펀더멘털" | head -30

# 2) 실제 1건 자동 평가(큐에 대기 1건 있을 때). Read 전용이라 12분 내 완료
node scripts/drain-eval-queue.mjs --auto <서비스토큰> 2>&1 | tail -30

# 3) 종목투자노트 마지막 행 axisItems가 Node JSON인지 확인 (PER/RSI 값이 Node 산출과 일치)
```

검증 포인트:
- 프롬프트에서 "OpenDart REST를 curl로" 같은 조달 지시가 사라졌다.
- 발행된 카드의 RSI·52주·PER이 Task 3 라이브 스모크 값과 일치(LLM이 안 지어냄).
- axisItems source가 `OpenDart …` / `yfinance …`(Node 출처).

문제 없으면 푸시:

```bash
git push origin main   # ← 사용자 확인 후
```

> launchd `drain`은 로컬 작업본을 돌리므로 커밋만으로 다음 cron부터 적용됨. 푸시는 GitHub 보존용 — **사용자에게 확인 후** 실행.

---

## Self-Review (작성자 점검)

- [x] 모든 raw 숫자 경로가 Node로 이동했나 — 재무(OpenDart)·시세/밸류/모멘텀(yfinance) 전부 Node 페처. LLM은 Read만.
- [x] 매핑 실패 시 추정 없이 "데이터 부족" — corpCode/stockCode/ticker null → 해당 축 빈 배열 + factsText 경고.
- [x] 순수함수는 테스트, 네트워크함수는 라이브 스모크 — 기존 `fundamentals.mjs` 분리 원칙 준수.
- [x] 기존 캐시(corpcodes.json) 형식 변경 호환 — `{corp,stock}`로 바꾸되 TTL+try/catch 폴백이 1회 재생성으로 흡수.
- [x] 반자동 경로 무변경 — facts/Read 전환은 `AUTO`일 때만.
- [x] axisItems 이중 안전 — Node값 우선, 없으면 LLM값 폴백.
- [ ] **미확정 리스크**: KR 밸류에이션/모멘텀을 yfinance `.KS`로 받음 — NaverFinance 대비 신뢰성은 active-evaluation.md가 명시한 공식 폴백 경로라 수용 가능. 단 `.KS` PER이 KR 회계기준과 다를 수 있어, 첫 라이브에서 삼성전자 PER을 네이버와 1회 대조 권장.
- [x] **해소됨**: `instruments.test.js` 기존 3건이 문자열 반환을 단언함을 확인 → Task 2a에 정확한 수정 지시 포함(`.corp`/`.stock`, 모호=null 유지, null 고착 테스트 추가).

## 실행 방식 선택

플랜대로 진행할 때 두 가지 방식이 있습니다:

1. **Subagent-Driven (권장)** — `superpowers:subagent-driven-development`로 Task별 서브에이전트가 TDD 사이클(실패테스트→구현→통과→커밋)을 격리 실행. 메인 컨텍스트 보호.
2. **Inline 실행** — 이 세션에서 Task 1→6 순차 직접 실행.

어느 쪽으로 진행할지 알려주세요.
