// LLM 출력 검증 하네스 — 순수 함수(네트워크 없음, 테스트 llm-guard.test.js).
// 배경: 2026-07 성향관찰 환각 사고 — LLM이 O🔴(급락 매수 기회)를 "논리훼손(B)"으로 뒤집어
// 사실무근 관찰을 시트에 기록했고, 그 행이 미래 프롬프트에 재주입돼 오염이 자기강화될 뻔함.
// 원칙: "Node가 사실·수치를 검증하고 LLM은 산문/선택만"(risk-monitor 가드레일 강제🟡 패턴의 일반화).
//
// 모든 함수는 throw 하지 않는다 — THROW/DROP/COERCE/STRIP 정책은 호출부(각 잡)가 결정.
// 탐지는 화이트리스트 기반: 실존 종목명(universe)만 스캔. 완전 허구 이름은 못 잡지만
// 실제 종목 행과 충돌할 수 없고, 사고 유형(실존 종목 + 거짓 신호유형 주장)은 전부 커버.

// ── LLM 출력 계약 enum (시트 레이아웃 계약은 sheet-contracts.mjs, 이건 LLM 응답 계약) ──
export const SIGNAL_EMOJI = ['🟢', '🟡', '🔴'];
export const CONCLUSION_EMOJI = ['🟢', '🟡', '🔴', '⚪'];
export const CONFIDENCE = ['높음', '보통', '낮음'];
export const VS_PROFILE = ['일치(보강)', '신규', '상충'];

const s = (v) => String(v ?? '').trim();

// 열거값 강제 — 목록 밖 값은 fallback으로 강등하고 coerced=true. 변형 흡수를 위해
// "목록값이 입력에 포함"도 인정(예: '일치' → '일치(보강)', '신뢰도 높음' → '높음').
export function coerceEnum(value, allowed, fallback) {
  const v = s(value);
  if (allowed.includes(v)) return { value: v, coerced: false };
  const hit = allowed.find(a => v.includes(a) || a.includes(v) && v.length >= 2);
  if (hit) return { value: hit, coerced: true };
  return { value: fallback, coerced: true };
}

// 신호 이모지 추출 — '🟡 주의' 같은 변형 흡수. 여러 개면 첫 등장 순서 우선. 없으면 null.
export function extractSignal(value) {
  const v = s(value);
  let best = null, bestIdx = Infinity;
  for (const e of SIGNAL_EMOJI) {
    const i = v.indexOf(e);
    if (i >= 0 && i < bestIdx) { best = e; bestIdx = i; }
  }
  return best;
}

