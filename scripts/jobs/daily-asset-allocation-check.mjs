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
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

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

async function main() {
  const macroReport = runFacts('macro-overlay-facts.mjs'); // --json 없이 — Faber 상태 갱신 필요

  // ⚠️ 2026-08-23 — 시그널 마커를 이모지(⚠️)에서 대괄호 태그([경고])로 교체(오너 지시,
  // 텔레그램 이모지 전면 제거). macro-overlay-facts.mjs의 실제 출력 문자열도 같이
  // 바꿔뒀다 — 두 파일이 이 문자열로 묶여있으니 하나만 바꾸면 이 잡이 영원히 조용해진다.
  const noteworthy = [];
  if (macroReport.includes('[경고]')) noteworthy.push(`[거시 전술 오버레이]\n${macroReport.trim()}`);

  console.log(macroReport);

  if (!noteworthy.length) {
    console.log('✅ daily-asset-allocation-check: 이상 없음(조용함, 알림 생략)');
    return;
  }

  console.log(`🔔 daily-asset-allocation-check: 알릴 변화 ${noteworthy.length}건`);
  if (!DRY_RUN) {
    try {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL,
        tag: '경고',
        body: noteworthy.join('\n\n'),
      }));
    } catch (e) {
      console.error('텔레그램 알림 실패:', e.message);
    }
  }
}

main().catch((e) => { console.error('❌ daily-asset-allocation-check 오류:', e.message); process.exit(1); });
