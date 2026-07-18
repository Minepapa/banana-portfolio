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
const DEPT_KEYWORDS = {
  athena: ['평가', '매수', '매도', '살까', '팔까', '익절', '손절', '리밸런싱', '리밸런스', '큐 비워', '평가 큐', '큐 드레인', '주문', '보유현황', '포트폴리오', '비중 조정', '종목 분석'],
  themis: ['위험', '리스크', '논리 훼손', '논리 유효', '유효해', '검증', '환율', '금리', 'vix', '변동성', '차단해제', '거시'],
  hermes: ['예수금', '체결', '잔고', '정합', '배당', '잡 상태', '잡상태', '파이프라인', '장부', '데이터 가져와', '시세 가져와'],
  apollo: ['리포트', 'kpi', '성향', '이번 주', '주간', '브리핑'],
};

// 동수(argmax tie) 시 우선순위 — 투자 판단 우선(zeus.md "부서 불명확 → 기본 Athena").
const PRIORITY = ['athena', 'themis', 'hermes', 'apollo'];

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

  return { delegate: true, dept, matched };
}
