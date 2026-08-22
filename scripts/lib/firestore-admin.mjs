// Firebase Admin SDK 초기화 — 공용 헬퍼(2026-08-22, sync-firestore-mirror.mjs와
// parse-notifications-to-vault.mjs 양쪽이 같은 서비스계정 키·initializeApp 호출을
// 중복 구현하지 않도록 분리). Admin SDK는 Firestore 보안규칙을 우회하므로(서버 신뢰
// 전제) 이 키 파일 하나가 사실상 전체 Firestore 쓰기 권한이다 — sa-key.json과 같은
// 관례(SA_KEY_FILE 환경변수 오버라이드 패턴, 600 권한 로컬 보관)로 취급한다.
import { existsSync, readFileSync } from 'node:fs';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const FIREBASE_ADMIN_KEY_FILE = process.env.FIREBASE_ADMIN_KEY_FILE
  || `${process.env.HOME}/.config/banana-portfolio-v2/firebase-adminsdk-key.json`;

let cachedApp = null;

// 같은 프로세스에서 여러 번 불러도 initializeApp을 한 번만 호출(Admin SDK는 같은
// 이름으로 재호출 시 예외를 던진다). 잡 하나당 프로세스 하나로 끝나는 이 코드베이스의
// 실행 모델상 캐시가 굳이 필요한 상황은 흔치 않지만, 같은 함수를 여러 곳에서 불러도
// 안전하게 만들어둔다.
export function getFirestoreAdmin(keyFile = FIREBASE_ADMIN_KEY_FILE) {
  if (!existsSync(keyFile)) {
    throw new Error(`Firebase Admin 키 파일이 없습니다: ${keyFile}`);
  }
  if (!cachedApp) {
    const serviceAccount = JSON.parse(readFileSync(keyFile, 'utf8'));
    cachedApp = initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore(cachedApp);
}
