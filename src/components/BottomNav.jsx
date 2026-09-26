import { CARD_BG, ACCENT, INK, INK_2, BORDER_HEAVY } from '../lib/theme.js';

const NAV_ITEMS = [
  { key: 'dashboard', label: '홈', icon: '⌂' },
  { key: 'assets', label: '보유자산', icon: '◧' },
  { key: 'records', label: '기록', icon: '≡' },
  { key: 'report', label: '리포트', icon: '▤' },
  { key: 'more', label: '더보기', icon: '⋯' },
];

export default function BottomNav({ tab, setTab }) {
  return (
    <nav role="tablist" aria-label="화면 전환" style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 200,
      display: 'flex', background: CARD_BG, borderTop: BORDER_HEAVY,
      paddingBottom: 'calc(6px + env(safe-area-inset-bottom, 0px))',
    }}>
      {NAV_ITEMS.map(({ key, label, icon }) => {
        const active = tab === key;
        return (
          <button key={key} type="button" role="tab" aria-selected={active} aria-label={label}
            onClick={() => setTab(key)} style={{
              flex: 1, minWidth: 0, minHeight: 54, padding: '6px 2px 4px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
              border: 0, background: 'transparent', color: active ? INK : INK_2,
              cursor: 'pointer', fontFamily: 'inherit',
            }}>
            <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1.1, color: active ? INK : INK_2 }}>{icon}</span>
            <span style={{ fontSize: 10, lineHeight: 1.3, fontWeight: active ? 800 : 600 }}>{label}</span>
            <span aria-hidden="true" style={{ width: 4, height: 4, borderRadius: '50%', background: active ? ACCENT : 'transparent' }} />
          </button>
        );
      })}
    </nav>
  );
}
