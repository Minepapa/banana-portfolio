#!/usr/bin/env node
/**
 * 연금저축 잔고 리마인더 — 매월 22일 09:00, 오너에게 삼성증권 앱에서 연금저축(개인
 * 연금) 잔고를 확인해달라고 텔레그램으로 요청(2026-09-04 신설, 오너 지시).
 *
 * 배경: 이 계좌는 카카오 자동알림도 API도 없는 유일한 계좌라(scripts/lib/cash-
 * ledger.mjs 주석 참고) 수량·매수단가·예수금이 시간이 지나며 반복적으로 어긋났다
 * (2026-08-27·08-28 세 차례 실측 재기준 필요 — Knowledge/Hubs/연금저축-데이터보정.md
 * 참고). 근본원인(체결·MMF스윕·월납입 전부 알림 자체가 없음)은 코드로 해결할 수
 * 없어, 오너가 "근본원인은 더 안 찾아도 된다, 매월 22일 정도로 가볍게 리마인더만
 * 달라"고 확정(2026-09-04) — 그 결정의 실행체가 이 잡이다.
 *
 * 순수 알림만 한다(LLM 판단·데이터 조회 없음 — daily-execution-report.mjs·
 * weekly-schedule-summary.mjs와 동일하게 Node 전용, 토큰비용 0). 오너가 답장으로
 * 잔고를 알려주면 텔레그램 세션이 이미 있는 scripts/tools/record-cash-anchor.mjs로
 * 즉시 기록할 수 있다(2026-09-03 신설 — "기존 운영 스크립트 실행"이라 텔레그램 세션
 * 구현 금지 규칙에 안 걸림, CLAUDE.md 참고).
 *
 * 사용법:
 *   node scripts/jobs/pension-balance-reminder.mjs            # 실제 발송
 *   node scripts/jobs/pension-balance-reminder.mjs --dry-run  # 본문만 출력, 발송 없음
 */
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '운영실 Hermes';

// 순수함수 — 매번 같은 안내문. 데이터 조회가 없어 순수 상수에 가깝지만, 문구를 한
// 곳에서만 관리하고 테스트하기 위해 함수로 뺀다(daily-execution-report.mjs 등과
// 동일 패턴 — Node 전용 잡도 본문 조립은 항상 별도 함수).
export function buildReminderBody() {
  return [
    '연금저축(개인연금) 잔고를 확인해주세요.',
    '',
    '삼성증권 앱 "개인연금잔고" 화면에서 종목별 수량·"삼성신종종류형MMF" 평가액을',
    '확인해 답장으로 알려주시면 됩니다 — 이 계좌는 카카오 자동알림도 API도 없어',
    '수동 확인이 유일한 방법입니다(매수/매도·MMF 스윕·월 납입금 전부 알림 없음).',
  ].join('\n');
}

async function main() {
  const body = buildReminderBody();
  console.log(body);
  if (DRY_RUN) { console.log('\n(드라이런 — 텔레그램 발송 없음)'); return; }
  try {
    await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '안내', body }));
  } catch (e) { console.error('텔레그램 알림 실패:', e.message); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ pension-balance-reminder 오류:', e.message); process.exit(1); });
}
