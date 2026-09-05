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

// 2026-09-04 므네모시네 대정리에서 도입한 `related:` 노트간 링크(문자열 배열)가
// 실제로 깨졌던 버그의 회귀 가드 — 배열 지원 전에는 통짜 문자열로 파싱됐다가
// 재저장 때 `related: "[\"[[허브]]\"]"`로 이스케이프돼 Obsidian이 링크로 못 읽었다.
// weekly-report.mjs의 승격후보 TTL 갱신이 Knowledge/Profile/*.md를 updateFrontmatter로
// 재작성하기 때문에 실제로 터지는 경로였다.
test('yamlValue·parseFrontmatter: 문자열 배열 왕복 보장(related 링크 보존)', () => {
  assert.equal(yamlValue(['[[A]]', '[[B]]']), '["[[A]]", "[[B]]"]');
  assert.equal(yamlValue([]), '[]');

  const fields = { type: 'preference-observation', related: ['[[Knowledge/Hubs/500만원-1회매수-원칙]]'] };
  assert.deepEqual(parseFrontmatter(buildFrontmatter(fields)), fields);

  // 여러 번 갱신돼도 계속 배열이어야 한다(이스케이프가 누적되지 않는다).
  let content = buildFrontmatter(fields);
  for (let i = 0; i < 3; i++) content = updateFrontmatter(content, { updatedAt: `t${i}` });
  assert.deepEqual(parseFrontmatter(content).related, fields.related);
});

// [실사고 재현/막아야 함] 위 테스트가 1개짜리 배열만 왕복 검증해 놓쳤던 버그
// (2026-09-05, vault-tags.mjs 다축 태그 작업 중 발견) — 원소가 2개 이상이면 첫
// 번째를 제외한 나머지가 따옴표를 문자 그대로 포함한 채 파싱됐다(`"b"`처럼).
// parseArrayValue 정규식이 원소 사이 구분자(", ")를 소비 안 해서, 두 번째 원소부터는
// 따옴표 매치가 아니라 "따옴표 없는 원소" 관대한 폴백이 먼저 걸려 따옴표째로 삼켰던
// 것 — ⚠️ 실사용 데이터 자체는 멀쩡하다(2026-09-05 코드리뷰로 확인, 프로덕션에
// 2~3개짜리 `related:` 배열이 이미 다수 존재). 이 버그가 안 걸렸던 진짜 이유는
// "원소가 항상 1개라서"가 아니라 "`related:`가 있는 Knowledge/Log 노트를 이
// 파서로 read-modify-write하는 코드 경로가 애초에 하나도 없어서"다(updateFrontmatter·
// patchFrontmatterFileSafely 호출부 전부가 Facts/State/Decisions만 대상) — 이
// 불변식이 깨져 Knowledge 노트에 RMW 잡이 새로 붙으면 이 클래스 버그가 그 즉시
// 재현된다는 뜻이니 과소평가하지 말 것.
test('[실사고 재현/막아야 함] parseFrontmatter: 배열 원소가 2개 이상이어도 전부 따옴표 없이 파싱', () => {
  assert.deepEqual(parseFrontmatter(buildFrontmatter({ tags: ['a', 'b'] })).tags, ['a', 'b']);
  assert.deepEqual(parseFrontmatter(buildFrontmatter({ tags: ['a', 'b', 'c'] })).tags, ['a', 'b', 'c']);
  // 따옴표 없이 손으로 쓴 배열(관대한 폴백 경로)도 여러 원소면 동일하게 보장.
  assert.deepEqual(parseFrontmatter('---\ntags: [a, b, c]\n---\n').tags, ['a', 'b', 'c']);
});

test('parseFrontmatter: 대괄호로 시작하는 문자열 값은 배열로 오인하지 않는다', () => {
  // 문자열은 항상 따옴표로 감싸여 저장되므로 배열 분기에 안 걸려야 한다.
  const fields = { observation: '[중요] 500만원 초과 매수, 재검토 필요' };
  assert.deepEqual(parseFrontmatter(buildFrontmatter(fields)), fields);
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
