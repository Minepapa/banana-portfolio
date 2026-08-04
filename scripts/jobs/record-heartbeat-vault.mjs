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
import { sendTelegram } from '../lib/telegram.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';

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
      await sendTelegram(`⚠️ <b>banana v2 잡 실패</b> (연속 ${failStreak}회)\njob: <code>${job}</code>\n${detail || '(detail 없음)'}`);
    } catch (e) {
      console.error('텔레그램 알림 실패(무시):', e.message);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ 하트비트 기록 실패:', e.message); process.exit(1); });
}
