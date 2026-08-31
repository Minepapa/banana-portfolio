#!/usr/bin/env node
/**
 * 자산분배 트랙(Athena) 일일 거시 전술 오버레이 점검 — v1 risk-d.mjs가 하던 "매일
 * 알아서 확인하고 필요하면 알려주는" 역할의 v2/Vault-native 대체(2026-08-14, 오너
 * 지시로 v1 무인 잡 14개 전부 중단 직후 발견한 공백).
 *
 * ⚠️ 범위 축소(2026-08-29, 오너 지적+Athena 검토) — 원래는 macro-overlay-facts.mjs
 * (거시 전술 오버레이, Faber 이평·금리차·DXY·VIX·유가)와 rebalance-facts.mjs(5/25
 * 구조적 밴드 점검)를 둘 다 매일 돌렸는데, `docs/ARCHITECTURE-V2.md`의 "리밸런싱 규칙
 * — Swedroe 5/25 룰" 절(정본)이 이미 "분기 1회 점검"을 Vanguard 60/40 연구 근거로
 * 확정해뒀음에도(더 자주 리밸런싱해도 성과 개선 없이 거래비용만 증가, 위탁은 과세
 * 계좌라 회전 최소화가 더 중요) 이 잡이 그 정본을 어기고 5/25 밴드까지 매일 점검·
 * 알림하고 있었다. 5/25 밴드 점검은 `rebalance-proposal.mjs`(분기 시작월 1~3일
 * 첫 평일 전용으로 전환)로 이관하고, 이 잡은 거시 전술 오버레이(같은 정본 문서가
 * "일 단위 폴링"으로 명시한 영역)만 남긴다 — 시장 급변에 대한 방치 위험은 이 채널이
 * 이미 매일 잡아내므로, 5/25 밴드까지 매일 검사할 필요가 없다는 게 Athena의 판단.
 *
 * 이 잡은 새 판정 로직을 만들지 않는다 — 이미 완성·검증된 CLI(macro-overlay-facts.mjs)
 * 를 그대로 하위 프로세스로 돌려 사람이 읽는 보고 모드(기본, --json 아님)의 출력을
 * 그대로 재사용한다:
 *   - macro-overlay-facts.mjs를 --json 없이 돌려야 Faber 크로스 상태 파일이 실제로
 *     갱신된다(그 파일 자체 주석 참고 — --json 조회는 의도적으로 상태를 안 건드림).
 *     이 잡이 "그날의 공식 확인"이므로 반드시 이 모드로 불러야 한다.
 *   - "[경고] ..." 마커 문자열이 있으면 사람이 볼 만한 변화가 있다는 뜻 — 그 경우에만
 *     보고 원문을 그대로 텔레그램으로 전달한다(조용하면 알림 없음, 스팸 방지).
 *
 * ⚠️ 알려진 한계 — v1 risk-b(개별종목 투자논리훼손 B신호)에 대응하는 Vault-native
 * 도구가 아직 없다. Phase 8 완료 4종(보유종목 업데이터·5/25 리밸런싱·거시오버레이·
 * ISA노출보고)엔 "논리훼손 판정"이 없었다 — risk-facts.mjs(Themis용)는 아직도 구글
 * 시트(리스크모니터·리스크기준선)를 직접 읽는데, 그 시트를 채우던 v1 risk-b.mjs를
 * 방금 껐으니 이제 정지된 데이터를 영원히 보고 있다. 이건 이 잡이 메꿀 수 있는 범위가
 * 아니다(질적 판단이 필요해 순수 Node 함수로 못 만듦) — 별도 설계 필요, 오너에게 보고.
 *
 * 사용법: node scripts/jobs/daily-asset-allocation-check.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/auth.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage, parseContextConsiderations, CONTEXT_MARKER, CONSIDERATIONS_MARKER } from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const HERE = dirname(fileURLToPath(import.meta.url));
const DEPARTMENT_LABEL = '투자전략실 Athena';

function runFacts(scriptName) {
  try {
    return execFileSync('node', [join(HERE, '..', 'tools', scriptName)], { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    // 도구 자체가 실패해도(yfinance 일시 오류 등) 다른 쪽 점검까지 막지 않는다 —
    // 실패 사실 자체를 보고에 남겨 조용히 넘어가지 않게 한다.
    return `[경고] ${scriptName} 실행 실패: ${e.message.slice(0, 300)}`;
  }
}

// 순수함수 — macro-overlay-facts.mjs 원문 보고를 텔레그램용 개조식 불릿으로(2026-08-31,
// 오너 지적으로 신설 — 예전엔 이 원문을 그대로 body에 통째로 넣어 formatDepartmentMessage
// 자유 문자열로만 보냈다). 여러 줄짜리 원문 블록 하나 = fact 1개(themis-risk-review.mjs·
// morning-briefing.mjs와 동일 관례).
export function buildAllocationCheckFacts(macroReport) {
  return [`[거시 전술 오버레이]\n${macroReport.trim()}`];
}

// 순수함수 — Athena에게 줄 프롬프트. 원문 신호는 이미 위 facts로 불릿 처리돼 먼저
// 나가므로, LLM 출력은 숫자 재나열이 아니라 판단(시급성·국면전환 여부)에 집중한다.
export function buildAllocationCheckPrompt(macroReport) {
  return `[일일 거시 전술 오버레이 경고] 아래는 오늘 시점의 검증된 사실이다(재조회·추정
금지, 이 숫자만 사용). 이 숫자는 텔레그램 메시지에 이미 불릿으로 따로 나간다 — 아래
출력에서 다시 나열하지 마라.

[거시 전술 오버레이]
${macroReport.trim()}

판단 요청:
1. 어떤 신호가 왜 경고 상태인지, 지금 자산분배 트랙(위탁·연금저축·ISA) 관점에서 얼마나
   시급한 변화인지 네(아테나) 성격대로 판단해라 — 과잉반응하지 마라, 노이즈일 가능성도
   솔직히 인정해라.
2. 이게 진짜 국면전환처럼 보이는지 일시적 변동으로 보이는지, 판단 근거를 밝혀라.

형식(반드시 정확히 이 두 마커로 응답을 나눠라, 다른 마커·JSON·마크다운 없이 순수
텍스트만):
${CONTEXT_MARKER}
1·2번 내용을 결론 문장 하나(심각도 표현 포함) + 근거 1~3문장, 합쳐서 2~4문장. 문장
사이는 줄바꿈으로 분리해라 — 한 문단에 몰아쓰지 마라.

${CONSIDERATIONS_MARKER}
오너가 지금 판단할 수 있는 선택지를 "- "로 시작하는 줄로 1~3개(예: "리밸런싱을
앞당길지 분기 정기점검까지 기다릴지", "신규현금 배분 비중을 이 신호 반영해 조정할지").`;
}

async function main() {
  const macroReport = runFacts('macro-overlay-facts.mjs'); // --json 없이 — Faber 상태 갱신 필요

  // ⚠️ 2026-08-23 — 시그널 마커를 이모지(⚠️)에서 대괄호 태그([경고])로 교체(오너 지시,
  // 텔레그램 이모지 전면 제거). macro-overlay-facts.mjs의 실제 출력 문자열도 같이
  // 바꿔뒀다 — 두 파일이 이 문자열로 묶여있으니 하나만 바꾸면 이 잡이 영원히 조용해진다.
  const hasWarning = macroReport.includes('[경고]');

  console.log(macroReport);

  if (!hasWarning) {
    console.log('✅ daily-asset-allocation-check: 이상 없음(조용함, 알림 생략)');
    return;
  }

  console.log('🔔 daily-asset-allocation-check: 알릴 변화 있음');

  const facts = buildAllocationCheckFacts(macroReport);
  const prompt = buildAllocationCheckPrompt(macroReport);

  if (DRY_RUN) {
    console.log('(드라이런 — 텔레그램 발송 없음)\n');
    console.log(prompt);
    return;
  }

  loadEnv();
  const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  // ⚠️ 코드리뷰 지적(2026-08-31, HIGH) — 예전엔 여기서 실패하면 process.exit(1)로 잡
  // 자체를 죽였는데, 이 잡은 [경고]가 있을 때만 도는 잡이라 그 경고 자체가 통째로
  // 유실된다(health-watcher는 failStreak>=2에서만 알림, 이 잡은 조용한 날엔 실행 자체가
  // "성공"으로 안 잡히니 streak가 쌓이지도 않아 이 실패가 어디서도 안 드러남). 사실
  // (facts)만이라도 발송하는 쪽이 통째로 유실보다 낫다 — morning-briefing.mjs와 동일
  // 원칙(그 파일에서 먼저 적용된 패턴).
  let context = null;
  let considerations = null;
  // AGENTS.md "claude 호출 규칙" — 새 claude 호출 잡은 호출 전 cooldownActive() 가드
  // 필수(쿨다운 중이면 skip). 이 잡은 2026-08-31에 처음 LLM을 부르게 된 잡이라 이 규칙
  // 대상 — 쿨다운 중이어도 사실만은 발송한다(위 HIGH 수정과 동일 원칙, 통째로 유실 안 함).
  if (cooldownActive()) {
    console.log('⏳ 쿨다운 중 — Athena 판단 생략, 사실만 발송');
  } else {
    try {
      const judgment = (await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt })).trim();
      console.log(judgment);
      ({ context, considerations } = parseContextConsiderations(judgment));
    } catch (e) {
      console.error(`⚠ Athena 헤드리스 판단 실패(사실만 발송): ${e.message}`);
    }
  }

  try {
    await sendTelegram(formatFactsMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '경고', facts, context, considerations }));
  } catch (e) {
    console.error('텔레그램 알림 실패:', e.message);
  }
}

// import.meta.url 가드(2026-08-31 신설) — 이 파일이 이제 buildAllocationCheckFacts·
// buildAllocationCheckPrompt(순수함수) export를 갖게 돼 daily-asset-allocation-check.test.js가
// 직접 import한다. 가드 없이 최상위에서 main()을 그냥 부르면 테스트가 이 모듈을 import하는
// 순간 macro-overlay-facts.mjs 서브프로세스 실행·실제 텔레그램 발송까지 실행돼 버린다
// (weekly-report.mjs 헤더 주석의 사고 사례와 동일 이유).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ daily-asset-allocation-check 오류:', e.message); process.exit(1); });
}
