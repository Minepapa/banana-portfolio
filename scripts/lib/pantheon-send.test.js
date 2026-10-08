import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { AGENT_HEADERS, renderAgentMessage, sendAgentMessage, editAgentMessage } from './pantheon-send.mjs';
import { VAULT_REL, vaultAbs } from './vault-paths.mjs';

test('발송 관문은 등록된 담당·kind·판단 사실을 검증한다', async () => {
  assert.throws(() => renderAgentMessage({ agent: 'unknown', kind: '정보', body: '본문' }), /미등록 발신자/);
  assert.throws(() => renderAgentMessage({ agent: 'zeus', body: '본문' }), /kind/);
  assert.throws(() => renderAgentMessage({ agent: 'themis', kind: '판단', facts: [] }), /사실 누락/);
  await assert.rejects(sendAgentMessage({ agent: 'unknown', kind: '정보', body: '본문' }), /미등록 발신자/);
  await assert.rejects(editAgentMessage(1, { agent: 'zeus', kind: '판단' }), /사실 누락/);
});

test('정보와 판단은 담당 헤더가 첫 줄이고 본문 구조는 기존 포맷터와 같다', () => {
  const information = renderAgentMessage({ agent: 'zeus', kind: '정보', topic: '안내', body: '본문' });
  const decision = renderAgentMessage({ agent: 'themis', kind: '판단', topic: '경고', facts: ['수치 1'], context: '맥락' });
  assert.equal(information, '[제우스 Zeus] 안내\n────────────────\n본문');
  assert.equal(decision, '[테미스 Themis] 경고\n\n[사실]\n· 수치 1\n\n[맥락]\n맥락');
});

test('볼트 에이전트 헌장이 있으면 telegramLabel을 발송 관문 라벨과 대조한다', () => {
  const root = vaultAbs(VAULT_REL.agentCharters);
  if (!existsSync(root)) return;
  for (const [agent, label] of Object.entries(AGENT_HEADERS)) {
    const path = `${root}/${agent}.md`;
    assert.ok(existsSync(path), `${agent} 헌장 누락`);
    const content = readFileSync(path, 'utf8');
    const documented = content.match(/^telegramLabel:\s*"([^"]+)"/m)?.[1];
    assert.equal(documented, `[${label}]`, `${agent} telegramLabel`);
  }
});
