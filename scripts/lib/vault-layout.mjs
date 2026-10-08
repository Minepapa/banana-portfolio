// 이관 2단계에서 사용할 legacy → mouseion 경로 매핑이다. 지금은 어디에도 연결하지 않는다.
// 설계 정본: 볼트 Log/Strategy/2026-10-06-경로등록부-초안.md와 설계안 v4 13장.
// 2단계 이관 전 반드시 findDestinationCollisions로 사전 검사한다. 충돌은 이관을 멈추고 해결한다.

export const MOUSEION_TOP_FOLDERS = [
  '00_Inbox',
  '01_Home',
  '10_Periodic',
  '20_Records',
  '30_Wiki',
  '40_Projects',
  '50_Outputs',
  '60_Logs',
  '80_Archive',
  '90_Delphi',
  '95_Etna',
  '99_Adyton',
];

// 첫 경로 경계 일치 규칙을 적용하므로 예외를 일반 접두 규칙보다 앞에 둔다.
export const LEGACY_TO_MOUSEION_RULES = [
  { from: '.gitignore', to: '.gitignore', note: '루트 설정 파일 유지' },
  { from: 'State/JobHealth', to: '95_Etna/Jobs/JobHealth', note: '잡 상태는 투자에서 분리' },
  { from: 'State/TelegramSession', to: '95_Etna/Jobs/TelegramSession' },
  { from: 'State/TelegramSessionHealth', to: '95_Etna/Jobs/TelegramSessionHealth' },
  { from: 'State/WikiQuestions', to: '95_Etna/Questions', note: '오너 질문 큐' },
  { from: 'State', to: '95_Etna/Investing', note: '나머지 State' },
  { from: 'Facts', to: '95_Etna/Investing', note: 'Facts/Ledger → 95_Etna/Investing/Ledger 등' },
  { from: 'Decisions/Proposals', to: '95_Etna/Investing/Orders', note: '주문 티켓' },
  { from: 'Decisions/Profile', to: '20_Records/21_Notes', yearFolder: true },
  // 아래 세 경로는 현재 VAULT_PATHS에 있다. 새 Decisions 경로는 별도 검토를 거쳐 등록한다.
  { from: 'Decisions/Evaluations', to: '95_Etna/Investing/Evaluations' },
  { from: 'Decisions/PositionJournal', to: '95_Etna/Investing/PositionJournal' },
  { from: 'Decisions/RiskMonitor', to: '95_Etna/Investing/RiskMonitor' },
  { from: 'Log/Strategy', to: '50_Outputs/Decisions' },
  { from: 'Log/Reports', to: '50_Outputs/Reports', yearFolder: true },
  { from: 'Log/Research', to: '50_Outputs/Reports', yearFolder: true },
  { from: 'Log/Sessions', to: '60_Logs/Zeus', yearFolder: true },
  { from: 'Log/TelegramSession', to: '60_Logs/Zeus/Telegram', yearFolder: true },
  { from: 'Log/WarningEvents', to: '95_Etna/Jobs/WarningEvents' },
  { from: 'Log/Implementation', to: '40_Projects/banana-portfolio/Implementation' },
  { from: 'Log/DevRequests', to: '40_Projects/banana-portfolio/Requests' },
  // 키워드 색인은 Delphi의 라이브 색인으로 계속 사용한다.
  { from: 'Knowledge/Index.md', to: '90_Delphi/index.md' },
  { from: 'Knowledge/Meta/Index.md', to: '80_Archive/Knowledge/Meta/Index.md' },
  {
    from: 'Knowledge/Meta/므네모시네-파일배선도.md',
    to: '90_Delphi/Schema/파일 배선도.md',
    note: '파일 배선도(4-7에서 경로 등록부와 분리)',
  },
  { from: 'Knowledge/Meta', to: '90_Delphi' },
  { from: 'Knowledge/Kangto/README.md', to: '20_Records/22_Literature/README.md', yearFolder: true },
  { from: 'Knowledge/Kangto/1_책/INDEX.md', to: '20_Records/22_Literature/INDEX.md', yearFolder: true },
  {
    from: 'Knowledge/Kangto/1_책/손실은짧게수익은길게_Ch4_전사.md',
    to: '20_Records/22_Literature/손실은짧게수익은길게_Ch4_전사.md',
    yearFolder: true,
  },
  { from: 'Knowledge/Kangto', action: 'delete', reason: '원문 코퍼스는 이관하지 않음' },
  { from: 'Knowledge/Topics', to: '30_Wiki/34_Topics' },
  { from: 'Knowledge/Playbook/README.md', to: '30_Wiki/34_Topics/플레이북 개요.md' },
  { from: 'Knowledge/Playbook', to: '30_Wiki/34_Topics' },
  { from: 'Knowledge/Infra', to: '30_Wiki/34_Topics' },
  { from: 'Knowledge/API/README.md', to: '30_Wiki/34_Topics/API 개요.md' },
  { from: 'Knowledge/API', to: '30_Wiki/34_Topics' },
  { from: 'Knowledge', to: '30_Wiki', note: '나머지 Knowledge' },
];

export function mapLegacyPath(relPath) {
  for (const rule of LEGACY_TO_MOUSEION_RULES) {
    if (relPath !== rule.from && !relPath.startsWith(`${rule.from}/`)) continue;

    if (rule.action === 'delete') {
      return { to: null, action: 'delete', reason: rule.reason, rule };
    }

    const suffix = relPath.slice(rule.from.length);
    return {
      to: `${rule.to}${suffix}`,
      rule,
      // 연도 폴더 생성은 이관 단계의 책임이며, 이 표는 필요 여부만 기록한다.
      yearFolder: rule.yearFolder === true,
    };
  }

  return null;
}

export function findDestinationCollisions(relPaths) {
  const destinations = new Map();
  for (const relPath of relPaths) {
    const mapping = mapLegacyPath(relPath);
    if (mapping?.action === 'delete') continue;
    const destination = mapping?.to;
    if (!destination) continue;
    const key = destination.toLocaleLowerCase('en-US');
    const group = destinations.get(key) ?? { to: destination, sources: [] };
    group.sources.push(relPath);
    destinations.set(key, group);
  }
  return [...destinations.values()].filter((group) => group.sources.length > 1);
}
