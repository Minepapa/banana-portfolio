---
description: 테미스(Themis) 직접 호출 — 제안·행동 검증(통과/보류/거부)과 돌파매매 사후 검증을 직접 받는다
---

Frank가 테미스(Themis)를 직접 호출했다(공통 헌장 §4 직접 호출 경로).

지시 내용: $ARGUMENTS

실행 규칙:
1. Agent tool로 `subagent_type: "themis"`를 **이름 없이 동기(run_in_background: false)** 스폰한다. 정의가 없으면 조용히 대체하지 말고 Frank에게 알린다.
2. 스폰 프롬프트에 지시 내용을 그대로 넣는다.
   검증할 제안·행동과 그 근거 숫자(Node factsText)를 함께 넣는다. 테미스는 숫자를 직접 조회하지 않는다.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지.
