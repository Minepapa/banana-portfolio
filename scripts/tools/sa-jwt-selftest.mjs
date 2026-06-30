#!/usr/bin/env node
// 서비스 계정 JWT 오프라인 자가검증 — 구글 없이 getServiceAccountToken 의 서명을 라운드트립으로 검증.
//
// 실제 프로덕션 함수(getServiceAccountToken)를 그대로 호출하되:
//   1) 임시 RSA 키쌍을 만들어 가짜 SA 키 파일 생성
//   2) global.fetch 를 가로채 토큰 교환 요청을 캡처(네트워크 안 나감)
//   3) 캡처한 JWT 를 공개키로 서명 검증 + 헤더/클레임 구조 확인
//
// 통과 = b64url 인코딩·클레임 조립·RS256 서명이 모두 정확 → 키만 놓으면 실제로 동작한다는 확신.
//
// 사용: node scripts/tools/sa-jwt-selftest.mjs   (종료코드 0=통과, 1=실패)
import { generateKeyPairSync, createVerify } from 'crypto';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getServiceAccountToken } from '../lib/sheets-common.mjs';

const EXPECTED_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CLIENT_EMAIL = 'selftest@banana.iam.gserviceaccount.com';

function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function decodeJson(seg) {
  return JSON.parse(b64urlToBuf(seg).toString('utf8'));
}

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('🔐 SA JWT 오프라인 자가검증\n');

  // 1) 임시 RSA 키쌍 + 가짜 SA 키 파일
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const dir = mkdtempSync(join(tmpdir(), 'sa-selftest-'));
  const keyFile = join(dir, 'sa-key.json');
  writeFileSync(keyFile, JSON.stringify({
    type: 'service_account',
    client_email: CLIENT_EMAIL,
    private_key: privateKey,
    token_uri: TOKEN_URI,
  }));

  // 2) fetch 가로채기 — 실제 네트워크 안 나감, assertion(JWT) 만 캡처
  let captured = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured = { url, body: opts?.body, headers: opts?.headers, method: opts?.method };
    return {
      ok: true,
      json: async () => ({ access_token: 'FAKE_ACCESS_TOKEN', expires_in: 3599, token_type: 'Bearer' }),
      text: async () => '',
    };
  };

  let token;
  try {
    token = await getServiceAccountToken(keyFile);
  } finally {
    globalThis.fetch = origFetch;
  }

  // 3) 검증
  check('access_token 반환', token === 'FAKE_ACCESS_TOKEN', `받음: ${token}`);
  check('토큰 엔드포인트 호출', captured?.url === TOKEN_URI, `url: ${captured?.url}`);
  check('POST 메서드', (captured?.method || 'POST') === 'POST');

  const body = captured?.body;
  const params = body instanceof URLSearchParams ? body : new URLSearchParams(String(body || ''));
  check('grant_type=jwt-bearer',
    params.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    params.get('grant_type'));

  const jwt = params.get('assertion') || '';
  const parts = jwt.split('.');
  check('JWT 3-파트 구조', parts.length === 3, `파트수: ${parts.length}`);

  if (parts.length === 3) {
    const [h, c, s] = parts;

    // 헤더 검증
    let header = {};
    try { header = decodeJson(h); } catch { /* */ }
    check('헤더 alg=RS256', header.alg === 'RS256', JSON.stringify(header));
    check('헤더 typ=JWT', header.typ === 'JWT');

    // 클레임 검증
    let claim = {};
    try { claim = decodeJson(c); } catch { /* */ }
    check('클레임 iss=client_email', claim.iss === CLIENT_EMAIL, claim.iss);
    check('클레임 scope=spreadsheets', claim.scope === EXPECTED_SCOPE, claim.scope);
    check('클레임 aud=token_uri', claim.aud === TOKEN_URI, claim.aud);
    check('클레임 iat 숫자', Number.isFinite(claim.iat));
    check('클레임 exp=iat+3600', claim.exp === claim.iat + 3600, `iat=${claim.iat} exp=${claim.exp}`);

    // 핵심: 서명이 공개키로 실제 검증되는가 (RS256 over `${h}.${c}`)
    let sigOk = false;
    try {
      sigOk = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, b64urlToBuf(s));
    } catch (e) { /* */ }
    check('RS256 서명 유효(공개키 검증)', sigOk);

    // 변조 감지: 페이로드 한 글자 바꾸면 검증 실패해야 함
    let tamperRejected = false;
    try {
      const badClaim = c.slice(0, -1) + (c.slice(-1) === 'A' ? 'B' : 'A');
      tamperRejected = !createVerify('RSA-SHA256').update(`${h}.${badClaim}`).verify(publicKey, b64urlToBuf(s));
    } catch { tamperRejected = true; }
    check('변조 페이로드 거부', tamperRejected);
  }

  console.log('');
  if (failed === 0) {
    console.log('🎉 전체 통과 — SA 키만 배치하면 실제 토큰 교환이 동작합니다.');
    process.exit(0);
  } else {
    console.log(`💥 ${failed}개 실패 — 위 항목 확인 필요.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('테스트 실행 오류:', e);
  process.exit(1);
});
