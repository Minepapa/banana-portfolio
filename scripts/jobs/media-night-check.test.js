import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { renderAgentMessage } from '../lib/pantheon-send.mjs';
import { NIGHT_BLOCKS, buildNightMessage, judgeBlocks, renderNightCheck, replaceBlock, runFacts, lastRunLines, newConversationNotes, safeReason,
  runNightCheck, summarizeDetail, main } from './media-night-check.mjs';

const now = new Date('2026-10-19T05:00:00+09:00');
function vault(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'night-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, VAULT_REL.jobHealth), { recursive: true });
  for (const { job } of NIGHT_BLOCKS) {
    const o = overrides[job] ?? {};
    writeFileSync(join(root, VAULT_REL.jobHealth, `${job}.md`),
      `---\ntype: "job-health"\njob: "${job}"\nlastRun: "${o.lastRun ?? '2026-10-18T19:30:00.000Z'}"\nstatus: "${o.status ?? 'OK'}"\ndetail: ${JSON.stringify(o.detail ?? `${job} 완료`)}\n---\n`);
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
  const { root } = vault(t, { 'media-audio': { status: 'FAIL' }, 'media-photo': { lastRun: '2026-10-17T18:00:00.000Z' } });
  const blocks = judgeBlocks(root, now);
  assert.equal(blocks.find((b) => b.job === 'media-video').ok, true);
  assert.equal(blocks.find((b) => b.job === 'media-audio').ok, false);
  assert.equal(blocks.find((b) => b.job === 'media-photo').fresh, false);
  const text = renderNightCheck(blocks, { speakerCheck: 3, untitledRecent: 1, video: { count: 10, hours: 1.2 } }, now);
  assert.match(text, /02:00 통화·녹음 전사·화자 분리 점검·재실행\(FAIL\)/);
  assert.match(text, /영상 말소리 전사 백필 남음 10개/);
  const todo = text.slice(text.indexOf('**내일로 넘기는 일**'));
  assert.ok(todo.indexOf('점검·재실행') < todo.indexOf('처리(보류)'));
  assert.match(todo, /주제 없는 최근 통화 노트 1개 — LLM 판단 재개 뒤 처리\(보류\)/);
  assert.match(todo, /'\[화자 확인 필요\]' 통화 노트 3개 — 대화 경계 개선 뒤 다시 판정\(보류\)/);
});

test('밤 점검: detail은 앞부분과 태그별 마지막 문장을 보존하고 하트비트를 뺀다', (t) => {
  assert.equal(summarizeDetail('[daily-note] 지오코딩 실패 6건 [daily-note] 지오코딩 실패 6건 [media-moments] 새 순간 0'),
    '[daily-note] 지오코딩 실패 6건 [media-moments] 새 순간 0');
  assert.equal(summarizeDetail('[backup] 올림 397건 🫀 backup OK 648s [audio] 처리 0 [backup] 올림 599건'),
    '[audio] 처리 0 [backup] 올림 599건');
  assert.equal(summarizeDetail('[audio] 실패 [Errno 2] 파일 없음 [audio] 완료 [화자 확인 필요] 2건'),
    '[audio] 완료 [화자 확인 필요] 2건');
  assert.equal(summarizeDetail('태그 없는 결과 🫀 OK'), '태그 없는 결과');
  assert.equal(summarizeDetail('  🫀 OK  '), '-');
  assert.equal(summarizeDetail('앞부분 [media-audio] 완료 [fallback] 설명'), '앞부분 [media-audio] 완료 [fallback] 설명');
  assert.equal(summarizeDetail('경로[audio] 본문'), '경로[audio] 본문');
  assert.equal(summarizeDetail('[audio] 처리 0 [photo] 실패 1', 17), '[audio] 처리 0');
  assert.equal(summarizeDetail(`[audio] ${'긴 설명 '.repeat(35)}[photo] 실패 1`), '[photo] 실패 1');
  assert.equal(summarizeDetail(`[audio] ${'긴 설명 '.repeat(35)}`), '-');
  const { root } = vault(t, { 'media-audio': { detail: '[audio] 처리 1 🫀 audio OK [audio] 처리 0, 실패 0' } });
  assert.equal(judgeBlocks(root, now).find((b) => b.job === 'media-audio').detail, '[audio] 처리 0, 실패 0');
});

