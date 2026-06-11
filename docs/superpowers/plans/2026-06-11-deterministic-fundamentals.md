# 리스크 엔진 데이터 신뢰성 — 결정론적 펀더멘털 계층 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** risk-monitor B모드와 backfill-baselines에서 LLM이 raw 재무 숫자를 만들지 못하게 한다 — Node가 OpenDart/yfinance에서 결정론적으로 조회·계산하고, LLM은 판단만 하며, Node가 가드레일 하한을 강제한다.

**Architecture:** 3계층. (1) `scripts/lib/fundamentals.mjs` — 순수 함수(보고서 기간 매핑, YoY, 파싱, 가드레일)와 얇은 페처. (2) `scripts/lib/instruments.mjs` — 종목명→corp_code(KR, OpenDart corpCode.xml 캐시)/티커(US, 고정 맵). (3) risk-monitor.mjs B모드·backfill-baselines.mjs 개조 — 데이터 주입 + 판단 전용 프롬프트 + Node 강제 가드. 시트의 근거데이터 컬럼은 LLM 출력이 아닌 Node 계산값을 기록.

**Tech Stack:** Node 내장(fetch, node:test, child_process). 외부 의존성 추가 없음. KR=OpenDart REST(`fnlttSinglAcnt`+`fnlttSinglIndx`), US=python3 yfinance(서브프로세스, JSON 출력).

**배경(왜):** 2026-06-08 risk-b 실행에서 헤드리스 Claude가 삼성바이오로직스 매출 YoY를 -3.2%로 환각(실제 OpenDart 검증값 +25.8%) → 거짓 🟡 "논리 훼손 주의" 신호가 시트에 적재됨. 같은 실행에서 SK하이닉스는 실행마다 수치가 달랐음. 원인: 데이터 조회+계산+판단을 전부 LLM 한 호출에 위임, 기간 규칙 하드코딩(`4~5월=1분기`), 검증 0.

**검증 기준값(ground truth, OpenDart 2026.1Q 연결 — 본 계획 작성 시 MCP로 확정):**
삼성바이오로직스(corp 00877059) 매출 1,257,119,188,891 / 전년동기 999,544,646,065 → YoY +25.8%. 영업이익 580,752,580,824 / 430,239,537,449 → +35.0%. 영업이익률 46.2%.

**Non-goals:** D모드(거시)는 이번 범위 밖(별도 후속). parse-notifications·drain-eval-queue 미변경.

---

### Task 1: fundamentals 순수 코어 + 테스트

**Files:**
- Create: `scripts/lib/fundamentals.mjs`
- Create: `scripts/lib/fundamentals.test.js`
- Modify: `package.json` (test glob에 scripts 포함)

- [ ] **Step 1: package.json test 스크립트에 scripts 글롭 추가**

`package.json`의 scripts에서:
```json
"test": "node --test 'src/**/*.test.js' 'scripts/**/*.test.js'",
"test:watch": "node --test --watch 'src/**/*.test.js' 'scripts/**/*.test.js'",
```

