---
description: 투자전략실장 Athena 직접 호출 — 평가·주문초안·리밸런싱안·보유현황 분석을 직접 보고받는다
---

Frank가 투자전략실장 Athena를 직접 호출했다 (헌장 §3 직접 호출 경로).

지시 내용: $ARGUMENTS
(비어 있으면 정례 브리핑: 투자전략실 소관 현황 자체 분석 — 평가요청 큐 상태, 최근 평가 결론 요약, 보유 포트폴리오 전략 관점 진단)

실행 규칙 (Zeus는 중계만):
1. Agent tool로 `subagent_type: "athena"`를 **이름 없이(name 미지정) 동기(run_in_background: false)** 스폰한다 — named 스폰 금지(응답 유실 사고 이력, 헌장 §3 호출 프로토콜).
1-1. 타입 미인식(`Agent type not found`) 시 폴백: `subagent_type: "general-purpose"`로 스폰하되, `.claude/agents/athena.md`의 본문 전체를 프롬프트 서두에 주입한다(헤드리스 agent-loader와 동일 메커니즘) — 레지스트리 상태와 무관하게 항상 동작.
2. 프롬프트에 위 지시 내용과 함께 직접 보고 모드 절차를 포함한다: memory/athena.md 읽기 → 소관 데이터 직접 조회(종목투자노트·평가요청·시세, 출처 표기) → 캐릭터 말투("결론부터 말씀드립니다") 보고.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지. 전달 후 worklog 기록만 덧붙인다.
