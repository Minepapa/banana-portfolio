// Firestore mirror/* 7종 문서 구독 훅 — 구글 로그인 + 실시간 읽기(구현계획서 Phase 6).
// useGoogleSheets.js와 같은 auth 상태 어휘('loading'|'signed-out'|'signed-in'|'error')를
// 재사용해 App.jsx 쪽 UI 분기 패턴을 그대로 붙일 수 있게 한다. App.jsx에 이미 배선돼
// 실제로 쓰이고 있다(위 2026-08-05 준비 단계 메모는 지나간 상태 — 지우지 않고 갱신).
//
// 읽기 전용 — 구글 시트 훅과 달리 쓰기(writeRange 등) API가 없다. v2 설계상 쓰기는
// 전부 텔레그램 승인 흐름을 거쳐 Vault에 반영되고, 이 훅은 그 결과를 미러링만 한다
// (ARCHITECTURE-V2.md "Firestore는 읽기 전용 미러" 원칙).
import { useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut as fbSignOut } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db, googleProvider } from '../lib/firebase.js';

const MIRROR_DOC_IDS = ['home', 'holdings', 'allocation', 'dividends', 'profits', 'trades', 'latestReport'];

const EMPTY_MIRRORS = Object.fromEntries(MIRROR_DOC_IDS.map((id) => [id, null]));

export function useFirestoreMirror() {
  const [authState, setAuthState] = useState('loading');
  const [sync, setSync] = useState('idle');
  const [mirrors, setMirrors] = useState(EMPTY_MIRRORS);
  const unsubscribersRef = useRef([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(
      auth,
      (user) => setAuthState(user ? 'signed-in' : 'signed-out'),
      (err) => { console.error('[useFirestoreMirror] onAuthStateChanged 실패', err); setAuthState('error'); },
    );
    return unsub;
  }, []);

  useEffect(() => {
    // 로그아웃 시 이전 구독 정리 — 다른 계정으로 재로그인해도 남의 리스너가 안 남게.
    unsubscribersRef.current.forEach((fn) => fn());
    unsubscribersRef.current = [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 로그아웃 시 이전 계정의 미러 데이터를 즉시 비움(외부 인증 상태와의 동기화)
    if (authState !== 'signed-in') { setMirrors(EMPTY_MIRRORS); return; }

    setSync('syncing');
    let pending = MIRROR_DOC_IDS.length;
    unsubscribersRef.current = MIRROR_DOC_IDS.map((id) => onSnapshot(
      doc(db, 'mirror', id),
      (snap) => {
        setMirrors((prev) => ({ ...prev, [id]: snap.exists() ? snap.data() : null }));
        if (pending > 0) { pending -= 1; if (pending === 0) setSync('synced'); }
      },
      (err) => { console.error(`[useFirestoreMirror] mirror/${id} 구독 실패`, err); setSync('error'); },
    ));

    return () => {
      unsubscribersRef.current.forEach((fn) => fn());
      unsubscribersRef.current = [];
    };
  }, [authState]);

  return {
    auth: authState,
    sync,
    mirrors,
    signIn: () => signInWithPopup(auth, googleProvider).catch((err) => {
      console.error('[useFirestoreMirror] signInWithPopup 실패', err);
      setAuthState('error');
    }),
    signOut: () => fbSignOut(auth),
  };
}
