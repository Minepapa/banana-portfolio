import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { NIGHT_BLOCKS, judgeBlocks, renderNightCheck, replaceBlock, runNightCheck } from './media-night-check.mjs';

const now = new Date('2026-10-19T05:00:00+09:00');
function vault(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'night-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, VAULT_REL.jobHealth), { recursive: true });
  for (const { job } of NIGHT_BLOCKS) {
    const o = overrides[job] ?? {};
    writeFileSync(join(root, VAULT_REL.jobHealth, `${job}.md`),
      `---\ntype: "job-health"\njob: "${job}"\nlastRun: "${o.lastRun ?? '2026-10-18T19:30:00.000Z'}"\nstatus: "${o.status ?? 'OK'}"\ndetail: "${job} 완료"\n---\n`);
  }
  mkdirSync(join(root, VAULT_REL.mediaConversations, '2026'), { recursive: true });
  writeFileSync(join(root, VAULT_REL.mediaConversations, '2026', '2026-10-18 휘영 통화.md'), '---\n---\n본문\n');
  mkdirSync(join(root, 'board'), { recursive: true });
  const board = join(root, VAULT_REL.mineStatusBoard);
  mkdirSync(join(board, '..'), { recursive: true });
  writeFileSync(board, '---\ntype: "feature"\n---\n# 현황판\n\n## ■ 한눈에 보기\n표\n');
  return { root, board };
}

test('밤 점검: 이번 밤 정상 실행만 ✔, 실패·기록 없음은 ✖와 내일 할 일로', (t) => {
  const { root } = vault(t, { 'media-diarize': { status: 'FAIL' }, 'media-vision': { lastRun: '2026-10-17T18:00:00.000Z' } });
  const blocks = judgeBlocks(root, now);
  assert.equal(blocks.find((b) => b.job === 'media-transcribe').ok, true);
  assert.equal(blocks.find((b) => b.job === 'media-diarize').ok, false);
  assert.equal(blocks.find((b) => b.job === 'media-vision').fresh, false);
  const text = renderNightCheck(blocks, { speakerCheck: 3, untitledRecent: 1, video: { count: 10, hours: 1.2 } }, now);
  assert.match(text, /02:00 화자 분리 점검·재실행\(FAIL\)/);
  assert.match(text, /영상 말소리 전사 백필 남음 10개/);
});

test('밤 점검: 현황판 칸을 처음엔 한눈에 보기 앞에 넣고, 다음부터는 그 칸만 덮어쓴다', async (t) => {
  const { root, board } = vault(t);
  const output = { log() {} };
  const first = await runNightCheck({ root, now, output, videoDryRun: () => '대상 5, 총 0.5시간' });
  assert.equal(first.failed, 0);
  const once = readFileSync(board, 'utf8');
  assert.match(once, /## ■ 밤 점검 \(매일 05:00 자동\)[\s\S]*## ■ 한눈에 보기/);
  await runNightCheck({ root, now: new Date(now.getTime() + 86_400_000), output, videoDryRun: () => '대상 0, 총 0시간' });
  const twice = readFileSync(board, 'utf8');
  assert.equal((twice.match(/night-check:start/g) || []).length, 1);
  assert.equal(replaceBlock('x', '<!-- night-check:start -->a<!-- night-check:end -->').includes('밤 점검'), true);
});