test('밤 점검: 현황판 칸을 처음엔 한눈에 보기 앞에 넣고, 다음부터는 그 칸만 덮어쓴다', async (t) => {
  const { root, board } = vault(t);
  const output = { log() {} };
  const first = await runNightCheck({ root, now, output, noSend: true, videoDryRun: () => '대상 5, 총 0.5시간' });
  assert.equal(first.failed, 0);
  const once = readFileSync(board, 'utf8');
  assert.match(once, /## ■ 밤 점검 \(매일 05:00 자동\)[\s\S]*## ■ 한눈에 보기/);
  await runNightCheck({ root, now: new Date(now.getTime() + 86_400_000), output, noSend: true,
    videoDryRun: () => '대상 0, 총 0시간' });
  const twice = readFileSync(board, 'utf8');
  assert.equal((twice.match(/night-check:start/g) || []).length, 1);
  assert.equal(replaceBlock('x', '<!-- night-check:start -->a<!-- night-check:end -->').includes('밤 점검'), true);
});

test('밤 점검: dry-run은 본문만 출력하고 쓰기·발송을 건너뛰며 no-send는 쓰기만 한다', async (t) => {
  const { root, board } = vault(t);
  const original = readFileSync(board, 'utf8');
  const logged = []; const sent = [];
  const options = { root, now, output: { log: (line) => logged.push(line) }, videoDryRun: () => '대상 0, 총 0시간',
    send: async (message) => sent.push(message) };
  const dry = await runNightCheck({ ...options, dryRun: true, write: () => assert.fail('dry-run wrote') });
  assert.equal(readFileSync(board, 'utf8'), original);
  assert.deepEqual(sent, []);
  assert.equal(logged.at(-1), dry.body);
  await runNightCheck({ ...options, noSend: true });
  assert.notEqual(readFileSync(board, 'utf8'), original);
  assert.deepEqual(sent, []);
});

test('밤 점검: 발송은 현황판 쓰기 뒤 한 번, 발송 실패는 쓰기를 유지한 채 거부한다', async (t) => {
  const { root, board } = vault(t, { 'media-audio': { detail: '[audio] 처리 0, 실패 0' } });
  const original = readFileSync(board, 'utf8');
  let calls = 0;
  const options = { root, now, output: { log() {} }, videoDryRun: () => '대상 0, 총 0시간', readLogs: () => [] };
  await runNightCheck({ ...options, send: async (message) => {
    calls += 1;
    assert.notEqual(readFileSync(board, 'utf8'), original);
    assert.deepEqual({ agent: message.agent, kind: message.kind, topic: message.topic },
      { agent: 'zeus', kind: '정보', topic: '밤 점검' });
    const rendered = renderAgentMessage(message);
    assert.match(rendered, /^\[제우스 Zeus\] 밤 점검\n─+\n전체 정상/m);
    assert.match(rendered, /■ 통화\n정상: /);
    assert.doesNotMatch(rendered, /&#10004;|&#10006;|✔|✖/);
  } });
  assert.equal(calls, 1);
  await assert.rejects(runNightCheck({ ...options, send: async () => { throw new Error('발송 실패'); } }), /발송 실패/);
  assert.match(readFileSync(board, 'utf8'), /night-check:start/);
});

test('밤 점검: 현황판 쓰기 실패 후에도 메시지를 보내고 종료코드 1을 반환한다', async (t) => {
  const { root } = vault(t);
  const sent = [];
  const options = { root, now, output: { log() {}, error() {} }, videoDryRun: () => '대상 0, 총 0시간', readLogs: () => [],
    write: () => { throw new Error('디스크 오류'); }, send: async (message) => sent.push(message) };
  assert.equal(await main([], options), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /^현황판 쓰기 실패\n전체 정상/);
});

test('밤 점검: CLI는 발송 실패와 블록 이상을 종료코드 1로 보고한다', async (t) => {
  const { root, board } = vault(t);
  const original = readFileSync(board, 'utf8');
  const sent = []; const errors = [];
  const options = { root, now, output: { log() {} }, errorOutput: { error: (line) => errors.push(line) },
    videoDryRun: () => '대상 0, 총 0시간', send: async (message) => sent.push(message) };
  assert.equal(await main(['--dry-run'], options), 0);
  assert.equal(readFileSync(board, 'utf8'), original);
  assert.equal(sent.length, 0);
  assert.equal(await main(['--no-send'], options), 0);
  assert.equal(sent.length, 0);
  assert.equal(await main([], { ...options, send: async () => { throw new Error('발송 실패'); } }), 1);
  assert.match(errors.at(-1), /발송 실패/);
  const failedVault = vault(t, { 'media-audio': { status: 'FAIL' } });
  assert.equal(await main(['--no-send'], { ...options, root: failedVault.root }), 1);
});

const runLog = (lines) => ({ 'media-audio': [], ...lines });

test('밤 점검: 분류(통화·녹음·사진·영상·노트·백업)별로 바뀐 것과 문제만, 상태 단어로 시작한다', (t) => {
  const { root } = vault(t);
  const facts = runFacts(runLog({
    'media-audio': ['[media-transcribe] 전사 6(음성없음 0), 실패 0, 노트 생성 2·갱신 0', '[media-diarize] 처리 6, 재배정 0, 노트 2, 실패 0, 건너뜀 0, 남음 0, 장치 mps'],
    'media-photo': ['[media-vision] {"selected":4,"analyzed":4,"failed":0}', '[media-faces] {"selected":2,"processed":2,"failed":0}',
      '[media-moments] 이름표 갱신 1, 건너뜀 3493, 실패 0', '  20_Records/24_Media/2026/어떤 순간.md'],
    'media-video': ['[media-video] 대상 0, 완료 0, 실패 0'],
    'media-moments': ['[daily-note] 지오코딩 실패 6건 (조회 오류 6)', '[media-moments] 새 순간 1, 갱신 2, 건너뜀 214'],
    'media-archive': ['[media-archive] 새로 보관 3, 건너뜀 2827, 실패 0; 근거 exif 1'],
    'media-audio-offsite-backup': ['[media-audio-offsite-backup] 올림 6건 2.4MB, 영구 삭제 반영 0, 건너뜀 0, 실패 0, 남음 0'],
    'vault-offsite-backup': ['백업 완료: pantheon-vault-2026-10-25.bundle.enc (25579922 bytes)'],
  }));
  const body = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 110, untitledRecent: 5, video: null },
    { facts, notes: { 통화: 2, 녹음: 0 } });
  assert.match(body, /^전체 정상 \(주의 1개\)\n/);
  for (const title of ['통화', '녹음', '사진', '영상', '노트', '백업']) assert.match(body, new RegExp(`^■ ${title}$`, 'm'));
  assert.match(body, /^정상: 새 통화 노트 2개 · 전사 6건, 화자 분리 6건\(통화·녹음 합계\)$/m);
  assert.match(body, /^보류: 주제 없는 최근 통화 노트 5개/m);
  assert.match(body, /^없음: 새 녹음 없음$/m);
  assert.match(body, /^정상: 장면 분석 4장 · 얼굴 이름표 2장$/m);
  assert.match(body, /^없음: 새 영상 없음$/m);
  assert.match(body, /^정상: 순간 노트 매시 갱신 · 사진 이름표 반영 1$/m);
  assert.match(body, /^주의: 장소 이름 못 찾음 6건 \(조회 오류 6\)$/m);
  assert.match(body, /^정상: 폰 파일 보관 완료$/m); // 24시간 수는 색인에서(runNightCheck)
  assert.match(body, /^정상: 원본 암호화 백업 6건 2\.4MB$/m);
  assert.match(body, /^정상: 볼트 암호화 백업 24\.4MB$/m);
  // '건너뜀'·파일 경로는 보내지 않는다.
  assert.doesNotMatch(body, /건너뜀|20_Records|\.md/);
});

