import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VAULT_REL } from '../lib/vault-paths.mjs';
import { renderAgentMessage } from '../lib/pantheon-send.mjs';
import { NIGHT_BLOCKS, buildNightMessage, judgeBlocks, renderNightCheck, replaceBlock,
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

test('밤 점검: 메시지는 제우스 헤더와 결과·남은 일의 한 줄 항목으로 표시한다', (t) => {
  const { root } = vault(t, { 'media-audio': { status: 'FAIL', detail: '[audio] 처리 0, 실패 1' } });
  const blocks = judgeBlocks(root, now);
  const body = buildNightMessage(blocks, { speakerCheck: 1, untitledRecent: 1, video: null });
  assert.match(body, /^이상 1개 — 자세한 판단은 경고 알림\n■ 결과\n\n/);
  assert.match(body, /^이상 02:00 음성 — \(FAIL\) 처리 0, 실패 1$/m);
  assert.match(body, /^정상 03:00 사진 — /m);
  assert.match(body, /\n■ 남은 일\n\n02:00 통화·녹음 전사·화자 분리 점검·재실행\(FAIL\)\n/);
  assert.match(body, /처리\(보류\)\n'\[화자 확인 필요\]'/);
  assert.doesNotMatch(body, /\|/);
});

test('밤 점검: 대괄호로 묶인 오류·보류 문구는 메시지 요약에서도 태그로 오인하지 않는다', (t) => {
  const { root } = vault(t, { 'media-audio': { detail: '[media-audio] [화자 확인 필요] 2건 [Errno 2] 재검토' } });
  const body = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null });
  assert.match(body, /^정상 02:00 음성 — \[화자 확인 필요\] 2건 \[Errno 2\] 재검토$/m);
});

test('밤 점검: 문제 문장을 앞세워 다른 태그 문장과 세미콜론으로 잇는다', (t) => {
  const { root } = vault(t, {
    'media-archive': { detail: '[media-archive] 새로 보관 0 [daily-note] 지오코딩 실패 6건 [media-moments] 새 순간 0' },
    'media-audio': { detail: '[media-audio] 처리 0 [media-diarize] 오류 발생 [media-speaker] 분리 0' },
  });
  const body = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null });
  assert.match(body, /^정상 매시 폰 파일 보관 — 지오코딩 실패 6건; 새로 보관 0; 새 순간 0$/m);
  assert.match(body, /^정상 02:00 음성 — 오류 발생; 처리 0; 분리 0$/m);
  assert.ok(body.split('\n').find((line) => line.startsWith('정상 매시 폰 파일 보관')).split(' — ')[1].length <= 60);
});

test('밤 점검: 뒤쪽 절의 실패와 FAIL도 앞세우고 긴 절은 문장 경계에서 생략한다', (t) => {
  const { root } = vault(t, { 'media-audio': {
    detail: `[media-audio] 정상 처리 123건; 실패 2건 [media-diarize] ${'긴 설명과 '.repeat(20)}; FAIL 재시도`,
  } });
  const body = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null });
  const line = body.split('\n').find((value) => value.startsWith('정상 02:00 음성'));
  assert.match(line, /실패 2건; FAIL 재시도; 정상 처리 123건/);
  assert.doesNotMatch(line, /긴 설명/);
  assert.ok(line.split(' — ')[1].length <= 60);
});

test('밤 점검: 200자 뒤 마지막 태그의 실패도 메시지에서 보존한다', (t) => {
  const { root } = vault(t, { 'media-audio': {
    detail: `[audio] ${'정상 '.repeat(55)}[media-diarize] 실패 3건`,
  } });
  const body = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null });
  assert.match(body, /^정상 02:00 음성 — 실패 3건$/m);
});

test('밤 점검: 메시지 detail의 비밀값·경로는 가리고 현황판 detail은 그대로 둔다', (t) => {
  const { root } = vault(t, { 'media-audio': {
    detail: '[media-audio] 오류 /Users/me/private/file.wav Pantheon/Mouseion/private/file.wav token=supersecret 1234567890123',
  } });
  const blocks = judgeBlocks(root, now);
  assert.match(blocks.find((b) => b.job === 'media-audio').detail, /\/Users\/me\/private/);
  const body = buildNightMessage(blocks, { speakerCheck: 0, untitledRecent: 0, video: null });
  assert.doesNotMatch(body, /\/Users\/me\/private|Pantheon|supersecret|1234567890123/);
  assert.match(body, /\[REDACTED\]/);
});

test('밤 점검: 긴 오류 문장 발췌 전 토큰과 경로를 정제한다', (t) => {
  const { root } = vault(t, { 'media-audio': {
    detail: `[audio] ${'x'.repeat(60)} token=supersecret /Users/me/private/file.wav ${'a'.repeat(25)} 오류`,
  } });
  const body = buildNightMessage(judgeBlocks(root, now), { speakerCheck: 0, untitledRecent: 0, video: null });
  const line = body.split('\n').find((value) => value.startsWith('정상 02:00 음성'));
  assert.match(line, /오류/);
  assert.doesNotMatch(line, /supersecret|\/Users\/me\/private|n=supersecret/);
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
  const options = { root, now, output: { log() {} }, videoDryRun: () => '대상 0, 총 0시간' };
  await runNightCheck({ ...options, send: async (message) => {
    calls += 1;
    assert.notEqual(readFileSync(board, 'utf8'), original);
    assert.deepEqual({ agent: message.agent, kind: message.kind, topic: message.topic },
      { agent: 'zeus', kind: '정보', topic: '밤 점검' });
    const rendered = renderAgentMessage(message);
    assert.match(rendered, /^\[제우스 Zeus\] 밤 점검\n─+\n■ 결과/m);
    assert.match(rendered, /정상 02:00 음성 — 처리 0, 실패 0/);
    assert.doesNotMatch(rendered, /&#10004;|&#10006;|✔|✖/);
  } });
  assert.equal(calls, 1);
  await assert.rejects(runNightCheck({ ...options, send: async () => { throw new Error('발송 실패'); } }), /발송 실패/);
  assert.match(readFileSync(board, 'utf8'), /night-check:start/);
});

test('밤 점검: 현황판 쓰기 실패 후에도 메시지를 보내고 종료코드 1을 반환한다', async (t) => {
  const { root } = vault(t);
  const sent = [];
  const options = { root, now, output: { log() {}, error() {} }, videoDryRun: () => '대상 0, 총 0시간',
    write: () => { throw new Error('디스크 오류'); }, send: async (message) => sent.push(message) };
  assert.equal(await main([], options), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /^현황판 쓰기 실패\n■ 결과/);
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
