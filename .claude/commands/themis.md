---
description: 리스크관리실장 Themis 직접 호출 — 리스크 감시·검증 현황을 직접 보고받는다
---

Frank가 리스크관리실장 Themis를 직접 호출했다 (헌장 §3 직접 호출 경로).

지시 내용: $ARGUMENTS
(비어 있으면 정례 브리핑: 리스크관리실 소관 현황 자체 분석 — 리스크모니터 최근 신호(B/D), 잡상태(risk-b·risk-d), 감시 사각 자체 점검)

실행 규칙 (Zeus는 중계만):
1. Agent tool로 `subagent_type: "themis"`를 **이름 없이(name 미지정) 동기(run_in_background: false)** 스폰한다 — named 스폰 금지(응답 유실 사고 이력, 헌장 §3 호출 프로토콜).
1-1. 타입 미인식(`Agent type not found`) 시 폴백: `subagent_type: "general-purpose"`로 스폰하되, `.claude/agents/themis.md`의 본문 전체를 프롬프트 서두에 주입하고 **"쓰기 도구(Write/Edit) 사용 금지 — 리스크실은 read-only"를 반드시 명시**한다(네이티브 타입의 disallowedTools가 폴백에선 적용 안 되므로 프롬프트로 대체) — 레지스트리 상태와 무관하게 항상 동작.
2. 프롬프트에 위 지시 내용과 함께 직접 보고 모드 절차를 포함한다: memory/themis.md 읽기 → 소관 데이터 직접 조회(리스크모니터·리스크기준선·잡상태, 출처 표기) → 캐릭터 말투("근거부터 봅시다") 보고, 잘 되는 것·안 되는 것 모두 숨김없이.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지. 전달 후 worklog 기록만 덧붙인다.