test('밤 점검: 실패한 작업은 그 분류에 실패 줄과 가린 원인을 보인다', (t) => {
  const { root } = vault(t, { 'media-audio-offsite-backup': { status: 'FAIL',
    detail: 'fetch failed token=supersecret /Users/me/private/file.wav' } });
  const body = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null }, { facts: {}, notes: null });
  assert.match(body, /^확인 필요 1개 — 자세한 판단은 경고 알림\n/);
  assert.match(body, /^실패: 원본 암호화 백업 실패 \(FAIL\) — fetch failed/m);
  assert.doesNotMatch(body, /supersecret|\/Users\/me\/private/);
});

test('밤 점검: 마지막 실행 로그는 하트비트 줄 사이만 읽는다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'night-logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'media-archive.log'), '이전 회차\n🫀 media-archive OK 1s\n이번 회차 1\n이번 회차 2\n🫀 media-archive OK 2s\n');
  assert.deepEqual(lastRunLines('media-archive', dir), ['이번 회차 1', '이번 회차 2']);
  assert.deepEqual(lastRunLines('없는-잡', dir), []);
});

test('밤 점검: 새 대화 노트는 최근 24시간에 만들어진 것을 통화·녹음으로 나눠 센다', (t) => {
  const { root } = vault(t);
  const base = join(root, VAULT_REL.mediaConversations, '2026');
  const recent = new Date(now.getTime() - 5 * 3600_000).toISOString();
  writeFileSync(join(base, 'a.md'), `---\nconvKind: "통화"\noccurred: "${recent}"\n---\n`);
  writeFileSync(join(base, 'b.md'), `---\nconvKind: "녹음"\noccurred: "${recent}"\n---\n`);
  writeFileSync(join(base, 'rewritten.md'), '---\nconvKind: "통화"\noccurred: "2026-01-02T13:42:45+09:00"\n---\n');
  writeFileSync(join(base, 'old.md'), `---\nconvKind: "통화"\noccurred: "${recent}"\n---\n`);
  const born = (path) => (path.endsWith('old.md') ? now.getTime() - 3 * 86_400_000 : now.getTime() - 3600_000);
  assert.deepEqual(newConversationNotes(root, now, { bornAt: born }), { 통화: 1, 녹음: 1 });
});

