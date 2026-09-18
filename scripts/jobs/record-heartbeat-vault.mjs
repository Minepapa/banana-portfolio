#!/usr/bin/env node
/**
 * 잡 하트비트 기록 (v2, Vault판) — run.sh가 각 v2 잡 종료 후 호출한다.
 * v1 scripts/jobs/record-heartbeat.mjs(구글시트 "잡상태" 탭)와 같은 계약(job/status/
 * durationSec 인자, HB_DETAIL 환경변수, 연속 2회 실패부터 텔레그램 알림)이지만 State/
 * JobHealth/<job>.md 파일(1잡=1파일)에 기록한다(docs/ARCHITECTURE-V2.md "백업·장애감지" 절).
 *
 * 사용법: node scripts/jobs/record-heartbeat-vault.mjs <job> <status> <durationSec>
 *         HB_DETAIL=<로그꼬리> 환경변수로 detail 전달(선택).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJobHealthRecord, parseFrontmatter } from '../lib/job-health.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { sendTelegram, escapeHtml } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';
import { describeJob } from '../lib/job-labels.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

// 2026-08-23 — 이 알림도 job-alerts.mjs와 같은 이유로 라벨이 없었다 — 운영실(Hermes) 소관.
const DEPARTMENT_LABEL = '운영실 Hermes';

const job = process.argv[2];
const status = process.argv[3] || 'OK';
const durationSec = process.argv[4] || null;
const detail = process.env.HB_DETAIL || '';

async function main() {
  if (!job) { console.error('usage: record-heartbeat-vault <job> <status> <durationSec>'); process.exit(2); }

  mkdirSync(VAULT_PATHS.state.jobHealth, { recursive: true });
  const filepath = join(VAULT_PATHS.state.jobHealth, `${job}.md`);
  const prior = existsSync(filepath) ? parseFrontmatter(readFileSync(filepath, 'utf8')) : null;

  const { content, failStreak, shouldAlert } = buildJobHealthRecord({ job, status, detail, durationSec }, prior);
  await writeStateFile(filepath, content);
  console.log(`🫀 ${job} ${status} ${durationSec ?? '?'}s${status !== 'OK' ? ` (연속실패 ${failStreak}회)` : ''}`);

  if (shouldAlert) {
    try {
      // detail은 run.sh의 `tail -n 3 로그` 원문(코드리뷰 지적, 2026-09-18 실사고
      // 발신 지점 — 파이썬 트레이스백의 "<module>" 같은 문자열이 <b>/<code> 서식과
      // 구분 안 돼 텔레그램이 발송 자체를 거부했었음) — 반드시 이스케이프 후 삽입.
      // describeJob(job)은 job-labels.mjs의 우리 자신이 쓴 정적 상수라 안전.
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL,
        tag: '오류',
        body: `<b>잡 실패</b> (연속 ${failStreak}회)\n잡: <code>${describeJob(job)}</code>\n${detail ? escapeHtml(detail) : '(detail 없음)'}`,
      }));
    } catch (e) {
      console.error('텔레그램 알림 실패(무시):', e.message);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ 하트비트 기록 실패:', e.message); process.exit(1); });
}
