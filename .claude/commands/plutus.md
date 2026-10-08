---
description: 플루토스(700 자산) 직접 호출 — 자산분배·돌파매매·위험 감시·장부·투자 리포트를 직접 보고받는다
---

Frank가 플루토스(Plutus)를 직접 호출했다(공통 헌장 §4 직접 호출 경로). 구 투자전략실·퀀트전략실·운영실·비서실(투자 보고)·리스크관리실(위험 감시) 업무를 맡는다.

지시 내용: $ARGUMENTS
(비어 있으면 정례 브리핑: 자산분배 갭·돌파매매 포지션·거시 위험·장부 이상 요약)

실행 규칙 (Zeus는 라우팅·숫자주입·중계만 — 숫자는 Node가 낸다):

0. **숫자 무결성 (앱 최우선 원칙 — 하드 보장)**: 요청이 특정 종목을 지목하면, 스폰 **전에** Zeus가 Bash로
   `node scripts/tools/stock-facts.mjs "<종목명>" [--market KR|US]`를 실행해 Node 결정론 factsText
   (펀더멘털·시세·보유)를 얻는다. 이 출력이 플루토스가 쓸 **유일한 숫자 출처**다. (종목 없는 순수 정성 질문이면 생략.)
1. Agent tool로 `subagent_type: "plutus"`를 **이름 없이(name 미지정) 동기(run_in_background: false)** 스폰한다.
   plutus는 frontmatter로 Bash·MCP·WebFetch가 차단돼(Read/Grep/Glob만) **숫자를 직접 못 가져온다** — 0단계 주입이 필수인 이유.
1-1. 타입 미인식(`Agent type not found`) 폴백: `general-purpose`로 스폰 + plutus.md 본문 주입. **단 general-purpose는
   도구 제한이 없어 이 경로의 무결성은 하드가 아니라 soft(프롬프트) 보장이다** — 프롬프트에 "숫자는 주입된 factsText만 사용,
   직접 fetch·추정 절대 금지"를 반드시 명시하고, 보고에 factsText 밖 수치가 있으면 신뢰하지 말 것(네이티브 스폰 복구 시 하드 보장 회복).
2. 스폰 프롬프트 구성: (a) 위 지시 내용, (b) **0단계 factsText를 "✅ Node 검증 숫자 — 재조회·수정 금지"로 주입**,
   (c) 플루토스 헌장의 성격·말투대로 보고(정본: 볼트 `90_Delphi/Agents/plutus`).
2-1. **판단 게이트**(스폰 프롬프트에 명시): 일반론 금지. 주입된 factsText의 수치로만 판단하고, **그 블록에 없는
   수치를 지어내거나 기억에서 끌어오면 실패**. factsText가 "(데이터 부족)"이면 정성 판단 + 부족 명시. 넌 조회자가 아니라 판단자다.
3. 보고가 돌아오면 **원문 그대로** Frank에게 전달한다 — 종합·재해석·요약 금지.