test('밤 점검: 실패 원인에 경로·파일 이름이 든 문장은 보내지 않는다', () => {
  // 경로 없이 이름만 온 경우(리뷰 재현 입력): 이름 앞의 장소·사람 이름도 남기지 않는다.
  for (const [input, expected] of [
    ['실패 1: 2026-10-24 성수동 카페 미네 생일.md 쓰기 실패', '실패 1'],
    ["open '성수동 카페.md'", '원인은 경고 알림 참고'],
    ['실패 1 「성수동 카페.md」', '실패 1'],
    ['[media-audio] 전사 실패 1건: 2026-10-24 엄마 통화.m4a.part', '전사 실패 1건'],
    ['실패 1 미네영상.mkv', '실패 1'],
    ['실패 1 미네사진.webp', '실패 1'],
  ]) assert.equal(safeReason(input), expected, input);
  assert.equal(safeReason('올림 6건 25.3MB, 실패 2'), '올림 6건 25.3MB, 실패 2');
  assert.equal(safeReason('[media-photo] 오류 발생   20_Records/24_Media/2026/2026-10-24 어떤 경기장 순간.md'), '오류 발생');
  assert.equal(safeReason('백업 완료: pantheon-vault-2026-10-25.bundle.enc (25579922 bytes)'), '백업 완료');
  assert.equal(safeReason('  20_Records/24_Media/2026/a b.md'), '원인은 경고 알림 참고');
  assert.equal(safeReason('fetch failed token=supersecret'), 'fetch failed [REDACTED]');
});

test('밤 점검: 로그가 이번 실행보다 오래되면 숫자를 쓰지 않는다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'night-logs2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'media-video.log'), '🫀 a\n[media-video] 대상 1, 완료 1, 실패 0\n🫀 b\n');
  assert.deepEqual(lastRunLines('media-video', dir, { notBefore: Date.now() + 60_000 }), []);
  assert.equal(lastRunLines('media-video', dir).length, 1);
});

test('밤 점검: 아르고스 전날 점검을 한 칸으로 싣고, 이상은 주의로·기록 없음도 주의로', (t) => {
  const { root } = vault(t);
  const base = { facts: {}, notes: null };
  const ok = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null },
    { ...base, argos: { day: '2026-10-18', facts: { points: 500, stays: 3, mediaSent: 4, notifications: 2 }, issues: [] } });
  assert.match(ok, /^■ 아르고스\n정상: 이상 신호 없음 \(2026-10-18\)\n정상: 위치 500개 · 체류 3번 · 미디어 4개 · 알림 2건$/m);
  const bad = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null },
    { ...base, argos: { day: '2026-10-18', facts: { points: 1, stays: 0, mediaSent: 0, notifications: 0 }, issues: ['체류 겹침: 07:51 체류가 끝나기 전 08:06 새 체류'] } });
  assert.match(bad, /^주의: 이상 신호 1건 \(2026-10-18\)$/m);
  assert.match(bad, /^주의: 체류 겹침: 07:51/m);
  assert.match(bad, /주의 1개/);
  const none = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null },
    { ...base, argos: { day: '2026-10-18', missing: true } });
  assert.match(none, /^주의: 2026-10-18 아르고스 기록 없음/m);
});
