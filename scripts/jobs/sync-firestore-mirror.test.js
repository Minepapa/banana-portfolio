import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { readVaultRecords, readLatestReport } from './sync-firestore-mirror.mjs';

test('readVaultRecords: 디렉토리가 없으면 빈 배열(Phase 8·9 이전 정상 상태)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mirror-test-')), 'does-not-exist');
  assert.deepEqual(readVaultRecords(dir), []);
});

test('readVaultRecords: .md 파일들의 frontmatter를 전부 파싱', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-test-'));
  writeFileSync(join(dir, 'a.md'), buildFrontmatter({ type: 'execution', stockName: '삼성전자' }));
  writeFileSync(join(dir, 'b.md'), buildFrontmatter({ type: 'execution', stockName: 'SK하이닉스' }));
  writeFileSync(join(dir, 'not-md.txt'), 'ignore me');
  const records = readVaultRecords(dir);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.stockName).sort(), ['SK하이닉스', '삼성전자']);
  rmSync(dir, { recursive: true, force: true });
});

// 2026-08-20: weekly-report.mjs v2가 Knowledge/Reports/{date}.md를 실제로 쓰기
// 시작하면서 latestReport 미러를 배선 — 그 전까진 디렉토리가 항상 비어 빈 값이었다.
test('readLatestReport: 디렉토리 없으면 null(리포트 아직 한 번도 발행 안 됨)', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mirror-report-')), 'does-not-exist');
  assert.equal(readLatestReport(dir), null);
});

test('readLatestReport: 파일명(YYYY-MM-DD) 기준 가장 최신 리포트를 고른다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-report-'));
  writeFileSync(join(dir, '2026-08-09.md'), buildFrontmatter({ type: 'weekly-report', date: '2026-08-09', headline: '옛날 리포트', summary: '옛 요약' }) + '\n# 옛날 본문');
  writeFileSync(join(dir, '2026-08-16.md'), buildFrontmatter({ type: 'weekly-report', date: '2026-08-16', headline: '최신 리포트', summary: '최신 요약' }) + '\n# 최신 본문\n## 섹션1\n내용');
  const report = readLatestReport(dir);
  assert.equal(report.date, '2026-08-16');
  assert.equal(report.headline, '최신 리포트');
  assert.equal(report.summary, '최신 요약');
  assert.match(report.body, /# 최신 본문/);
  assert.doesNotMatch(report.body, /옛날/);
  rmSync(dir, { recursive: true, force: true });
});

test('readLatestReport: body는 frontmatter 블록을 제외한 마크다운 본문 그대로', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-report-'));
  writeFileSync(join(dir, '2026-08-20.md'), buildFrontmatter({ type: 'weekly-report', date: '2026-08-20', headline: 'h', summary: 's' }) + '\n# 주간 자산 종합 점검 — 2026-08-20\n\n> 요약: 테스트');
  const report = readLatestReport(dir);
  assert.doesNotMatch(report.body, /^---/);
  assert.match(report.body, /^# 주간 자산 종합 점검/);
  rmSync(dir, { recursive: true, force: true });
});
