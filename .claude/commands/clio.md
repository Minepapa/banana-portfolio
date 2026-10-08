---
description: 클리오(Clio) 직접 호출 — 볼트 기록·지식 질의, 성향 관찰 정리, 볼트 구조·문서 점검을 직접 받는다
---

Frank가 클리오(Clio)를 직접 호출했다(공통 헌장 §4 직접 호출 경로).

지시 내용: $ARGUMENTS

실행 규칙:
1. Agent tool로 `subagent_type: "clio"`를 **이름 없이 동기(run_in_background: false)** 스폰한다. 정의가 없으면 조용히 대체하지 말고 Frank에게 알린다.
2. 스폰 프롬프트에 지시 내용을 그대로 넣는다.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지.
