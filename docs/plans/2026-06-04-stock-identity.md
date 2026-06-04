# 종목 정체성 통일 (Stock Identity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 평가→매수→KPI 규율 추적이 깨지기 쉬운 "종목명 정확일치" 대신 종목코드 우선 + 정규화된 이름 매칭으로 동작하게 하고, 매칭 실패를 조용히 버리지 않고 화면에 노출한다.

**Architecture:** 핵심 발견 — 체결내역 D열(index 3)에는 이미 종목코드가 적재돼 있고(parse-notifications.mjs:204), 종목투자노트 C열(index 2)에도 ticker가 있다. 그런데 `computeBehaviorMetrics`는 이름(체결 F=index5 ↔ 평가 name)만으로 매칭한다. 시트 스키마 변경 없이, 매칭 로직을 "코드 둘 다 있으면 코드, 아니면 정규화 이름"으로 바꾸면 규율 루프가 즉시 단단해진다. 순수 함수는 `src/lib/stockIdentity.js`로 분리해 `node --test`로 검증한다.

**Tech Stack:** React 19 단일 SPA(src/App.jsx), Vite 8 build, Node 내장 test runner(`node --test`, 의존성 추가 없음), Google Sheets 데이터버스.

---

## File Structure

- **Create** `src/lib/stockIdentity.js` — 순수 식별 헬퍼(`canonName`, `canonCode`, `sameStock`). JSX 없음 → 테스트·번들 양쪽에서 import 가능.
- **Create** `src/lib/stockIdentity.test.js` — `node --test` 단위 테스트.
- **Modify** `src/App.jsx`
  - import 추가(파일 상단 import 구역).
  - `computeBehaviorMetrics`(542~624)의 매수 매칭(566~570)·매도 규율(585~593)을 `sameStock`로 교체.
  - `CHEOL_COLS`(211~221)의 D 라벨 `주문유형`→`종목코드`, E 라벨 `자산유형`→`자산군`으로 정정(실제 데이터와 정합).
  - KPI 행동추적 렌더(2402 부근)에 "미연결 거래" 진단 1줄 추가.

이 작업은 시트 스키마를 바꾸지 않는다. 평가요청 큐(ticker 없음)는 KPI 매칭에 쓰이지 않으므로 이번 범위 밖이다.

---

## Task 1: 순수 식별 헬퍼 + 테스트

**Files:**
- Create: `src/lib/stockIdentity.js`
- Test: `src/lib/stockIdentity.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/lib/stockIdentity.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonName, canonCode, sameStock } from './stockIdentity.js';

test('canonName: 공백/대소문자/NFC 정규화', () => {
  assert.equal(canonName(' 삼성  전자 '), '삼성 전자');
  assert.equal(canonName('Apple'), 'apple');
  assert.equal(canonName('삼성전자'), canonName('삼성전자 '));
});

test('canonName: 우선주 등 괄호는 보존(거짓 병합 방지)', () => {
  assert.notEqual(canonName('삼성전자'), canonName('삼성전자(우)'));
});

test('canonCode: trim + 대문자', () => {
  assert.equal(canonCode(' aapl '), 'AAPL');
  assert.equal(canonCode('005930'), '005930');
});

test('sameStock: 코드가 둘 다 있으면 코드로 판정(이름 달라도 일치)', () => {
  assert.equal(sameStock('005930', '삼성전자', '005930', '삼성 전자'), true);
  assert.equal(sameStock('AAPL', '애플', 'AAPL', 'Apple Inc'), true);
});

test('sameStock: 코드가 한쪽이라도 없으면 정규화 이름으로 판정', () => {
  assert.equal(sameStock('', '삼성 전자', '', '삼성전자'), true);
  assert.equal(sameStock('005930', '삼성전자', '', '삼성전자'), true);
  assert.equal(sameStock('', '애플', '', '엔비디아'), false);
});

test('sameStock: 코드 둘 다 있고 다르면 불일치(이름 같아도)', () => {
  assert.equal(sameStock('005930', '대박', '000660', '대박'), false);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test src/lib/stockIdentity.test.js`
Expected: FAIL — `Cannot find module './stockIdentity.js'`

- [ ] **Step 3: 최소 구현 작성**