// text가 언급한 universe(실존 종목명 폐쇄 목록) 이름들. 길이 내림차순 매칭 + 매칭 구간
// 마스킹으로 부분문자열 충돌 방지 — "삼성전자우 매수"가 '삼성전자' 언급으로 오검출되지 않게.
export function mentionedNames(text, universe) {
  let t = s(text);
  if (!t) return [];
  const found = [];
  const sorted = [...new Set((universe || []).map(s).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    let idx = t.indexOf(name);
    if (idx < 0) continue;
    found.push(name);
    while (idx >= 0) {   // 모든 등장 구간을 마스킹해 더 짧은 이름의 재매칭 차단
      t = t.slice(0, idx) + ' '.repeat(name.length) + t.slice(idx + name.length);
      idx = t.indexOf(name);
    }
  }
  return found;
}

// text가 언급한 universe 이름 중 allowedNames(프롬프트 사실 텍스트에 실존)에 없는 것.
// LLM이 사실 텍스트에 등장하지 않은 실존 종목을 끌어다 쓴 경우를 잡는다.
export function unknownMentions(text, universe, allowedNames) {
  const allowed = new Set((allowedNames || []).map(s));
  return mentionedNames(text, universe).filter(n => !allowed.has(n));
}

// 신호유형 주장 검사 — text에 claimRe(예: /논리\s*훼손|B\s*신호/)가 있으면, text가 언급한
// 모든 universe 이름이 allowedForClaim(그 주장이 실제로 참인 종목 목록)에 있어야 한다.
// 위반 종목명 배열 반환. (사고 케이스: "논리훼손(B) 종목(SK하이닉스)" — SK하이닉스는 B🔴 없음)
export function claimViolations(text, claimRe, universe, allowedForClaim) {
  const t = s(text);
  if (!t || !claimRe.test(t)) return [];
  const allowed = new Set((allowedForClaim || []).map(s));
  return mentionedNames(t, universe).filter(n => !allowed.has(n));
}

// claimViolations를 여러 문단짜리 문서(예: 주간리포트 전문)에 그대로 쓰면 안 된다 — 원래
// filterObservations의 "짧은 관찰문 하나" 용도로 설계돼, text 전체에 claimRe가 단 한 번만
// 매치돼도 문서 전체에 언급된 모든 종목명을 위반으로 잡는다. 리포트는 "논리 훼손 없음"(부정문,
// 오히려 안전 신호)을 여러 섹션에서 반복 사용하는데, 이 한 문구 때문에 전혀 무관한 다른
// 섹션의 종목명까지 전부 위반으로 오탐된다(2026-07-26 실사고: "SK하이닉스 논리 훼손 없음"
// 한 줄 때문에 리포트 전체 15개 종목이 위반으로 잡혀 경보가 뜸 — 실제로는 위반 0건).
// 줄 단위로만 스캔하고, 줄 안의 claimRe 매치를 전부 개별 검사해 부정 표현(negRe)이 뒤따르지
// 않는 매치가 하나라도 있으면 그 줄을 "주장"으로 센다(한 줄에 "A는 훼손 없음, B는 훼손
// 발생"처럼 부정·긍정이 섞인 경우 앞쪽 부정에 뒤쪽 진짜 주장이 묻히는 걸 방지 — 코드리뷰 지적).
// 알려진 한계(둘 다 "놓치는 것"보다 "과잉 경보"가 안전한 방향이라 의도적으로 수용):
// ①종목명과 주장이 서로 다른 줄에 걸치면 못 잡는다(이 리포트의 실제 문체 — 불릿·소제목
// 단위로 종목·판정이 한 줄에 붙는 스타일 — 에서는 드문 케이스). ②그 줄이 "주장"으로
// 판정되면(위 ①) 이름 탐색은 줄 전체 대상이라, 같은 줄에서 부정문에 속한 다른 종목명도
// 함께 잡힐 수 있다(예: "A는 훼손 없음, B는 훼손 발생" → B는 정확히 잡히지만 A도 같이
// 잡힘) — 완전한 정밀도는 문장/절 단위 스코핑이 필요하나, 안전망은 "놓치는 것"보다
// "과잉 경보"가 낫다는 원칙상 지금 단계에선 과설계로 보류.
const DEFAULT_NEG_RE = /\s*(없(?:다|음|고|으며|었|는|어)|않(?:다|았|음|는)|아니(?:다|었다)?|아닌|아님)/;
export function claimViolationsInDoc(text, claimRe, universe, allowedForClaim, negRe = DEFAULT_NEG_RE) {
  // claimRe가 g 플래그를 갖고 들어오면 .test()/matchAll이 lastIndex를 공유해 호출마다
  // 결과가 달라지는 미묘한 버그가 생긴다 — 항상 이 함수 안에서 새로 정규화한다(코드리뷰 지적).
  const baseFlags = claimRe.flags.replace('g', '');
  const singleRe = new RegExp(claimRe.source, baseFlags);
  const globalRe = new RegExp(claimRe.source, baseFlags + 'g');

  const violations = new Set();
  for (const line of s(text).split('\n')) {
    let hasRealClaim = false;
    for (const m of line.matchAll(globalRe)) {
      const tail = line.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (!negRe.test(tail)) { hasRealClaim = true; break; }
    }
    if (!hasRealClaim) continue;
    for (const v of claimViolations(line, singleRe, universe, allowedForClaim)) violations.add(v);
  }
  return [...violations];
}

export function clampLen(text, max) {
  const t = s(text);
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

// ── 수치 주장 검증(2026-09-06 신설) ────────────────────────────────────────
// 사고: weekly-report.mjs의 "가장 큰 변화" 불릿(LLM 자유서술)이 같은 날 같은
// fetchMacroIndicators() 데이터를 쓰는 themis-risk-review.mjs와 다른 수치를 냈다
// (오너 신고 — Themis "KOSDAQ 5일 -5.66%" vs weekly-report "KOSDAQ -3.0%", WTI
// +9.7%는 Themis 쪽에 언급조차 없음). 프롬프트가 이미 "facts 값만 쓰고 WebSearch
// 수치는 쓰지 말 것"이라 명시했지만 LLM이 실제로 어겼다 — 프롬프트 지시만으론
// 강제가 안 된다는 게 이번 사고로 실증됐다. mentionedNames/claimViolations류와
// 동일 원칙("화이트리스트에 없으면 위반")을 퍼센트 수치에도 적용한다.
const PERCENT_RE = /[+-]?\d+(?:\.\d+)?%/g;

// text에서 퍼센트 숫자만 뽑는다(부호 보존, %는 버림). "+9.7%"→9.7, "-3.0%"→-3.
export function extractPercentages(text) {
  return [...s(text).matchAll(PERCENT_RE)].map((m) => Number(m[0].replace('%', '')));
}

// facts 객체(report-facts.mjs buildReportFacts() 결과)에서 리포트가 인용해도 되는
// 퍼센트값 전부 — 거시 5일변화(change5d)·보유종목 총수익률(totalReturnPct)·자산군
// 비중(weightPct)·체결 실현손익률(realizedPct)·계좌 수익률(returnPct)·자산군 내 종목
// 점유율(종목 평가액/자산군 평가액)·직전 리포트 요약·프로필의 정책 임계값, 총 8종이다.
// 이 허용값 어디에도 없는 퍼센트가 리포트 본문에 등장하면 출처가 facts·직전 리포트·
// 프로필 정책이 아니라는 뜻(WebSearch 뉴스 수치·환각 등).
export function collectFactPercentages(facts, { profileText } = {}) {
  const nums = [];
  for (const o of Object.values(facts?.macro || {})) if (o?.change5d != null) nums.push(o.change5d);
  for (const h of facts?.holdings || []) if (h.totalReturnPct != null) nums.push(h.totalReturnPct);
  for (const a of facts?.assetClasses || []) if (a.weightPct != null) nums.push(a.weightPct);
  for (const t of facts?.weekTrades || []) if (t.realizedPct != null) nums.push(t.realizedPct);
  for (const a of facts?.accounts || []) if (a.returnPct != null) nums.push(a.returnPct);
  for (const h of facts?.holdings || []) {
    if (!Number.isFinite(h.evalValue)) continue;
    const assetClass = (facts?.assetClasses || []).find((a) => a?.type === h.type);
    if (!Number.isFinite(assetClass?.evalValue) || assetClass.evalValue === 0) continue;
    nums.push(h.evalValue / assetClass.evalValue * 100);
  }
  if (facts?.prevReport?.summary) nums.push(...extractPercentages(facts.prevReport.summary));
  if (profileText) nums.push(...extractPercentages(profileText));
  return nums;
}

// text가 언급한 퍼센트 중 factPercentages(허용된 실제 값) 어디에도 없는 것들을
// 반환(위반 목록, 빈 배열이면 전부 정합). tolerance: 반올림·표기 차이 흡수(facts는
// 소수점까지 정밀한데 LLM 서술은 반올림해 옮겨적을 수 있어 완전 일치를 요구하면
// 오탐이 남 — 기본 0.5%p).
export function numericClaimViolations(text, factPercentages, tolerance = 0.5) {
  const mentioned = extractPercentages(text);
  const allowed = (factPercentages || []).filter((n) => Number.isFinite(n));
  return mentioned.filter((n) => !allowed.some((a) => Math.abs(a - n) <= tolerance));
}

// numericClaimViolations와 같은 판정이지만, 위반 수치가 리포트의 어디에 있는지(가장
// 가까운 앞쪽 마크다운 헤딩 + 줄 번호 + 그 줄 원문)를 함께 반환한다(2026-09-20 오너
// DevRequest — "fact 근거가 없는 수치가 리포트의 어디에 있는지 위치를 표기한다").
// 기존 함수는 오너가 "원문 재확인 필요"라는 경고만 받고 리포트 전체(수천 자)를 처음부터
// 다시 훑어야 했다 — 줄 단위로 스캔하며 헤딩을 추적하는 방식이라 numericClaimViolations
// 와 같은 위반 집합을 내면서 위치 정보만 추가로 붙인다.
//
// ⚠️ 독립 코드리뷰 지적(2026-09-20, MEDIUM) — 첫 버전은 헤딩으로 인식된 줄을
// `return`으로 건너뛰어 퍼센트 스캔 자체를 안 했다. "## 리츠 16% 비중 점검"처럼
// 헤딩 자체에 위반 수치가 있으면 numericClaimViolations(전체 텍스트 스캔)는 잡는데
// 이 함수는 놓쳐, "위반 집합이 같다"는 위 설명과 실제 동작이 어긋났다 — 헤딩 갱신
// 후 같은 줄에서도 계속 퍼센트를 스캔하도록 수정(return 제거).
export function numericClaimViolationsWithLocation(text, factPercentages, tolerance = 0.5) {
  const allowed = (factPercentages || []).filter((n) => Number.isFinite(n));
  let heading = null;
  const violations = [];
  s(text).split('\n').forEach((line, idx) => {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) heading = headingMatch[2].trim();
    for (const n of extractPercentages(line)) {
      if (!allowed.some((a) => Math.abs(a - n) <= tolerance)) {
        violations.push({ value: n, line: idx + 1, heading, snippet: clampLen(line.trim(), 100) });
      }
    }
  });
  return violations;
}

// ── 성향관찰(weekly-report site 2) 검증 — 사고 지점 전용, 테스트 가능하게 분리 ──
// 정책: 위반 행은 DROP(시트에 절대 안 씀). 반환 { kept, dropped:[{obs, reason}] }.
const THESIS_CLAIM_RE = /논리\s*훼손|B\s*신호|전제\s*훼손/;
const normText = (t) => s(t).replace(/\s+/g, '');

export function filterObservations(observations, {
  universe = [],        // 실존 종목명 전체(보유+노트+리스크 대상)
  factsText = '',       // LLM에 준 결정론 사실 텍스트(signalsText) — 여기 등장한 이름만 인용 가능
  claimAllowed = [],    // "논리훼손" 주장이 실제 참인 종목(B🔴 unsoldRed 이름들)
  priorTexts = [],      // 기존 비기각 관찰 텍스트(중복 방지)
  maxRows = 3,
} = {}) {
  const kept = [], dropped = [];
  const allowedNames = mentionedNames(factsText, universe);
  const priorNorm = (priorTexts || []).map(normText).filter(Boolean);

  for (const o of observations || []) {
    const text = `${s(o?.observation)} ${s(o?.evidence)}`;
    if (!s(o?.observation)) { dropped.push({ obs: o, reason: '관찰 텍스트 없음' }); continue; }

    const unknown = unknownMentions(text, universe, allowedNames);
    if (unknown.length) {
      dropped.push({ obs: o, reason: `사실 텍스트에 없는 종목 인용: ${unknown.join(', ')}` });
      continue;
    }
    const claims = claimViolations(text, THESIS_CLAIM_RE, universe, claimAllowed);
    if (claims.length) {
      dropped.push({ obs: o, reason: `논리훼손 주장 불일치(B🔴 아님): ${claims.join(', ')}` });
      continue;
    }
    const on = normText(o.observation);
    if (priorNorm.some(p => p.includes(on) || on.includes(p))) {
      dropped.push({ obs: o, reason: '기존 관찰과 중복' });
      continue;
    }
    if (kept.length >= maxRows) { dropped.push({ obs: o, reason: `최대 ${maxRows}건 초과` }); continue; }

    // enum 강등(행 유지) — confidence/vsProfile 변형은 표준값으로 보정
    const conf = coerceEnum(o.confidence, CONFIDENCE, '보통');
    const vsp = coerceEnum(o.vsProfile, VS_PROFILE, '신규');
    kept.push({ ...o, confidence: conf.value, vsProfile: vsp.value });
    priorNorm.push(on);   // 같은 응답 내 중복도 차단
  }
  return { kept, dropped };
}
