import { readFileSync } from 'node:fs';
// 부서 위임 라우팅 키워드 매처 — 순수함수(테스트: route-keywords.test.js).
// UserPromptSubmit 훅(route-guard.mjs)이 소비: "이 프롬프트가 투자 업무 위임 대상인가"를
// 결정론으로 판정한다. 완벽한 부서 선택이 목표가 아니라 "위임 여부 + 1차 추정 부서"만 책임진다 —
// 최종 라우팅·종합은 Zeus(메인 세션)의 몫(헌장 §2 복합 종합 판단).
//
// 설계 원칙:
// - 도메인 행동 키워드만 사용한다(종목명·부서명 나열 금지) — 부서명을 키우면 이 파일들을
//   편집하는 메타 작업("athena.md 고쳐줘")에서 오발한다.
// - 단일 문자 토큰(사/팔) 금지 — 부분일치라 무관한 단어(회사·팔로우)에 걸린다.
// - 이미 슬래시 커맨드(/athena 등)로 위임 중이면 발화하지 않는다(중복 리마인드 방지).
// - 오발은 무해하다(차단 아닌 리마인드) — 애매하면 위임 쪽으로, 단 위 가드로 메타 오발만 막는다.

// 부서별 도메인 키워드. 부분일치(includes) — 한국어는 어절 경계가 모호해 표준 방식.
// 키워드 표는 헌장(볼트 90_Delphi/Agents 머리말 routingKeywords)에서 생성한 파일을 읽는다(이관 4-5, D60).
// 바꾸려면 헌장을 고치고 `node scripts/tools/build-agent-defs.mjs`를 다시 돌린다. 손으로 고치지 않는다.
const DEPT_KEYWORDS = JSON.parse(readFileSync(new URL('./route-keywords.generated.json', import.meta.url), 'utf8'));

// 동수(argmax tie) 시 우선순위 — 투자 판단 우선(zeus.md "부서 불명확 → 기본 Athena").
const PRIORITY = ['plutus', 'themis', 'athena', 'hermes', 'clio'];

// 직접 호출 파서도 같은 어휘를 사용해 옛 투자 역할의 이름 충돌을 감지한다.
export function hasInvestmentKeyword(text) {
  if (typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return DEPT_KEYWORDS.plutus.some((keyword) => lower.includes(keyword.toLowerCase()));
}

const EMPTY = Object.freeze({ delegate: false, dept: null, matched: Object.freeze([]) });

export function classifyRequest(prompt) {
  if (typeof prompt !== 'string') return EMPTY;
  const text = prompt.trim();
  if (!text) return EMPTY;
  // 이미 슬래시 커맨드로 위임 중 — 훅이 끼어들지 않는다.
  if (text.startsWith('/')) return EMPTY;

  const lower = text.toLowerCase();
  const hitsByDept = {};
  const matched = [];
  for (const dept of PRIORITY) {
    let n = 0;
    for (const kw of DEPT_KEYWORDS[dept]) {
      if (lower.includes(kw.toLowerCase())) {
        n++;
        matched.push(kw);
      }
    }
    hitsByDept[dept] = n;
  }

  const total = matched.length;
  if (total === 0) return EMPTY;

  // argmax, 동수는 PRIORITY 순서로 tie-break(PRIORITY를 순회하며 최댓값 첫 도달을 채택).
  let dept = null;
  let best = 0;
  for (const d of PRIORITY) {
    if (hitsByDept[d] > best) {
      best = hitsByDept[d];
      dept = d;
    }
  }

  // 미네·생활 키워드가 여러 개여도 투자 판단이 섞이면 자산 담당에게 먼저 보낸다.
  if (hitsByDept.plutus > 0 && ['athena', 'hermes'].includes(dept)) dept = 'plutus';

  return { delegate: true, dept, matched };
}
