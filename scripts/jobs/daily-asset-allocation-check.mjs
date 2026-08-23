#!/usr/bin/env node
/**
 * 자산분배 트랙(Athena) 일일 리스크·리밸런싱 점검 — v1 risk-d.mjs가 하던 "매일 알아서
 * 확인하고 필요하면 알려주는" 역할의 v2/Vault-native 대체(2026-08-14, 오너 지시로
 * v1 무인 잡 14개 전부 중단 직후 발견한 공백 — Athena의 실제 판단 도구(rebalance-
 * facts.mjs·macro-overlay-facts.mjs)는 전부 Vault 직접 읽기라 v1 중단의 영향이 없지만,
 * 그 도구들을 "매일 알아서 돌려보고 필요하면 알림"까지 해주던 스케줄 자체가 v2엔
 * 하나도 없었다).
 *
 * 이 잡은 새 판정 로직을 만들지 않는다 — 이미 완성·검증된 두 CLI(rebalance-facts.mjs·
 * macro-overlay-facts.mjs)를 그대로 하위 프로세스로 돌려 사람이 읽는 보고 모드(기본,
 * --json 아님)의 출력을 그대로 재사용한다:
 *   - macro-overlay-facts.mjs를 --json 없이 돌려야 Faber 크로스 상태 파일이 실제로
 *     갱신된다(그 파일 자체 주석 참고 — --json 조회는 의도적으로 상태를 안 건드림).
 *     이 잡이 "그날의 공식 확인"이므로 반드시 이 모드로 불러야 한다.
 *   - 두 도구 다 "[경고] ..." 마커 문자열이 있으면 사람이 볼 만한 변화가 있다는 뜻 —
 *     그 경우에만 보고 원문을 그대로 텔레그램으로 전달한다(조용하면 알림 없음, 스팸 방지).
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
  const rebalanceReport = runFacts('rebalance-facts.mjs');
  const macroReport = runFacts('macro-overlay-facts.mjs'); // --json 없이 — Faber 상태 갱신 필요

  // ⚠️ 2026-08-23 — 시그널 마커를 이모지(⚠️)에서 대괄호 태그([경고])로 교체(오너 지시,
  // 텔레그램 이모지 전면 제거). rebalance-facts.mjs·macro-overlay-facts.mjs 양쪽의
  // 실제 출력 문자열도 같이 바꿔뒀다 — 세 파일이 이 문자열로 묶여있으니 하나만
  // 바꾸면 이 잡이 영원히 조용해진다.
  const noteworthy = [];
  if (rebalanceReport.includes('[경고]')) noteworthy.push(`[5/25 리밸런싱]\n${rebalanceReport.trim()}`);
  if (macroReport.includes('[경고]')) noteworthy.push(`[거시 전술 오버레이]\n${macroReport.trim()}`);

  console.log(rebalanceReport);
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