`src/lib/stockIdentity.js`:
```js
// 종목 식별 정규화 — 코드 우선, 이름은 NFC·공백 정규화로 변형 흡수.
// 괄호(우선주 구분 등)는 보존: 거짓 병합(삼성전자 vs 삼성전자우)을 막기 위함.
export function canonName(name) {
  return String(name ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function canonCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

// 두 종목이 같은가? 코드가 양쪽 모두 있으면 코드로, 아니면 정규화 이름으로 판정.
export function sameStock(aCode, aName, bCode, bName) {
  const ac = canonCode(aCode), bc = canonCode(bCode);
  if (ac && bc) return ac === bc;
  return canonName(aName) === canonName(bName);
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test src/lib/stockIdentity.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**
```bash
git add src/lib/stockIdentity.js src/lib/stockIdentity.test.js
git commit -m "종목 식별 정규화 헬퍼(canonName/canonCode/sameStock) + 테스트"
```

---

## Task 2: computeBehaviorMetrics 매칭을 코드 우선으로 교체

**Files:**
- Modify: `src/App.jsx` (import 구역; `computeBehaviorMetrics` 566-570, 585-593)

체결 행 인덱스: `[0]=날짜, [1]=구분, [3]=종목코드, [5]=종목명`. 평가: `ev.stock.ticker`, `ev.stock.name`.

- [ ] **Step 1: import 추가**

App.jsx 상단 import 구역(다른 import 들 아래)에 추가:
```js
import { sameStock } from './lib/stockIdentity.js';
```

- [ ] **Step 2: 매수 매칭 교체**

App.jsx 566-570, 기존:
```js
    const bought = !isNaN(evalTs) && buys.some(r => {
      const ts = new Date(String(r.row?.[0]||'')).getTime();
      return String(r.row?.[5]||'').trim() === String(ev.stock?.name||'').trim()
        && !isNaN(ts) && ts >= evalTs && ts <= evalTs + windowMs;
    });
```
교체 후:
```js
    const bought = !isNaN(evalTs) && buys.some(r => {
      const ts = new Date(String(r.row?.[0]||'')).getTime();
      return sameStock(r.row?.[3], r.row?.[5], ev.stock?.ticker, ev.stock?.name)
        && !isNaN(ts) && ts >= evalTs && ts <= evalTs + windowMs;
    });
```

- [ ] **Step 3: 매도 규율 매칭 교체**

App.jsx 585-593, 기존:
```js
  const sellDisciplineOK = sells.filter(s => {
    const sellTs = new Date(String(s.row?.[0]||'')).getTime();
    const nm = String(s.row?.[5]||'').trim();
    if (isNaN(sellTs) || !nm) return false;
    return (evaluations || []).some(ev => {
      const evTs = new Date(ev.date).getTime();
      return String(ev.stock?.name||'').trim() === nm && !isNaN(evTs) && evTs <= sellTs && evTs >= sellTs - windowMs;
    });
  }).length;
```
교체 후:
```js
  const sellDisciplineOK = sells.filter(s => {
    const sellTs = new Date(String(s.row?.[0]||'')).getTime();
    const nm = String(s.row?.[5]||'').trim();
    if (isNaN(sellTs) || !nm) return false;
    return (evaluations || []).some(ev => {
      const evTs = new Date(ev.date).getTime();
      return sameStock(s.row?.[3], nm, ev.stock?.ticker, ev.stock?.name)
        && !isNaN(evTs) && evTs <= sellTs && evTs >= sellTs - windowMs;
    });
  }).length;
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build 2>&1 | tail -3`
Expected: 에러 없이 완료(청크 경고만 허용).

- [ ] **Step 5: 매칭 로직 회귀 점검(node -e)**

`sameStock`가 기존 이름매칭의 상위집합인지 확인 — 코드 없을 때 동작이 기존(정확일치)보다 관대해야(공백 변형 허용) 하고, 코드 있을 때만 더 엄격.
Run:
```bash
node -e "import('./src/lib/stockIdentity.js').then(m=>{const s=m.sameStock; console.log(s('','삼성 전자','','삼성전자')===true, s('005930','삼성전자','000660','삼성전자')===false, s('AAPL','애플','AAPL','Apple')===true)})"
```
Expected: `true true true`

- [ ] **Step 6: 커밋**
```bash
git add src/App.jsx
git commit -m "KPI 행동추적 매칭을 종목코드 우선(sameStock)으로 교체 — 이름 변형에 강건"
```

---

## Task 3: 체결내역 컬럼 라벨 정정(실제 데이터와 정합)

**Files:**
- Modify: `src/App.jsx` `CHEOL_COLS` (211-221)

parse-notifications.mjs:204 가 D=종목코드, E=자산군 으로 적재하는데 앱은 D=주문유형, E=자산유형 으로 라벨링 중. 체결 셀 편집 모달이 이 라벨로 표시되므로 정정한다. (같은 컬럼에 다시 쓰므로 데이터 오염은 없으나 표기가 오인됨.)

- [ ] **Step 1: 라벨 수정**

App.jsx 215-216, 기존:
```js
  { key: 'D', label: '주문유형', placeholder: '' },
  { key: 'E', label: '자산유형', placeholder: '채권 / 국내주식 / 해외주식 ...' },
