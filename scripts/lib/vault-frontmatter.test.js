import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontmatter, parseFrontmatter, updateFrontmatter, yamlValue } from './vault-frontmatter.mjs';

test('yamlValue: null/undefined → "null"', () => {
  assert.equal(yamlValue(null), 'null');
  assert.equal(yamlValue(undefined), 'null');
});

test('yamlValue: 숫자·불리언은 그대로', () => {
  assert.equal(yamlValue(42), '42');
  assert.equal(yamlValue(1.5), '1.5');
  assert.equal(yamlValue(true), 'true');
});

test('yamlValue: 문자열은 따옴표로 감싸고 따옴표·역슬래시 이스케이프', () => {
  assert.equal(yamlValue('삼성전자'), '"삼성전자"');
  assert.equal(yamlValue('종"목'), '"종\\"목"');
  assert.equal(yamlValue('a\\b'), '"a\\\\b"');
});

test('buildFrontmatter → parseFrontmatter 왕복 보장', () => {
  const fields = { job: 'x', status: 'OK', durationSec: 4.2, failStreak: 0, account: null, flag: true };
  const parsed = parseFrontmatter(buildFrontmatter(fields));
  assert.deepEqual(parsed, fields);
});

test('parseFrontmatter: frontmatter 없으면 빈 객체', () => {
  assert.deepEqual(parseFrontmatter('그냥 본문'), {});
});

test('updateFrontmatter: 기존 필드에 새 필드 병합', () => {
  const original = buildFrontmatter({ status: '대기', qty: 10 });
  const updated = updateFrontmatter(original, { status: '완료', holdingsApplied: true });
  const parsed = parseFrontmatter(updated);
  assert.equal(parsed.status, '완료');
  assert.equal(parsed.qty, 10);
  assert.equal(parsed.holdingsApplied, true);
});
