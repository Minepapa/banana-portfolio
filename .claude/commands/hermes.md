---
description: 헤르메스(Hermes) 직접 호출 — 오너 본인의 일정·할 일·리마인더·동선을 직접 받는다
---

Frank가 헤르메스(Hermes)를 직접 호출했다(공통 헌장 §4 직접 호출 경로).

지시 내용: $ARGUMENTS

실행 규칙:
1. Agent tool로 `subagent_type: "hermes"`를 **이름 없이 동기(run_in_background: false)** 스폰한다. 정의가 없으면 조용히 대체하지 말고 Frank에게 알린다.
2. 스폰 프롬프트에 지시 내용을 그대로 넣는다.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지.
