import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentMessage } from '../lib/pantheon-send.mjs';
import { checkUsdKrwBollinger, readBollingerState } from './update-macro-indicators-cache.mjs';

function series(last = 100) {
  return [...Array(249).fill(100), last];
}

function fixture({
  initial = null, closes = series(), dryRun = false, noSend = false,
  fetchImpl, readStateImpl, sendImpl,
} = {}) {
  let state = initial;
  const sent = [];
  const written = [];
  const warnings = [];
  const previews = [];
  const run = (nextCloses = closes) => checkUsdKrwBollinger({
    dryRun, noSend, now: new Date('2026-10-13T00:00:00Z'),
    fetch: fetchImpl ?? (() => ({ 'KRW=X': nextCloses })),
    readState: readStateImpl ?? (() => state),
    write: (_path, content) => { written.push(content); state = JSON.parse(content); },
    ensureDir: () => {},
    send: sendImpl ?? (async (message) => { sent.push(message); }),
    warn: (message) => warnings.push(message),
    output: { log: (message) => previews.push(message) },
    stateFile: '/private/tmp/usdkrw-bollinger-test/state.json',
  });
  return { run, sent, written, warnings, previews, get state() { return state; } };
}

test('밴드 안에서는 상태만 기록하고 알리지 않는다', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.state.breached, false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.written.length, 1);
});

test('직전 정상에서 상단 돌파가 시작되면 플루토스 4단 메시지를 한 번 보낸다', async () => {
  const f = fixture({ initial: { breached: false, direction: null, date: '2026-10-12' }, closes: series(130) });
  const result = await f.run();
  assert.equal(result.state.direction, 'upper');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].agent, 'plutus');
  assert.ok(Array.isArray(f.sent[0].decisions));
  assert.match(renderAgentMessage(f.sent[0]), /\[결론\][\s\S]*\[사실\][\s\S]*\[맥락\][\s\S]*\[의사결정\]/);
  assert.match(renderAgentMessage(f.sent[0]), /기준일 2026-10-13/);
  assert.match(f.sent[0].conclusion, /상단을 넘었습니다/);
  assert.match(f.sent[0].facts[0], /원\/달러 최근값/);
  assert.match(f.sent[0].facts[2], /최근값의 시장 날짜/);
});

test('첫 판정에서 이미 밴드 밖이면 방향별 감시 시작 문구로 한 번만 알린다', async () => {
  for (const [last, direction] of [[130, '상단'], [70, '하단']]) {
    const f = fixture({ closes: series(last) });
    await f.run();
    await f.run();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].conclusion,
      `원/달러 환율이 12개월 볼린저 ${direction} 밖에 있습니다(감시 시작 시점 기준)`);
  }
});

test('연속 돌파의 둘째 판정은 알리지 않는다', async () => {
  const f = fixture({ initial: { breached: true, direction: 'upper', date: '2026-10-12' }, closes: series(130) });
  await f.run();
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.direction, 'upper');
});

test('상단에서 하단으로 방향이 바뀌면 하단 돌파를 새로 알린다', async () => {
  const f = fixture({ initial: { breached: true, direction: 'upper', date: '2026-10-12' }, closes: series(70) });
  await f.run();
  assert.equal(f.state.direction, 'lower');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].conclusion, /하단/);
  assert.match(f.sent[0].conclusion, /내려갔습니다/);
});

test('같은 방향 이탈 뒤 복귀하고 재이탈하면 다시 알린다', async () => {
  const f = fixture({ initial: { breached: false, direction: null, date: '2026-10-12' } });
  await f.run(series(130));
  await f.run(series(100));
  await f.run(series(130));
  assert.equal(f.sent.length, 2);
  assert.equal(f.state.direction, 'upper');
});

test('발송이 실패하면 돌파 상태를 기록하지 않는다', async () => {
  const previous = { breached: false, direction: null, date: '2026-10-12' };
  const f = fixture({
    initial: previous, closes: series(130),
    sendImpl: async () => { throw new Error('발송 실패'); },
  });
  await assert.rejects(f.run(), /발송 실패/);
  assert.equal(f.state, previous);
  assert.equal(f.written.length, 0);
});

test('상태 읽기 예외를 전파하고 판정 상태를 기록하지 않는다', async () => {
  const f = fixture({
    closes: series(130),
    readStateImpl: () => { throw new Error('상태 읽기 실패'); },
  });
  await assert.rejects(f.run(), /상태 읽기 실패/);
  assert.equal(f.written.length, 0);
  assert.equal(f.sent.length, 0);
});

test('손상된 상태 파일 오류에 파일 경로와 원인을 포함한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usdkrw-bollinger-'));
  const stateFile = join(dir, 'state.json');
  try {
    writeFileSync(stateFile, '{');
    assert.throws(() => readBollingerState(stateFile), (error) => {
      assert.match(error.message, /state\.json/);
      assert.ok(error.cause instanceof SyntaxError);
      assert.ok(error.message.includes(error.cause.message));
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('조회 실패는 결측 경고를 남기고 직전 상태를 유지한다', async () => {
  const previous = { breached: true, direction: 'upper', date: '2026-10-12' };
  const f = fixture({
    initial: previous,
    fetchImpl: () => { throw new Error('환율 조회 실패'); },
  });
  assert.equal((await f.run()).status, 'missing');
  assert.equal(f.state, previous);
  assert.equal(f.written.length, 0);
  assert.match(f.warnings[0], /결측.*환율 조회 실패/);
});

test('250개 미만 결측은 경고하고 직전 상태를 덮어쓰지 않는다', async () => {
  const previous = { breached: true, direction: 'lower', date: '2026-10-12' };
  const f = fixture({ initial: previous, closes: series().slice(1) });
  const result = await f.run();
  assert.equal(result.status, 'missing');
  assert.equal(f.state, previous);
  assert.equal(f.written.length, 0);
  assert.match(f.warnings[0], /결측/);
});

test('--dry-run은 돌파 메시지를 미리 보여주고 상태를 저장하거나 발송하지 않는다', async () => {
  const f = fixture({ dryRun: true, closes: series(130) });
  await f.run();
  assert.equal(f.sent.length, 0);
  assert.equal(f.written.length, 0);
  assert.match(f.previews[0], /\[결론\]/);
});

test('--no-send는 돌파 메시지를 미리 보여주고 상태를 저장하지 않는다', async () => {
  const f = fixture({ noSend: true, closes: series(130) });
  await f.run();
  assert.equal(f.sent.length, 0);
  assert.equal(f.written.length, 0);
  assert.match(f.previews[0], /\[결론\]/);
});
