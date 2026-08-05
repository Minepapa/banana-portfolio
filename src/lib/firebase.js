// Firebase 앱 초기화 — Firestore 미러 읽기 + 구글 로그인 전용(v2, 구현계획서 Phase 6).
//
// 이 설정값들(apiKey 포함)은 시크릿이 아니다 — Firebase 웹 API 키는 프로젝트를
// 식별하는 값일 뿐, 실제 보안은 Firestore 보안 규칙(본인 계정만 읽기)과 Firebase
// Authentication이 담당한다. 그래서 useGoogleSheets.js의 GOOGLE_CLIENT_ID·SHEET_ID와
// 같은 방식으로 소스에 직접 적는다(퍼블릭 GitHub Pages에 올라가도 안전 — "코드 자산은
// 공개해도 안전하고 데이터는 없다"는 이 프로젝트의 기존 원칙).
//
// 이 GCP 프로젝트(project-09ff2576-46e1-4aec-a3b)는 구글시트 서비스계정이 이미 쓰던
// 프로젝트를 재사용한 것이다(2026-08-05 오너 확인 — 프로젝트 산개 방지). Firestore
// 위치는 asia-northeast3(Seoul) — 한국에서 주로 접속하므로.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyDIJMGDFzYg1hLwXrPO5e-cUBAqmRigLL4',
  authDomain: 'project-09ff2576-46e1-4aec-a3b.firebaseapp.com',
  projectId: 'project-09ff2576-46e1-4aec-a3b',
  storageBucket: 'project-09ff2576-46e1-4aec-a3b.firebasestorage.app',
  messagingSenderId: '107361333660',
  appId: '1:107361333660:web:9ec3f9cba802bc11a29859',
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