- [ ] **Step 2: 실패하는 테스트 작성** — `scripts/lib/fundamentals.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reprtCodeForDate, prevPeriod, computeYoY, parseKrAmounts, checkGuardrails,
} from './fundamentals.mjs';

// CLAUDE.md 데이터 기준 표: 1~3월=전년 사업, 4~5월=1Q, 6~8월=반기, 9~12월=3Q
test('reprtCodeForDate: 월→보고서 매핑', () => {
  assert.deepEqual(reprtCodeForDate(new Date('2026-02-15')), { bsnsYear: '2025', reprtCode: '11011' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-05-01')), { bsnsYear: '2026', reprtCode: '11013' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-06-11')), { bsnsYear: '2026', reprtCode: '11012' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-10-01')), { bsnsYear: '2026', reprtCode: '11014' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-12-20')), { bsnsYear: '2026', reprtCode: '11014' });
});

test('prevPeriod: 미공시 폴백 체인 (반기→1Q→전년 사업→전년 3Q)', () => {
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11012' }), { bsnsYear: '2026', reprtCode: '11013' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11013' }), { bsnsYear: '2025', reprtCode: '11011' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2025', reprtCode: '11011' }), { bsnsYear: '2025', reprtCode: '11014' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11014' }), { bsnsYear: '2026', reprtCode: '11012' });
});

test('computeYoY: 정상/0분모/결측', () => {
  assert.equal(computeYoY(1257119188891, 999544646065), 25.8);  // 삼바 1Q 실측
  assert.equal(computeYoY(100, 0), null);
  assert.equal(computeYoY(null, 100), null);
});

test('parseKrAmounts: CFS 우선, thstrm_add_amount 우선, 콤마 제거', () => {
  const list = [
    { fs_div: 'OFS', sj_div: 'IS', account_nm: '매출액', thstrm_amount: '1', frmtrm_amount: '1' },
    { fs_div: 'CFS', sj_div: 'IS', account_nm: '매출액', thstrm_add_amount: '1,257,119,188,891', frmtrm_add_amount: '999,544,646,065' },
    { fs_div: 'CFS', sj_div: 'IS', account_nm: '영업이익', thstrm_amount: '580,752,580,824', frmtrm_amount: '430,239,537,449' },
    { fs_div: 'CFS', sj_div: 'IS', account_nm: '당기순이익(손실)', thstrm_amount: '469,245,424,673', frmtrm_amount: '375,553,550,929' },
    { fs_div: 'CFS', sj_div: 'BS', account_nm: '부채총계', thstrm_amount: '4,072,163,846,703' },
    { fs_div: 'CFS', sj_div: 'BS', account_nm: '자본총계', thstrm_amount: '7,922,835,735,735' },
  ];
  const a = parseKrAmounts(list);
  assert.equal(a.revenue.curr, 1257119188891);
  assert.equal(a.revenue.prev, 999544646065);
  assert.equal(a.opIncome.curr, 580752580824);
  assert.equal(a.netIncome.curr, 469245424673);
  assert.equal(a.liabilities.curr, 4072163846703);
  assert.equal(a.equity.curr, 7922835735735);
});

test('parseKrAmounts: CFS 없으면 OFS 폴백', () => {
  const list = [{ fs_div: 'OFS', sj_div: 'IS', account_nm: '매출액', thstrm_amount: '100', frmtrm_amount: '50' }];
  assert.equal(parseKrAmounts(list).revenue.curr, 100);
});

test('checkGuardrails: 영업이익 2분기 연속 감소 / 부채비율 +20%p', () => {
  assert.deepEqual(checkGuardrails({ opYoYCurr: -5, opYoYPrev: -3, debtRatio: 51, baselineDebtRatio: 50 }),
    ['영업이익 YoY 2분기 연속 감소']);
  assert.deepEqual(checkGuardrails({ opYoYCurr: 10, opYoYPrev: -3, debtRatio: 75, baselineDebtRatio: 50 }),
    ['부채비율 급증(기준선 대비 +20%p 이상)']);
  assert.deepEqual(checkGuardrails({ opYoYCurr: 10, opYoYPrev: null, debtRatio: null, baselineDebtRatio: 50 }), []);
});
```

- [ ] **Step 3: 실패 확인**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)|fundamentals"`
Expected: FAIL (`Cannot find module './fundamentals.mjs'`)

- [ ] **Step 4: 순수 코어 구현** — `scripts/lib/fundamentals.mjs`

