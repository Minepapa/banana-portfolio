// 롱프레스 제스처 훅 — 편집 진입 트리거를 한 곳에서 통일.
// 컴포넌트당 1회 호출하고, 목록은 bind(id, onFire)로 행마다 핸들러를 만든다.
// 핵심 규칙:
//  - duration: 1초(1000ms)로 모든 호출부 통일. CSS .lp-progress 애니메이션(1s)과 맞춤.
//  - 스크롤 오발동 방지: touchstart에서 preventDefault 하지 않고(스크롤 허용),
//    이동거리가 moveThreshold(px)를 넘으면 타이머 취소 → 스크롤 중 편집 진입 안 됨.
//  - 시각 표시: activeId === id 인 동안 행을 하이라이트 + 진행 바를 노출(호출부에서 사용).
//  - firedRef: 롱프레스가 발화한 직후 따라오는 click을 호출부가 무시하도록 노출.
import { useState, useRef, useCallback } from "react";

export function useLongPress({ duration = 1000, moveThreshold = 10 } = {}) {
  const [activeId, setActiveId] = useState(null);
  const timerRef = useRef(null);
  const startRef = useRef(null);
  const firedRef = useRef(false);

  const point = (e) => {
    const t = e.touches?.[0] || e.changedTouches?.[0];
    return t ? { x: t.clientX, y: t.clientY } : { x: e.clientX, y: e.clientY };
  };

  const clear = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    startRef.current = null;
    setActiveId(null);
  }, []);

  const begin = useCallback((id, onFire) => (e) => {
    firedRef.current = false;
    startRef.current = point(e);
    setActiveId(id);
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      timerRef.current = null;
      setActiveId(null);
      onFire();
    }, duration);
  }, [duration]);

  const onMove = useCallback((e) => {
    if (!startRef.current || !timerRef.current) return;
    const p = point(e);
    if (Math.abs(p.x - startRef.current.x) > moveThreshold ||
        Math.abs(p.y - startRef.current.y) > moveThreshold) {
      clear();
    }
  }, [moveThreshold, clear]);

  const bind = useCallback((id, onFire) => ({
    onMouseDown: begin(id, onFire),
    onMouseMove: onMove,
    onMouseUp: clear,
    onMouseLeave: clear,
    onTouchStart: begin(id, onFire),
    onTouchMove: onMove,
    onTouchEnd: clear,
    onTouchCancel: clear,
    onContextMenu: (e) => e.preventDefault(),
  }), [begin, onMove, clear]);

  return { bind, activeId, firedRef };
}
