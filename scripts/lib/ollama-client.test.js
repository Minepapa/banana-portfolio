import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OLLAMA_MODELS, assertLocalUrl, runOllama, unloadOllamaModel } from './ollama-client.mjs';

function fakeFetch(reply, calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    const { status = 200, json } = typeof reply === 'function' ? reply() : reply;
    return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json ?? {}) };
  };
}
const S = { type: 'object' };
const answer = (content, extra = {}) => ({ json: { model: OLLAMA_MODELS.text, message: { role: 'assistant', content },
  done_reason: 'stop', prompt_eval_count: 40, eval_count: 12, total_duration: 2_500_000_000, load_duration: 1_000_000_000, ...extra } });

test('JSON 답을 돌려주고, 고정값(temperature 0·seed 42)은 호출부가 덮어쓰지 못한다', async () => {
  const calls = [];
  const logs = [];
  const result = await runOllama({
    model: OLLAMA_MODELS.text, system: '규칙', prompt: '문장', schema: { type: 'object' },
    options: { temperature: 0.9, seed: 1, num_ctx: 8192 }, fetchImpl: fakeFetch(answer('{"emotion":"기쁨"}'), calls),
    usageLogger: (line) => logs.push(line),
  });
  assert.deepEqual(result.json, { emotion: '기쁨' });
  assert.deepEqual(result.usage, { promptTokens: 40, outputTokens: 12, totalMs: 2500, loadMs: 1000 });
  const [{ url, body }] = calls;
  assert.equal(url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(body.stream, false);
  assert.deepEqual(body.format, { type: 'object' });
  assert.deepEqual(body.options, { num_ctx: 8192, temperature: 0, seed: 42 });
  assert.deepEqual(body.messages, [{ role: 'system', content: '규칙' }, { role: 'user', content: '문장' }]);
  assert.match(logs[0], /^\[ollama\] exaone/);
});

test('스키마는 필수이고, 이미지는 user 메시지에 붙인다', async () => {
  const calls = [];
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', fetchImpl: fakeFetch(answer('{}'), calls) }), /JSON 스키마/);
  assert.equal(calls.length, 0);
  await runOllama({ model: OLLAMA_MODELS.vision, prompt: '사진', images: ['aGk='], schema: S, fetchImpl: fakeFetch(answer('{}'), calls) });
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: '사진', images: ['aGk='] }]);
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, images: [''], fetchImpl: fakeFetch(answer('{}')) }), /base64/);
});

test('형식 실패는 formatFailure로 표시한다: JSON 아님·빈 답·길이 상한 잘림', async () => {
  for (const reply of [answer('그냥 글'), answer('  '), answer('{"emotion":', { done_reason: 'length' })]) {
    await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, fetchImpl: fakeFetch(reply) }),
      (error) => error.formatFailure === true && !error.unavailable);
  }
});

test('연결 실패·모델 없음·과부하는 unavailable, 시간 초과·그 밖의 HTTP 오류는 그 기록만의 실패', async () => {
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, fetchImpl: fakeFetch(new TypeError('fetch failed')) }),
    (error) => error.unavailable === true && /연결 실패/.test(error.message));
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, fetchImpl: fakeFetch({ status: 404, json: { error: 'model not found' } }) }),
    (error) => error.unavailable === true && error.status === 404 && /model not found/.test(error.message));
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, fetchImpl: fakeFetch({ status: 503, json: { error: 'busy' } }) }),
    (error) => error.unavailable === true);
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, fetchImpl: fakeFetch({ status: 500, json: { error: 'image decode' } }) }),
    (error) => !error.unavailable && error.status === 500);
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, timeoutMs: 2000, fetchImpl: fakeFetch(timeout) }),
    (error) => !error.unavailable && error.timeout === true && /시간 초과\(2초\)/.test(error.message));
  const broken = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end'); } });
  await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, fetchImpl: broken }),
    (error) => error.unavailable === true && /본문 오류/.test(error.message));
  const calls = [];
  await runOllama({ model: 'm', prompt: 'p', schema: S, fetchImpl: async (url, init) => { calls.push(init); return { ok: true, status: 200, json: async () => answer('{}').json }; } });
  assert.equal(calls[0].redirect, 'error');
});

test('이 맥 밖 주소는 호출 전에 막는다', async () => {
  assert.equal(assertLocalUrl('http://[::1]:11434'), 'http://[::1]:11434');
  const calls = [];
  for (const url of ['http://localhost:11434', 'http://192.168.0.5:11434', 'https://127.0.0.1:11434', 'http://example.com', 'not a url']) {
    await assert.rejects(() => runOllama({ model: 'm', prompt: 'p', schema: S, url, fetchImpl: fakeFetch(answer('{}'), calls) }), /Ollama/);
  }
  assert.equal(calls.length, 0);
});

test('모델 내리기는 keep_alive 0으로 부르고, 인자가 비면 막는다', async () => {
  const calls = [];
  await unloadOllamaModel(OLLAMA_MODELS.text, { fetchImpl: fakeFetch({ json: {} }, calls) });
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:11434/api/generate', body: { model: OLLAMA_MODELS.text, keep_alive: 0 } });
  await assert.rejects(() => unloadOllamaModel(''), /모델 이름/);
  await assert.rejects(() => runOllama({ model: 'm', prompt: '' }), /프롬프트/);
});
