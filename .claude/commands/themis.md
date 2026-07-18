---
description: 리스크관리실장 Themis 직접 호출 — 리스크 감시·검증 현황을 직접 보고받는다
---

Frank가 리스크관리실장 Themis를 직접 호출했다 (헌장 §3 직접 호출 경로).

지시 내용: $ARGUMENTS
(비어 있으면 정례 브리핑: 리스크관리실 소관 현황 자체 분석 — 리스크모니터 최근 신호(B/D), 잡상태(risk-b·risk-d), 감시 사각 자체 점검)

실행 규칙 (Zeus는 라우팅·숫자주입·중계만 — 숫자는 Node가 낸다):

0. **숫자 무결성 (앱 최우선 원칙 — 하드 보장)**: 스폰 **전에** Zeus가 Bash로 `node scripts/tools/risk-facts.mjs`를
   실행해 Node 결정론 factsText(리스크 신호·기준선·거시지표)를 얻는다. 특정 종목/유형만 필요하면 `--target "<이름>"`,
   특정 섹션만 필요하면 `--section signals|baseline|macro|jobs`. 이 출력이 Themis가 쓸 **유일한 숫자 출처**다.
1. Agent tool로 `subagent_type: "themis"`를 **이름 없이(name 미지정) 동기(run_in_background: false)** 스폰한다.
   themis는 frontmatter로 Bash·MCP·WebFetch·Write·Edit가 차단돼(Read/Grep/Glob만) **숫자를 직접 못 가져오고 쓰지도 못한다** — 0단계 주입이 필수.
1-1. 타입 미인식(`Agent type not found`) 폴백: `general-purpose`로 스폰 + themis.md 본문 주입. **general-purpose는
   도구 제한이 없으므로, 프롬프트에 "쓰기 도구(Write/Edit) 사용 금지 — 리스크실은 read-only"와 "숫자는 주입된
   factsText만 사용, 직접 fetch·추정 절대 금지"를 반드시 명시**(soft 보장 — 네이티브 스폰 복구 시 하드 보장 회복).
2. 스폰 프롬프트 구성: (a) 위 지시 내용, (b) **0단계 factsText를 "✅ Node 검증 숫자 — 재조회·수정 금지"로 주입**,
   (c) memory/themis.md 읽기, (d) 테미스의 신화적 성격대로 서술형 보고(강제 첫 문장 없음 — 성격은 themis.md 정본),
   잘 되는 것·안 되는 것 모두 숨김없이.
2-1. **판정 게이트**(스폰 프롬프트에 명시): 추상적 우려 금지. 주입된 factsText의 트리거 원문만 인용해 판정하고,
   그 블록에 없는 수치를 지어내면 실패. 못 구했으면 조회 실패로 명시 — 인용 없이 "위험할 수도"로 답하면 실패다.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지. worklog 기록은 Zeus(메인 세션)가 직접 반영.
