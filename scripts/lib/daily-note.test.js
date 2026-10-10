import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyTelegramBody, buildSummaryPrompt, groupByCategory, inspectExisting, parseSections, readCategories, recordHashOf,
  renderDailyNote, replaceDailyRoute, sameIgnoringModified, sanitizeSummary, toDayRecord,
} from './daily-note.mjs';

const note = (fm, body = '본문') => `---\n${fm}\n---\n${body}`;
const recs = [
  { link: 'a/b', title: 'B', description: '', sensitivity: '일반', categories: ['700 자산'] },
  { link: 'a/c', title: 'C', description: '딸 2016년생', sensitivity: '개인', categories: ['201 미네'] },
];
const base = { date: '2026-10-09', records: recs, summary: '- 요약', status: '초안', model: 'sonnet', summaryStatus: 'ok', recordHash: 'h1', today: '2026-10-09' };

test('동선 null·빈 배열·체류·실패 문구와 기존 오너 칸 보존', () => {
  const original = renderDailyNote(base).replace('## 오늘 한 줄\n<!-- 오너가 쓰는 칸. AI는 이 칸을 고치지 않는다. -->', '## 오늘 한 줄\n내 기록');
  const prev = inspectExisting(original).prev;
  assert.match(renderDailyNote({ ...base, route: null }), /위치 연동 전/);
  assert.match(renderDailyNote({ ...base, route: [] }), /위치 기록 없음/);
  const routed = renderDailyNote({ ...base, route: [{ start: '08:10', end: '17:50', label: '회사' }], prev });
  assert.match(routed, /- 08:10–17:50 회사/);
  assert.match(routed, /sensitivity: "개인"/);
  assert.match(routed, /## 오늘 한 줄\n내 기록/);
  assert.equal(inspectExisting(routed).ok, true);
  assert.match(renderDailyNote({ ...base, route: 'failed' }), /동선 계산 실패/);
  assert.doesNotMatch(buildSummaryPrompt(base.date, recs), /회사/);
  assert.doesNotMatch(buildDailyTelegramBody(base.date, recs, '- 요약'), /회사/);
});

test('동선 재계산은 위치 지문이 머리말에서 이동해도 중복 키를 만들지 않는다', () => {
  const initial = renderDailyNote({ ...base, routeHash: 'old', route: [] });
  const moved = initial.replace(/^routeHash: "old"\n/m, '').replace(/^model: /m, 'routeHash: "old"\nmodel: ');
  const updated = replaceDailyRoute(moved, [{ start: '12:00', end: '12:30', label: '시험 장소' }], 'new');
  assert.equal((updated.match(/^routeHash:/gm) ?? []).length, 1);
  assert.match(updated, /^routeHash: "new"$/m);
  assert.equal(inspectExisting(updated).ok, true);
});

test('동선 재계산에서 체류가 생기면 개인으로 올리고 수정일을 KST 오늘로 바꾸며 내리지 않는다', () => {
  const args = { ...base, records: [], date: '2026-10-09', today: '2026-10-09', route: [] };
  const original = renderDailyNote(args);
  assert.match(original, /^sensitivity: "일반"$/m);
  assert.match(original, /## 동선\n\(위치 기록 없음\)/);
  const stayed = replaceDailyRoute(original, [{ start: '12:00', end: '12:30', label: '시험 장소' }], 'new', '2026-10-10');
  assert.match(stayed, /^sensitivity: "개인"$/m);
  assert.match(stayed, /^modified: "2026-10-10"$/m);
  assert.equal(inspectExisting(stayed).ok, true);
  const empty = replaceDailyRoute(stayed, [], 'empty', '2026-10-11');
  assert.match(empty, /^sensitivity: "개인"$/m);
  assert.match(empty, /^modified: "2026-10-11"$/m);
  assert.equal(inspectExisting(empty).ok, true);
});

test('외부 장소 라벨의 줄바꿈과 Markdown 기호가 데일리 칸을 나누지 못한다', () => {
  const route = [{ start: '08:10', end: '09:00', label: '건물\r\n## 오늘 한 줄\u2028악성 <b>**값**</b>' }];
  const rendered = renderDailyNote({ ...base, route });
  assert.equal(inspectExisting(rendered).ok, true);
  assert.match(rendered, /- 08:10–09:00 건물 \\#\\# 오늘 한 줄 악성 &lt;b&gt;\\\*\\\*값\\\*\\\*&lt;\/b&gt;/);
  assert.equal((rendered.match(/^## 오늘 한 줄$/gm) || []).length, 1);
});

test('toDayRecord: created가 그날인 노트만, CRLF·BOM도 읽고, 카테고리 두 형식 모두', () => {
  const a = toDayRecord('20_Records/21_Notes/2026/2026-10-09 메모.md', note('type: "note"\ncategory: ["[[01_Home/201 미네]]"]\ndescription: "태권도"\nsensitivity: "개인"\ncreated: "2026-10-09"').replace(/\n/g, '\r\n'), '2026-10-09');
  assert.deepEqual([a.link, a.sensitivity, a.categories], ['20_Records/21_Notes/2026/2026-10-09 메모', '개인', ['201 미네']]);
  assert.equal(toDayRecord('x.md', note('created: "2026-10-08"'), '2026-10-09'), null);
  assert.ok(toDayRecord('00_Inbox/폰.md', '머리말 없음', '2026-10-09', { fallbackDate: '2026-10-09' }));
  assert.deepEqual(readCategories(note('category:\n  - "[[01_Home/700 자산]]"\n  - "[[01_Home/100 나]]"')), ['700 자산', '100 나']);
});

test('parseSections: 코드 블록 안 ## 는 경계가 아니고, 제목 끝 공백은 무시', () => {
  const { sections } = parseSections('# t\n## 오늘 한 줄 \n가\n```\n## 코드 안\n```\n## 일정\n나');
  assert.deepEqual(sections.map((s) => s.title), ['오늘 한 줄', '일정']);
  assert.match(sections[0].content, /## 코드 안/);
});

test('renderDailyNote + inspectExisting: AI 칸만 바뀌고 오너 칸·추가 칸·맨 위·머리말 추가 키는 그대로', () => {
  const first = renderDailyNote(base);
  assert.equal(inspectExisting(first).ok, true);
  const edited = first
    .replace('## 오늘 한 줄\n<!-- 오너가 쓰는 칸. AI는 이 칸을 고치지 않는다. -->', '## 오늘 한 줄\n미네 2품 합격!\n### 오너 소제목\n둘째 줄')
    .replace('# 2026-10-09\n', '# 2026-10-09\n맨 위에 쓴 오너 글\n')
    .replace('---\n\n# 2026', 'tags:\n  - 가족\n---\n\n# 2026')
    .concat('## 내가 만든 칸\n오너 글\n## 또 다른 칸\n```\n## 코드\n```\n');
  const inspected = inspectExisting(edited);
  assert.equal(inspected.ok, true, inspected.reason);
  const again = renderDailyNote({ ...base, summary: '- 새 요약', status: '확정', recordHash: 'h2', prev: inspected.prev });
  assert.match(again, /## 오늘 한 줄\n미네 2품 합격!\n### 오너 소제목\n둘째 줄\n/);
  assert.match(again, /맨 위에 쓴 오너 글/);
  assert.match(again, /tags:\n {2}- 가족\n---/);
  assert.match(again, /## 내가 만든 칸\n오너 글\n\n## 또 다른 칸\n```\n## 코드\n```/);
  assert.match(again, /- 새 요약/);
  assert.match(again, /dailyStatus: "확정"/);
  assert.equal(inspectExisting(again).ok, true);
});

test('inspectExisting: AI 칸을 오너가 고쳤거나, 데일리 형식이 아닌 파일이면 쓰지 않는다', () => {
  const first = renderDailyNote(base);
  assert.equal(inspectExisting(first.replace('- 요약', '- 오너가 고친 요약')).ok, false);
  assert.equal(inspectExisting('---\ntype: "daily"\n---\n# 템플릿').ok, false);
  assert.equal(inspectExisting('그냥 메모').ok, false);
  assert.equal(inspectExisting(null).ok, true);
});

test('요약 안전: 개인 기록은 개수만 프롬프트에, LLM 출력은 "- " 줄만, 텔레그램은 개수와 이스케이프된 요약만', () => {
  const prompt = buildSummaryPrompt('2026-10-09', recs);
  assert.doesNotMatch(prompt, /딸 2016년생/);
  assert.match(prompt, /\[201 미네\] 개인 기록 1건\(내용 비공개\)/);
  assert.equal(sanitizeSummary('---\n## 오너 메모\n- 하나\n텍스트\n- # 제목\n-   둘'), '- 하나');
  const body = buildDailyTelegramBody('2026-10-09', recs, '- a<b');
  assert.doesNotMatch(body, /딸 2016년생/);
  assert.match(body, /a&lt;b/);
  assert.equal(groupByCategory(recs)[0][0], '201 미네');
});

test('recordHashOf는 민감도·카테고리 변화에도 바뀌고, sameIgnoringModified는 modified만 다른 경우 같다', () => {
  assert.notEqual(recordHashOf(recs), recordHashOf([{ ...recs[0], sensitivity: '개인' }, recs[1]]));
  const a = renderDailyNote(base);
  assert.ok(sameIgnoringModified(a, a.replace('modified: "2026-10-09"', 'modified: "2026-10-10"')));
});

test('여러 번 다시 만들어도 내용이 늘지 않는다(빈 줄 누적 없음)', () => {
  let note = renderDailyNote(base);
  for (let i = 0; i < 3; i += 1) note = renderDailyNote({ ...base, prev: inspectExisting(note).prev });
  assert.equal(note, renderDailyNote({ ...base, prev: inspectExisting(renderDailyNote(base)).prev }));
  assert.ok(sameIgnoringModified(note, renderDailyNote(base)));
});

test('리뷰 재현 HIGH: 같은 이름 칸을 오너가 또 만들거나, 머리말에 한글 키·주석을 넣어도 보존', () => {
  const first = renderDailyNote(base);
  const edited = first
    .concat('## 일정\n내가 따로 쓴 일정 메모\n')
    .replace('---\n\n# 2026', '기분: 좋음\n"따옴표 키": 값\n# 오너 주석\n---\n\n# 2026');
  const inspected = inspectExisting(edited);
  assert.equal(inspected.ok, true, inspected.reason);
  const again = renderDailyNote({ ...base, summary: '- 새 요약', prev: inspected.prev });
  assert.match(again, /## 일정\n내가 따로 쓴 일정 메모/);
  assert.match(again, /기분: 좋음\n"따옴표 키": 값\n# 오너 주석\n---/);
  assert.equal(inspectExisting(again).ok, true);
});

test('리뷰 MEDIUM: AI 칸과 같은 이름 칸이 앞에 있으면 정확한 사유로 거부, 들여쓰지 않은 목록은 앞 키에 붙어 함께 처리', () => {
  const first = renderDailyNote(base);
  const dup = first.replace('## 일정\n', '## 일정\n오너 일정\n## 일정\n');
  assert.match(inspectExisting(dup).reason, /같은 이름의 칸이 그보다 앞에/);
  const unindented = first.replace('---\n\n# 2026', 'tags:\n- 가족\n---\n\n# 2026').replace(/category: \[\]/, 'category:\n- "[[01_Home/700 자산]]"');
  const again = renderDailyNote({ ...base, prev: inspectExisting(unindented).prev });
  assert.match(again, /tags:\n- 가족\n---/);
  assert.doesNotMatch(again, /\n- "\[\[01_Home\/700 자산\]\]"\n/, '정해진 키의 목록 줄은 키와 함께 교체');
});

test('renderDailyNote: 일정 null/없음/있음/조회 실패와 오너 글 보존', () => {
  const args = { date: '2026-10-10', records: [], summary: '- 기록 요약', status: '초안', model: '없음', summaryStatus: 'empty', recordHash: 'hash', today: '2026-10-10' };
  const base = renderDailyNote({ ...args, events: null });
  assert.match(base, /캘린더 미연결 — google-oauth-setup 필요/);
  const empty = renderDailyNote({ ...args, events: [] });
  assert.match(empty, /## 일정\n\(일정 없음\)/);
  const prev = inspectExisting(empty).prev;
  prev.sections.push({ title: '오너 추가', content: '내 글' });
  const filled = renderDailyNote({ ...args, prev, events: [{ calendar: '개인', title: '치과', start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00', allDay: false, location: null }] });
  assert.match(filled, /10:00–11:00 치과 · 개인/);
  assert.match(filled, /sensitivity: "개인"/);
  assert.match(filled, /## 오너 추가\n내 글/);
  assert.match(renderDailyNote({ ...args, events: 'failed' }), /캘린더 조회 실패 — 다음 실행에서 다시 시도/);
});

test('renderDailyNote: 소유자별 일정에는 굵은 소제목과 기타 캘린더명이 표시된다', () => {
  const own = { calendar: '개인', title: '치과', start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00', allDay: false };
  const other = { ...own, calendar: '기타 캘린더', title: '기타 일정' };
  const note = renderDailyNote({ ...base, events: [own, other], eventGroups: [
    { owner: '나', events: [own] }, { owner: '기타', events: [other] },
  ] });
  assert.match(note, /## 일정\n\*\*나\*\*\n- 10:00–11:00 치과\n\*\*기타\*\*\n- 10:00–11:00 기타 일정 · 기타 캘린더/);
  assert.doesNotMatch(note, /### 나/);
});

test('캘린더 실패·미연결 때 이전 정상 일정과 aiHash를 유지한다', () => {
  const args = { ...base, records: [], events: [{ calendar: '개인', title: '치과', start: '2026-10-09T10:00:00+09:00', end: '2026-10-09T11:00:00+09:00', allDay: false }] };
  const original = renderDailyNote(args);
  for (const events of [null, 'failed']) {
    const rendered = renderDailyNote({ ...args, events, status: '확정', prev: inspectExisting(original).prev });
    assert.match(rendered, /## 일정\n- 10:00–11:00 치과 · 개인/);
    assert.match(rendered, /sensitivity: "개인"/);
    assert.equal(inspectExisting(rendered).ok, true);
  }
});

 test('멀티라인 일정 제목·장소가 노트 구획과 aiHash를 깨지 않는다', () => {
  const rendered = renderDailyNote({
    date: '2026-10-10', records: [], summary: '- 요약', status: '초안', model: '없음',
    summaryStatus: 'empty', recordHash: 'hash', today: '2026-10-10',
    events: [{ calendar: '개인\n## 조작', title: '치과\n## 오너 메모\n```',
      start: '2026-10-10T10:00:00+09:00', end: '2026-10-10T11:00:00+09:00',
      allDay: false, location: '서울\r\n## AI 하루 요약\u2028```' }],
  });
  assert.match(rendered, /치과 ## 오너 메모 ``` \(서울 ## AI 하루 요약 ```\) · 개인 ## 조작/);
  assert.equal(inspectExisting(rendered).ok, true);
  assert.equal(inspectExisting(rendered).prev.sections.filter((section) => section.title === '오너 메모').length, 1);
});