```
교체 후:
```js
  { key: 'D', label: '종목코드', placeholder: '005930 / AAPL' },
  { key: 'E', label: '자산군',   placeholder: '채권 / 국내주식 / 해외주식 ...' },
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build 2>&1 | tail -3`
Expected: 에러 없이 완료.

- [ ] **Step 3: 수동 검증(체결 편집 모달)**

체결내역 탭은 로그인 필요 뷰라 시각검증 제한. 빌드 통과 + 콘솔 에러 없음 확인. 배포 후 모바일에서 체결 셀 편집 모달의 D/E 라벨이 종목코드/자산군 으로 보이는지 확인할 것(플랜 실행자는 이 한계를 정직하게 보고).

- [ ] **Step 4: 커밋**
```bash
git add src/App.jsx
git commit -m "체결내역 D/E 라벨 정정(주문유형→종목코드, 자산유형→자산군) — 적재 데이터와 정합"
```

---

## Task 4: "미연결 거래" 진단 노출

**Files:**
- Modify: `src/App.jsx` `computeBehaviorMetrics` return(607-623), KPI 행동추적 렌더(2402 부근)

조용히 버려지던 "어느 평가에도 연결 안 되는 매수"를 카운트해 화면에 띄운다(이름 오타·평가 누락을 사용자가 인지).

- [ ] **Step 1: 진단 계산 추가**

App.jsx `computeBehaviorMetrics`의 `return {` 직전(606 부근)에 추가:
```js
  // 미연결 매수: 어떤 평가와도 (코드/이름) 매칭 안 되는 매수 — 이름 오타·평가 누락 신호
  const unlinkedBuys = buys.filter(r => {
    return !(evaluations || []).some(ev =>
      sameStock(r.row?.[3], r.row?.[5], ev.stock?.ticker, ev.stock?.name));
  }).length;
```

- [ ] **Step 2: return 객체에 필드 추가**

App.jsx return 객체(607-623) 내 `recent30Buys:` 줄 다음에 추가:
```js
    unlinkedBuys,
```

- [ ] **Step 3: 렌더에 진단 줄 추가**

App.jsx 2402 부근, `{bm.missedEvals.length > 0 && (` 블록 바로 위에 추가(같은 들여쓰기):
```jsx
                    {bm.unlinkedBuys > 0 && (
                      <div style={{ fontSize: 9, color: '#5A6478', marginTop: 6 }}>
                        평가에 연결 안 된 매수 {bm.unlinkedBuys}건 — 종목명 표기 차이 또는 평가 누락 점검
                      </div>
                    )}
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build 2>&1 | tail -3`
Expected: 에러 없이 완료.

- [ ] **Step 5: 커밋 + 푸시**
```bash
git add src/App.jsx
git commit -m "KPI 행동추적에 미연결 매수 진단 추가 — 조용한 이름 불일치 가시화"
git push
```

---

## Self-Review

**Spec coverage:**
- "코드로 매칭" → Task 1(sameStock) + Task 2(매수/매도 적용). ✓
- "조용히 버리지 않고 노출" → Task 4(unlinkedBuys 진단). ✓
- "정체성 통일" → 체결 D열 코드가 이미 존재함을 활용 + 라벨 정합(Task 3). ✓
- 큐(평가요청) ticker 없음 → KPI 매칭에 불사용, 범위 밖으로 명시. ✓

**Placeholder scan:** 모든 코드 스텝에 실제 코드 포함. TBD 없음. ✓

**Type consistency:** `sameStock(aCode, aName, bCode, bName)` 시그니처가 Task1 정의와 Task2/4 호출에서 일치(체결 `row[3],row[5]`, 평가 `ticker,name`). `canonName`은 괄호 보존 — Task1 테스트가 이를 고정. ✓

**검증 한계(정직):** 체결내역/KPI 채워진 뷰는 로그인 필요라 시각검증 불가. 순수 함수는 `node --test`로 완전 검증, App 통합은 빌드+`node -e`+배포 후 모바일 확인.

---

## Execution Handoff

Plan complete. Two execution options:
1. **Subagent-Driven (recommended)** — task별 신규 서브에이전트 + 중간 리뷰.
2. **Inline Execution** — 이 세션에서 executing-plans 로 체크포인트 배치 실행.
