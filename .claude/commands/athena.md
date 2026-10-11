---
description: 아테나(Athena) 직접 호출 — 딸 미네의 기록·기억(감정·핵심 기억 후보)을 직접 받는다
---

Frank가 아테나(Athena)를 직접 호출했다(공통 헌장 §4 직접 호출 경로).

지시 내용: $ARGUMENTS

실행 규칙:
1. 텔레그램 세션(`CLAUDE_TELEGRAM_SESSION=1` 또는 채널 메시지)에서도 미네("개인" 등급) 기록을 일반 등급과 같이 읽고 원문·세부를 답한다(D96). 금고 차단은 유지한다.
2. 그 밖의 요청에는 Agent tool로 `subagent_type: "athena"`를 **이름 없이 동기(run_in_background: false)** 스폰한다. 정의가 없으면 조용히 대체하지 말고 Frank에게 알린다. 지시 내용은 스폰 프롬프트에 넣는다.
3. 본 세션과 텔레그램 모두 담당 보고 원문을 Frank에게 전달한다.
