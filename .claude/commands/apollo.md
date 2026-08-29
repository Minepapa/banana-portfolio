---
description: 비서실장 Apollo 직접 호출 — 주간 현황·KPI·성향·Zeus 결정 로그를 직접 보고받는다
---

Frank가 비서실장 Apollo를 직접 호출했다 (헌장 §3 직접 호출 경로).

지시 내용: $ARGUMENTS
(비어 있으면 정례 브리핑: 비서실 소관 현황 자체 분석 — 최신 주간리포트 요지, KPI 추이, 성향관찰 대기 건, Zeus 결정 로그·거부권 이력)

실행 규칙 (Zeus는 라우팅·숫자주입·중계만 — 시트 숫자는 Node가 낸다, 로컬 파일은 Apollo가 직접 읽는다):

0. **숫자 무결성 (앱 최우선 원칙 — 하드 보장, 성향관찰만 해당)**: 스폰 **전에** Zeus가 Bash로
   `node scripts/tools/preference-facts.mjs`를 실행해 Node 결정론 factsText(성향관찰 상태·건수)를 얻는다.
   대기건만 필요하면 `--status pending`, 확정만은 `--status 확정`. **KPI(profile/kpi_baseline.md)·주간리포트
   (reports/*.md)는 로컬 파일이라 사전조회 불필요** — Apollo 자신이 스폰 후 Read로 직접 읽는다(파일 원문 = 하드 보장).
1. Agent tool로 `subagent_type: "apollo"`를 **이름 없이(name 미지정) 동기(run_in_background: false)** 스폰한다.
   apollo는 frontmatter로 Bash·MCP·WebFetch가 차단돼(Read/Grep/Glob만) 성향관찰 시트를 직접 못 가져온다 —
   그래서 0단계 주입이 필수. 로컬 파일은 Read로 여전히 직접 읽을 수 있다.
1-1. 타입 미인식(`Agent type not found`) 폴백: `general-purpose`로 스폰 + apollo.md 본문 주입. **general-purpose는
   도구 제한이 없으므로, 프롬프트에 "성향관찰 수치는 주입된 factsText만 사용, 직접 fetch·추정 절대 금지"를
   반드시 명시**(soft 보장 — KPI·리포트는 로컬 파일이라 이 경로에서도 원래부터 안전).
2. 스폰 프롬프트 구성: (a) 위 지시 내용, (b) **0단계 factsText를 "✅ Node 검증 숫자 — 재조회·수정 금지"로 주입**,
   (c) "KPI·주간리포트는 Read로 profile/kpi_baseline.md·reports/를 직접 읽으라" 안내,
   (d) 아폴론의 신화적 성격대로 서술형 보고, 처방을 먼저 밝히되(강제 첫 문장 없음 — 성격은 apollo.md 정본).
2-1. **보고 게이트**(스폰 프롬프트에 명시): 뜬구름 서사 금지. 성향관찰은 주입된 factsText 수치만, KPI·리포트는
   실제 Read한 파일 내용만 인용(출처 표기) — 조회 없이 일반적 조언만 하면 실패다.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지.
   (`memory/apollo.md` 읽기·worklog 기록은 2026-08-29 죽은 참조로 확인되어 제거됨 —
   `.claude/agents/PANTHEON.md` §4·§5 참고)