```js
// 결정론적 펀더멘털 데이터 계층 — risk-monitor(B)·backfill-baselines가 사용.
// 원칙: raw 숫자는 절대 LLM이 만들지 않는다. 여기서 조회·계산한 값만 시트와 프롬프트에 쓴다.
import { spawnSync } from 'node:child_process';

// CLAUDE.md 데이터 기준: 1~3월=전년 사업(11011), 4~5월=1Q(11013), 6~8월=반기(11012), 9~12월=3Q(11014)
export function reprtCodeForDate(d = new Date()) {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  if (m <= 3) return { bsnsYear: String(y - 1), reprtCode: '11011' };
  if (m <= 5) return { bsnsYear: String(y), reprtCode: '11013' };
  if (m <= 8) return { bsnsYear: String(y), reprtCode: '11012' };
  return { bsnsYear: String(y), reprtCode: '11014' };
}

// 미공시 폴백 + 직전 보고서(2분기 연속 추세용): 1Q→전년 사업→전년 3Q→전년 반기→...
const ORDER = ['11013', '11012', '11014', '11011']; // 연중 시간순
export function prevPeriod({ bsnsYear, reprtCode }) {
  const i = ORDER.indexOf(reprtCode);
  if (i === 0) return { bsnsYear: String(Number(bsnsYear) - 1), reprtCode: '11011' };
  return { bsnsYear, reprtCode: ORDER[i - 1] };
}

const num = (s) => { const n = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

export function computeYoY(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null;
  return Math.round((curr - prev) / Math.abs(prev) * 1000) / 10;
}

// fnlttSinglAcnt(주요계정) 응답 파싱. CFS 우선, 손익은 누적(add_amount) 우선.
export function parseKrAmounts(list) {
  const cfs = (list || []).filter(r => r.fs_div === 'CFS');
  const src = cfs.length ? cfs : (list || []).filter(r => r.fs_div === 'OFS');
  const pick = (...names) => src.find(r => names.includes(r.account_nm)) || null;
  const amt = (r, k) => r ? num(r[`${k}_add_amount`] ?? r[`${k}_amount`]) : null;
  const get = (...names) => { const r = pick(...names); return { curr: amt(r, 'thstrm'), prev: amt(r, 'frmtrm') }; };
  return {
    revenue: get('매출액', '수익(매출액)', '영업수익'),
    opIncome: get('영업이익', '영업이익(손실)'),
    netIncome: get('당기순이익(손실)', '당기순이익', '분기순이익', '반기순이익'),
    assets: get('자산총계'), liabilities: get('부채총계'), equity: get('자본총계'),
  };
}

// fnlttSinglIndx(재무비율) 응답 파싱 — idx_nm 변형을 정규식으로 흡수.
export function parseKrRatios(list) {
  const find = (re) => { const r = (list || []).find(x => re.test(String(x.idx_nm ?? ''))); return r ? num(r.idx_val) : null; };
  return {
    grossMargin: find(/총이익률/),
    opMargin: find(/영업이익률/),
    roe: find(/ROE|자기자본.*이익률/i),
    debtRatio: find(/부채비율/),
  };
}

// 가드레일(결정론) — 해당 시 Node가 신호 하한을 🟡로 강제한다.
export function checkGuardrails(g) {
  const t = [];
  if (g.opYoYCurr != null && g.opYoYPrev != null && g.opYoYCurr < 0 && g.opYoYPrev < 0)
    t.push('영업이익 YoY 2분기 연속 감소');
  if (g.debtRatio != null && g.baselineDebtRatio != null && g.debtRatio - g.baselineDebtRatio >= 20)
    t.push('부채비율 급증(기준선 대비 +20%p 이상)');
  return t;
}
```

(페처 함수는 Task 3에서 같은 파일에 추가 — 이 Task는 순수 함수만.)

- [ ] **Step 5: 통과 확인**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: 기존 14 + 신규 7 = `pass 21` `fail 0`

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/lib/fundamentals.mjs scripts/lib/fundamentals.test.js
git commit -m "리스크 엔진 데이터 계층: 보고서 기간 매핑·YoY·파싱·가드레일 순수 함수 + 테스트"
```

---

### Task 2: instruments — 종목명→식별자 매핑

**Files:**
- Create: `scripts/lib/instruments.mjs`
- Create: `scripts/lib/instruments.test.js`
- Modify: `.gitignore` (캐시 제외)

- [ ] **Step 1: 실패하는 테스트 작성** — `scripts/lib/instruments.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usTicker, parseCorpCodeXml } from './instruments.mjs';

test('usTicker: 한글명→티커, 공백·대소문자 정규화', () => {
  assert.equal(usTicker('애플'), 'AAPL');
  assert.equal(usTicker('알파벳 Class A'), 'GOOGL');
  assert.equal(usTicker('알파벳  class a'), 'GOOGL');
  assert.equal(usTicker('없는종목'), null);
});

