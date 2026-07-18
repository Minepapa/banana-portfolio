---
description: 운영실장 Hermes 직접 호출 — 장부·데이터·파이프라인 현황을 직접 보고받는다
---

Frank가 운영실장 Hermes를 직접 호출했다 (헌장 §3 직접 호출 경로).

지시 내용: $ARGUMENTS
(비어 있으면 정례 브리핑: 운영실 소관 현황 자체 분석 — 4계좌 예수금·최근 체결 반영 상태, 무인 잡 상태(잡상태 시트), 시트 정합 이상 유무)

실행 규칙 (Zeus는 라우팅·숫자주입·중계만 — 숫자는 Node가 낸다, 쓰기도 Zeus가 직접 실행):

0. **숫자 무결성 (앱 최우선 원칙 — 하드 보장)**: 스폰 **전에** Zeus가 Bash로 `node scripts/tools/ledger-facts.mjs`를
   실행해 Node 결정론 factsText(예수금·체결내역·잡상태)를 얻는다. 특정 종목 체결만 물으면 `--name "<종목명>"`,
   특정 섹션만 필요하면 `--section cash|trades|jobs`. 이 출력이 Hermes가 쓸 **유일한 숫자 출처**다.
1. Agent tool로 `subagent_type: "hermes"`를 **이름 없이(name 미지정) 동기(run_in_background: false)** 스폰한다.
   hermes는 frontmatter로 Bash·MCP·WebFetch가 차단돼(Read/Grep/Glob만) **숫자를 직접 못 가져오고 시트도 못 쓴다** — 0단계 주입이 필수.
1-1. 타입 미인식(`Agent type not found`) 폴백: `general-purpose`로 스폰 + hermes.md 본문 주입. **general-purpose는
   도구 제한이 없으므로, 프롬프트에 "숫자는 주입된 factsText만 사용, 직접 fetch·쓰기 절대 금지"를 반드시 명시**(soft 보장).
2. 스폰 프롬프트 구성: (a) 위 지시 내용, (b) **0단계 factsText를 "✅ Node 검증 숫자 — 재조회·수정 금지"로 주입**,
   (c) memory/hermes.md 읽기, (d) 헤르메스의 신화적 성격대로 표+출처 서술 보고(강제 첫 문장 없음 — 성격은 hermes.md 정본), 투자 해석 없이.
2-1. **보고 게이트**(스폰 프롬프트에 명시): 뭉뚱그린 요약 금지. 주입된 factsText의 수치만 표로 정확히 전달하고,
   그 블록에 없는 수치를 지어내면 실패. 조회 실패(0단계에서 이미 반영)는 실패로 그대로 전달 — 수치를 만들지 않는다.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지. worklog 기록은 Zeus(메인 세션)가 직접 반영(Hermes 자신은 쓰기 불가).
