---
description: 비서실장 Apollo 직접 호출 — 주간 현황·KPI·성향·Zeus 결정 로그를 직접 보고받는다
---

Frank가 비서실장 Apollo를 직접 호출했다 (헌장 §3 직접 호출 경로).

지시 내용: $ARGUMENTS
(비어 있으면 정례 브리핑: 비서실 소관 현황 자체 분석 — 최신 주간리포트 요지, KPI 추이, 성향관찰 대기 건, Zeus 결정 로그·거부권 이력)

실행 규칙 (Zeus는 중계만):
1. Agent tool로 `subagent_type: "apollo"`를 **이름 없이(name 미지정) 동기(run_in_background: false)** 스폰한다 — named 스폰 금지(응답 유실 사고 이력, 헌장 §3 호출 프로토콜).
1-1. 타입 미인식(`Agent type not found`) 시 폴백: `subagent_type: "general-purpose"`로 스폰하되, `.claude/agents/apollo.md`의 본문 전체를 프롬프트 서두에 주입한다(헤드리스 agent-loader와 동일 메커니즘) — 레지스트리 상태와 무관하게 항상 동작.
2. 프롬프트에 위 지시 내용과 함께 직접 보고 모드 절차를 포함한다: memory/apollo.md 읽기 → 소관 데이터 직접 조회(주간리포트·성향관찰 시트, kpi_baseline.md, reports/, 출처 표기) → 캐릭터 말투("지금 하실 일은 이겁니다") 처방 먼저 보고.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지. 전달 후 worklog 기록만 덧붙인다.