test('parseCorpCodeXml: 상장사만 corp_code 매핑', () => {
  const xml = `<result><list><corp_code>00877059</corp_code><corp_name>삼성바이오로직스</corp_name><stock_code>207940</stock_code><modify_date>20260101</modify_date></list>
<list><corp_code>99999999</corp_code><corp_name>비상장사</corp_name><stock_code> </stock_code><modify_date>20260101</modify_date></list></result>`;
  const m = parseCorpCodeXml(xml);
  assert.equal(m['삼성바이오로직스'], '00877059');
  assert.equal(m['비상장사'], undefined);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: FAIL (`Cannot find module './instruments.mjs'`)

- [ ] **Step 3: 구현** — `scripts/lib/instruments.mjs`

```js
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
  const re = /<list><corp_code>(\d+)<\/corp_code><corp_name>([^<]+)<\/corp_name><stock_code>([^<]*)<\/stock_code>/g;
  let m;
  while ((m = re.exec(xml.replace(/\s*\n\s*/g, '')))) {
    if (m[3].trim()) map[m[2].trim()] = m[1];
  }
  return map;
}

// corpCode.xml(zip) 다운로드 → 상장사만 {corp_name: corp_code} 캐시. 30일 지나면 갱신.
export function krCorpCode(name, apiKey = process.env.DART_API_KEY) {
  let cache = null;
  if (existsSync(CACHE_FILE)) {
    const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - c.fetchedAt < 30 * 86400e3) cache = c.map;
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
  for (const [corpName, code] of Object.entries(cache)) {
    if (norm(corpName) === target) return code;
  }
  return null;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: `pass 23` `fail 0`

- [ ] **Step 5: .gitignore에 캐시 추가**

`.gitignore` 끝에:
```
scripts/.cache/
```

- [ ] **Step 6: 실데이터 점검 (네트워크, DART_API_KEY 필요)**

Run: `node -e "import('./scripts/lib/sheets-common.mjs').then(async c=>{c.loadEnv();const i=await import('./scripts/lib/instruments.mjs');console.log(i.krCorpCode('삼성바이오로직스'))})"`
Expected: `00877059`

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/instruments.mjs scripts/lib/instruments.test.js .gitignore
git commit -m "종목명→corp_code/티커 결정론 매핑 (corpCode.xml 캐시, 미매핑은 null로 환각 차단)"
```

---

### Task 3: 페처 — fetchKrFundamentals / fetchUsFundamentals + 실측 검증

**Files:**
- Modify: `scripts/lib/fundamentals.mjs` (페처 추가)
- Create: `scripts/lib/yf-fundamentals.py`

- [ ] **Step 1: US용 python 스크립트** — `scripts/lib/yf-fundamentals.py`

```python
#!/usr/bin/env python3
"""yfinance 분기 펀더멘털 → JSON 한 줄. 사용: python3 yf-fundamentals.py AAPL"""
import json, sys
import yfinance as yf

t = yf.Ticker(sys.argv[1])
info = t.info or {}
qf = t.quarterly_financials

def series(name):
    try:
        return [float(x) for x in qf.loc[name].tolist() if x == x]  # NaN 제외
    except Exception:
        return []

def yoy(a, i):
    if len(a) > i + 4 and a[i + 4]:
        return round((a[i] - a[i + 4]) / abs(a[i + 4]) * 1000) / 10
    return None

rev, op = series('Total Revenue'), series('Operating Income')
pct = lambda v: round(v * 1000) / 10 if isinstance(v, (int, float)) else None
d2e = info.get('debtToEquity')
print(json.dumps({
    'revenueYoY': yoy(rev, 0), 'opYoYCurr': yoy(op, 0), 'opYoYPrev': yoy(op, 1),
    'grossMargin': pct(info.get('grossMargins')), 'opMargin': pct(info.get('operatingMargins')),
    'roe': pct(info.get('returnOnEquity')),
    'debtRatio': round(d2e * 10) / 10 if isinstance(d2e, (int, float)) else None,
    'eps': info.get('trailingEps'), 'source': 'yfinance quarterly+info(TTM)',
}, ensure_ascii=False))
```

주의: yfinance quarterly는 보통 5분기만 제공 → `opYoYPrev`(6분기 필요)는 None일 수 있음. 가드레일 1번은 null-안전(checkGuardrails가 스킵)이므로 그대로 둔다.

- [ ] **Step 2: 페처를 fundamentals.mjs에 추가** (파일 끝에 append)

```js
// ── 페처 (네트워크 — 순수 함수와 분리, 테스트는 순수부만) ──────────
const DART = 'https://opendart.fss.or.kr/api';

async function dartJson(path, params, apiKey) {
  const q = new URLSearchParams({ crtfc_key: apiKey, ...params });
  const res = await fetch(`${DART}/${path}?${q}`);
  if (!res.ok) throw new Error(`OpenDart HTTP ${res.status}`);
  const j = await res.json();
  if (j.status === '013') return null;            // 조회 데이터 없음(미공시)
  if (j.status !== '000') throw new Error(`OpenDart ${j.status}: ${j.message}`);
  return j.list;
}

// 미공시면 prevPeriod로 한 번 폴백. 그래도 없으면 null.
async function dartWithFallback(path, corpCode, period, extra, apiKey) {
  for (const p of [period, prevPeriod(period)]) {
    const list = await dartJson(path, {
      corp_code: corpCode, bsns_year: p.bsnsYear, reprt_code: p.reprtCode, ...extra,
    }, apiKey);
    if (list) return { list, period: p, fellBack: p !== period };
  }
  return null;
}

const REPRT_LABEL = { 11011: '사업보고서', 11013: '1분기보고서', 11012: '반기보고서', 11014: '3분기보고서' };

export async function fetchKrFundamentals(corpCode, now = new Date(), apiKey = process.env.DART_API_KEY) {
  if (!apiKey) throw new Error('DART_API_KEY 미설정');
  const period = reprtCodeForDate(now);
  const cur = await dartWithFallback('fnlttSinglAcnt.json', corpCode, period, {}, apiKey);
  if (!cur) throw new Error('OpenDart 주요계정 조회 실패(당기·폴백 모두 미공시)');
  const prevP = prevPeriod(cur.period);
  const prevList = await dartJson('fnlttSinglAcnt.json', {
    corp_code: corpCode, bsns_year: prevP.bsnsYear, reprt_code: prevP.reprtCode,
  }, apiKey);

  const a = parseKrAmounts(cur.list);
  const pa = prevList ? parseKrAmounts(prevList) : null;

  let ratios = { grossMargin: null, opMargin: null, roe: null, debtRatio: null };
  for (const idx of ['M210000', 'M220000']) {
    const list = await dartJson('fnlttSinglIndx.json', {
      corp_code: corpCode, bsns_year: cur.period.bsnsYear, reprt_code: cur.period.reprtCode, idx_cl_code: idx,
    }, apiKey).catch(() => null);
    if (list) ratios = { ...ratios, ...Object.fromEntries(Object.entries(parseKrRatios(list)).filter(([, v]) => v != null)) };
  }
  // 비율 API 미제공 시 금액으로 직접 계산(영업이익률·부채비율)
  if (ratios.opMargin == null && a.opIncome.curr != null && a.revenue.curr) ratios.opMargin = Math.round(a.opIncome.curr / a.revenue.curr * 1000) / 10;
  if (ratios.debtRatio == null && a.liabilities.curr != null && a.equity.curr) ratios.debtRatio = Math.round(a.liabilities.curr / a.equity.curr * 1000) / 10;

  return {
    market: 'KR',
    source: `OpenDart ${cur.period.bsnsYear} ${REPRT_LABEL[cur.period.reprtCode]}(연결)${cur.fellBack ? ' (분기 미공시 폴백)' : ''}`,
    revenue: a.revenue.curr, revenueYoY: computeYoY(a.revenue.curr, a.revenue.prev),
    opIncome: a.opIncome.curr,
    opYoYCurr: computeYoY(a.opIncome.curr, a.opIncome.prev),
    opYoYPrev: pa ? computeYoY(pa.opIncome.curr, pa.opIncome.prev) : null,
    netIncomeYoY: computeYoY(a.netIncome.curr, a.netIncome.prev),
    ...ratios, eps: null,
  };
}

export function fetchUsFundamentals(ticker) {
  const py = new URL('./yf-fundamentals.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, ticker], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 실패: ${(r.stderr || '').slice(-200)}`);
  return { market: 'US', revenue: null, opIncome: null, netIncomeYoY: null, ...JSON.parse(r.stdout) };
}
```

- [ ] **Step 3: lint + 기존 테스트 회귀 확인**

Run: `npm run lint 2>&1 | tail -3 && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: lint 통과, `pass 23` `fail 0`

