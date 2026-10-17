import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const jobs = {
  'clio-inbox-ingest': ["''"],
  'daily-note': ["''"],
  'weekly-vault-health-check': ["''"],
  'telegram-session-handoff': ["''"],
  'morning-briefing': ["''"],
  'themis-risk-review': ["''"],
  'rebalance-proposal': ["''"],
  'daily-asset-allocation-check': ["''"],
  'new-cash-allocation': ["''"],
};

test('fact-fed jobs forward lean tool and turn limits, then unwrap JSON result', () => {
  for (const [name, expectedTools] of Object.entries(jobs)) {
    const source = readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8');
    const calls = [...source.matchAll(/runHeadlessClaude\([\s\S]*?\}\)\)/g)].map(([call]) => call);
    assert.equal(calls.length, expectedTools.length, `${name}: call count`);
    for (const [index, call] of calls.entries()) {
      const tools = expectedTools[index];
      assert.match(call, /lean: true/, `${name}: lean`);
      assert.ok(call.includes(`maxTurns: ${tools === "'WebSearch'" ? 5 : 1}`), `${name}: turns`);
      assert.ok(call.includes(`, ${tools}, {`), `${name}: allowedTools`);
      assert.ok(call.includes(`tools: ${tools}`), `${name}: tools`);
      assert.ok(source.includes(`headlessResult(await ${call}`), `${name}: JSON result`);
      assert.doesNotMatch(call, /\bcwd:|\bmcpConfig:/, `${name}: temporary cwd and empty MCP are the preset defaults`);
    }
  }
});

const remainingCalls = {
  'annual-instrument-rescore': { count: 1, tools: "''", turns: 1 },
  'intraday-market-move-monitor': { count: 3, tools: "''", turns: 1 },
  'isa-maturity-check': { count: 1, tools: "''", turns: 1 },
  'monthly-macro-tilt-proposal': { count: 2, tools: "''", turns: 1 },
  'quarterly-allocation-review': { count: 2, tools: "''", turns: 1 },
  'media-memory-orb': { count: 1, tools: "'Read'", turns: 2 },
};

test('remaining jobs keep every Claude call on the lean preset', () => {
  for (const [name, expected] of Object.entries(remainingCalls)) {
    const source = readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8');
    const calls = source.split('runHeadlessClaude(').slice(1);
    assert.equal(calls.length, expected.count, `${name}: call count`);
    for (const call of calls) {
      const options = call.slice(0, 500);
      assert.match(options, /lean: true/, `${name}: lean`);
      assert.ok(options.includes(`tools: ${expected.tools}`), `${name}: tools`);
      assert.ok(options.includes(`maxTurns: ${expected.turns}`), `${name}: turns`);
    }
  }
});

test('media tools use the same preset with only their required tools', () => {
  for (const [name, tools, turns] of [
    ['media-recordings', "''", 1],
    ['media-memory-orb-trial', "'Read'", 2],
  ]) {
    const source = readFileSync(new URL(`../tools/${name}.mjs`, import.meta.url), 'utf8');
    const calls = source.split('runHeadlessClaude(').slice(1);
    assert.equal(calls.length, 1, `${name}: call count`);
    assert.match(calls[0].slice(0, 500), /lean: true/, `${name}: lean`);
    assert.ok(calls[0].slice(0, 500).includes(`tools: ${tools}`), `${name}: tools`);
    assert.ok(calls[0].slice(0, 500).includes(`maxTurns: ${turns}`), `${name}: turns`);
  }
});
