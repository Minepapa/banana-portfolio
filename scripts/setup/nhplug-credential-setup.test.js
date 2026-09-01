import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, isSameOrigin } from './nhplug-credential-setup.mjs';

// 2026-09-01 코드리뷰 LOW 지적 — 이 서버는 테스트가 전혀 없었다("npm test 글롭에도
// 안 잡힘"). 서버 전체를 통합테스트하는 대신, 안전성에 직결되는 두 순수함수만
// import 가능하게 뽑아 테스트한다(escapeHtml=반사형 XSS 방지, isSameOrigin=CSRF
// 1차 방어선) — 서버 자체(HTTP 리스닝·크리덴셜 저장)는 로컬 1회성 인터랙티브
// 도구라 실사용 검증(오너가 실제로 폼을 채워 저장 확인)으로 이미 검증됨.

test('escapeHtml: HTML 특수문자를 전부 이스케이프(현재는 반사 경로가 없지만 향후 방어)', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('escapeHtml: null/undefined/빈 문자열은 안전하게 빈 문자열', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
});

test('isSameOrigin: Host가 127.0.0.1:8765이고 Origin이 없으면(같은 탭 직접 제출) 통과', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:8765' } }), true);
});

test('isSameOrigin: Host가 127.0.0.1:8765이고 Origin도 정확히 일치하면 통과', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:8765', origin: 'http://127.0.0.1:8765' } }), true);
});

test('[막아야 함] isSameOrigin: Host가 다르면(DNS 리바인딩 등) 거부', () => {
  assert.equal(isSameOrigin({ headers: { host: 'evil.example.com' } }), false);
});

test('[막아야 함] isSameOrigin: Origin이 다른 사이트면(다른 탭의 악성 폼 제출) 거부', () => {
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:8765', origin: 'https://evil.example.com' } }), false);
});