- [ ] **Step 4: 실측 검증 — 삼바 ground truth 일치 확인 (네트워크)**

Run:
```bash
node -e "import('./scripts/lib/sheets-common.mjs').then(async c=>{c.loadEnv();const f=await import('./scripts/lib/fundamentals.mjs');console.log(JSON.stringify(await f.fetchKrFundamentals('00877059'),null,1))})"
```
Expected: `revenueYoY: 25.8`, `opYoYCurr: 35`, `opMargin: 46.2` 부근. **25.8이 안 나오면 파서 버그 — 원시 응답을 덤프해 account_nm/필드를 맞출 것.**

Run: `node -e "import('./scripts/lib/fundamentals.mjs').then(f=>console.log(JSON.stringify(f.fetchUsFundamentals('AAPL'))))"`
Expected: revenueYoY·grossMargin 등 숫자 채워진 JSON.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/fundamentals.mjs scripts/lib/yf-fundamentals.py
git commit -m "결정론 펀더멘털 페처: OpenDart 주요계정+재무비율(미공시 폴백)·yfinance — 삼바 YoY +25.8% 실측 검증"
```

---

### Task 4: risk-monitor B모드 개조 — 데이터 주입·판단 전용·가드 강제

**Files:**
- Modify: `scripts/risk-monitor.mjs` (buildLogicPrompt 교체, B 루프 개조)
- Modify: `scripts/lib/sheets-common.mjs:298` (runHeadlessClaude에 allowedTools 파라미터)

- [ ] **Step 1: runHeadlessClaude 시그니처 확장** — sheets-common.mjs:298

```js
export function runHeadlessClaude(prompt, model = 'sonnet', allowedTools = 'Bash,Read,Glob,Grep,WebFetch') {
```
그리고 spawn 인자의 `'--allowedTools', 'Bash,Read,Glob,Grep,WebFetch'` → `'--allowedTools', allowedTools`.

- [ ] **Step 2: risk-monitor.mjs import에 추가**

```js
import { fetchKrFundamentals, fetchUsFundamentals, checkGuardrails } from './lib/fundamentals.mjs';
import { krCorpCode, usTicker } from './lib/instruments.mjs';
```

- [ ] **Step 3: buildLogicPrompt 전면 교체** (risk-monitor.mjs:107-148) — 판단 전용

```js
// 판단 전용 프롬프트 — 숫자는 Node가 조회·계산해 주입. LLM 재조회·재계산 금지.
function buildLogicPrompt(h, facts, guardrails, baseline, buyCard) {
  const baseLine = baseline
    ? `[저장된 기준선 (${baseline.date})]
매출총이익률 ${baseline.gross_margin} · 영업이익률 ${baseline.operating_margin} · ROE ${baseline.roe} · 부채비율 ${baseline.debt_ratio} · EPS ${baseline.eps}
(${baseline.note || ''})`
    : '[저장된 기준선] 없음 — 현재 펀더멘털만으로 절대 평가';
  const cardLine = buyCard
    ? `[매수 논리 (${buyCard.date})]
결론: ${buyCard.conclusion}
근거: ${(buyCard.reasons || []).join(' / ') || '(미기록)'}
리스크: ${(buyCard.risks || []).join(' / ') || '(미기록)'}`
    : '[매수 논리] 종목투자노트에 없음 — 기준선 대비 변화만 판단';

  return `[논리 훼손 점검 — 주간] 보유종목의 매수 논리가 펀더멘털상 훼손됐는지 "판단만" 해줘.

종목: ${h.name} (${h.market})

[검증된 펀더멘털 — 시스템이 ${facts.source}에서 직접 조회·계산한 값. 이 수치만 사용할 것.
 절대 재조회·재계산·추정하지 말 것. null 은 "데이터 없음"이며 불리하게 해석하지 말 것]
${JSON.stringify(facts, null, 1)}

[가드레일 사전판정(시스템 계산)] ${guardrails.length ? guardrails.join(' · ') + ' → 신호는 최소 🟡' : '트리거 없음'}

${baseLine}

${cardLine}

판단 규칙:
- 위 검증된 수치와 기준선/매수논리를 비교해 "매수 근거의 핵심 전제가 깨졌는가"만 판단.
- 신호: 🟢 논리 유효 / 🟡 약화·주의 / 🔴 훼손(매도 평가 필요)
- 단순 주가 하락·52주/RSI 과열은 단독 신호 금지(펀더멘털 우선).
- summary·detail에 쓰는 모든 숫자는 위 JSON 값 그대로 인용(단위·부호 변형 금지).

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{"signal":"🟢","summary":"한줄","detail":"무엇이 어떻게 바뀌었나(기준선 대비)"}
\`\`\``;
}
```
(주의: `HEADLESS_NOTE` 제거 — 데이터 조회 지침 자체가 사라짐. import에서 안 쓰면 제거.)

- [ ] **Step 4: B 루프 개조** (risk-monitor.mjs:318-340의 `for (const h of targets)` 본문)

```js
  for (const h of targets) {
    const baseline = bMap.get(h.name) || null;
    const buyCard = findBuyCard(noteRows, h.name);

    // ① 결정론 데이터 조회 — 실패 시 LLM 호출 없이 '데이터 부족' 행(침묵 실패 방지)
    let facts = null, fetchErr = null;
    try {
      if (h.market === 'KR') {
        const code = krCorpCode(h.name);
        if (!code) throw new Error(`corp_code 미해결: ${h.name}`);
        facts = await fetchKrFundamentals(code);
      } else {
        const tk = usTicker(h.name);
        if (!tk) throw new Error(`US 티커 미등록: ${h.name} — instruments.mjs US_MAP에 추가 필요`);
        facts = fetchUsFundamentals(tk);
      }
    } catch (e) { fetchErr = e; }

    if (fetchErr) {
      const row = [todayKST(), 'B', h.name, '🟡', '데이터 조회 실패 — 수동 확인 필요',
        fetchErr.message, '{}', baseline ? baseline.date : '없음'];
      if (!DRY_RUN) { await appendValues(token, `${RISK_SHEET}!A2`, [row]); }
      console.error(`   🟡 ${h.name} 데이터 부족: ${fetchErr.message}`);
      fail++;
      continue;
    }

    // ② 가드레일 사전판정(결정론)
    const guardrails = checkGuardrails({
      opYoYCurr: facts.opYoYCurr, opYoYPrev: facts.opYoYPrev,
      debtRatio: facts.debtRatio,
      baselineDebtRatio: baseline ? parseFloat(String(baseline.debt_ratio).replace(/[%,]/g, '')) || null : null,
    });

    const prompt = buildLogicPrompt(h, facts, guardrails, baseline, buyCard);
    if (DRY_RUN) { console.log(`\n┌─── B 프롬프트 [${h.name}] ───┐\n` + prompt + '\n└──────────────────┘'); continue; }
    console.log(`\n⏳ ${h.name} 논리 판단 중...`);
    try {
      const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read'));
      // ③ 하네스: 가드레일 발동인데 🟢이면 🟡로 강제. 근거데이터는 LLM 아닌 Node 계산값.
      let signal = r.signal || '🟢';
      let summary = r.summary || '';
      if (guardrails.length && signal === '🟢') {
        signal = '🟡';
        summary = `[가드레일 강제🟡: ${guardrails.join('·')}] ${summary}`;
      }
      const row = [todayKST(), 'B', h.name, signal, summary, r.detail || '',
        JSON.stringify(facts), r.baseline_ref || (baseline ? baseline.date : '없음')];
      await appendValues(token, `${RISK_SHEET}!A2`, [row]);
      console.log(`   ${signal} ${h.name}: ${summary}`);
      await pushNewReds([row], priorRedKeys);
      if (signal !== '🟢') alerts++;
      ok++;
    } catch (e) {
      console.error(`   ❌ ${h.name} 실패: ${e.message}`);
      fail++;
    }
  }
```
(루프 위 `let ok = 0, fail = 0, alerts = 0;`는 기존 그대로. DRY_RUN일 때도 페치는 실행되어 프롬프트에 실데이터가 들어감 — dry-run 검증의 핵심.)

- [ ] **Step 5: dry-run으로 검증 (시트 쓰기 없음, 네트워크만)**

Run: `node scripts/risk-monitor.mjs --mode=B --dry-run 2>&1 | head -80`
Expected: 삼성바이오로직스 프롬프트 안에 `"revenueYoY": 25.8` 가 보임. `매출 -3.2%` 같은 환각 여지 자체가 없음.

- [ ] **Step 6: lint + 테스트**

Run: `npm run lint 2>&1 | tail -3 && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: 통과, `pass 23`

- [ ] **Step 7: Commit**

```bash
git add scripts/risk-monitor.mjs scripts/lib/sheets-common.mjs
git commit -m "risk-b 판단·데이터 분리: Node가 펀더멘털 조회·주입, LLM은 판단만, 가드레일 🟡 하한 강제"
```

---

### Task 5: backfill-baselines 완전 결정론화 (LLM 제거)

**Files:**
- Modify: `scripts/backfill-baselines.mjs`

- [ ] **Step 1: buildBaselinePrompt 삭제, 페처 직결로 교체**

import 교체:
```js
import {
  loadEnv, getToken, hasServiceAccount, getRange, appendValues, ensureSheet,
  readHoldings, todayKST,
} from './lib/sheets-common.mjs';
import { fetchKrFundamentals, fetchUsFundamentals } from './lib/fundamentals.mjs';
import { krCorpCode, usTicker } from './lib/instruments.mjs';
```
`buildBaselinePrompt`·`buildRow` 함수와 `MODEL`/`modelArg` 제거. 백필 루프(104-115) 교체:

```js
  const pct = (v) => v == null ? '데이터 부족' : `${v}%`;
  let ok = 0, fail = 0;
  for (const h of targets) {
    console.log(`\n⏳ ${h.name} 기준선 조회 중...`);
    try {
      let f, ticker = '';
      if (h.market === 'KR') {
        const code = krCorpCode(h.name);
        if (!code) throw new Error(`corp_code 미해결: ${h.name}`);
        f = await fetchKrFundamentals(code); ticker = code;
      } else {
        const tk = usTicker(h.name);
        if (!tk) throw new Error(`US 티커 미등록: ${h.name}`);
        f = fetchUsFundamentals(tk); ticker = tk;
      }
      await appendValues(token, `${BASELINE_SHEET}!A2`, [[
        h.name, ticker, h.market, todayKST(),
        pct(f.grossMargin), pct(f.opMargin), pct(f.roe), pct(f.debtRatio),
        f.eps ?? '데이터 부족', f.source,
      ]]);
      console.log(`   ✅ 적재: 매총이 ${pct(f.grossMargin)} · 영익률 ${pct(f.opMargin)} · ROE ${pct(f.roe)} · 부채 ${pct(f.debtRatio)}`);
      ok++;
    } catch (e) {
      console.error(`   ❌ 실패: ${e.message}`);
      fail++;
    }
  }
```
헤더 주석의 "헤드리스 claude -p 로 조회" 문구도 "OpenDart/yfinance 직접 조회(결정론)"로 갱신. `--model` 옵션 설명 제거.

- [ ] **Step 2: dry-run 확인**

Run: `node scripts/backfill-baselines.mjs --dry-run 2>&1 | tail -15`
Expected: 대상 목록 출력, 적재 없음, 에러 없음.

- [ ] **Step 3: lint + 테스트**

Run: `npm run lint 2>&1 | tail -3 && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: 통과.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-baselines.mjs
git commit -m "기준선 백필 결정론화: 헤드리스 LLM 제거, OpenDart/yfinance 직접 조회"
```

---

### Task 6: 엔드투엔드 검증 + 오염 데이터 교체 (사용자 확인 후)

**Files:** 없음 (실행·검증만)

- [ ] **Step 1: 빌드·전체 테스트 최종 확인**

Run: `npm run lint 2>&1 | tail -3 && npm run build 2>&1 | grep -E "built in|error|Error" | tail -3 && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: 모두 통과.

- [ ] **Step 2: ⚠️ 사용자 확인 후 — 기준선 재생성 (시트 쓰기)**

기존 기준선은 LLM 생성이라 오염 가능성 → 결정론 값으로 전량 교체.
Run: `node scripts/backfill-baselines.mjs --force`
Expected: 9종목 전부 `✅ 적재`, 값에 소스 라벨 포함.

- [ ] **Step 3: ⚠️ 사용자 확인 후 — risk-b 실측 1회 실행 (시트 쓰기 + claude 사용량)**

Run: `node scripts/risk-monitor.mjs --mode=B --no-push 2>&1 | tail -25`
Expected: 삼성바이오로직스 🟢 (매출 +25.8% 주입 기반). 시트 근거데이터 열에 Node 계산 JSON. 잘못된 6/8 🟡 행은 pruneRiskSheet가 최신 행으로 자동 교체.

- [ ] **Step 4: 배포 여부 결정**

이 변경은 전부 scripts/ (앱 번들 무관)라 GitHub Pages 배포 영향 없음 — push는 사용자 확인 후.
