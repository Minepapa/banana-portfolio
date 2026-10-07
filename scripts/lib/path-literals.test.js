import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import { MOUSEION_TOP_FOLDERS } from './vault-layout.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = [];
const FORBIDDEN = [
  /banana-vault/g,
  /Stockproject\//gi,
  /(?:^|[^\w])(?:Facts|State|Log|Knowledge|Decisions)(?:\/|['"`])/g,
  new RegExp(`(?:^|[^\\w])(?:${MOUSEION_TOP_FOLDERS.join('|')})(?:\\/|['"\\x60])`, 'g'),
];

function stripJsComments(source) {
  const out = [...source];
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) if (source[index] !== '\n') out[index] = ' ';
  };
  // acorn-jsx는 정규식과 JSX 텍스트를 구분한다. 텍스트는 JS 코드가 아니므로 검사에서 제외한다.
  const tokenizer = Parser.extend(jsx()).tokenizer(source, {
    ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
    onComment: (_block, _text, start, end) => mask(start, end),
  });
  for (let token = tokenizer.getToken(); token.type.label !== 'eof'; token = tokenizer.getToken()) {
    if (token.type.label === 'jsxText') mask(token.start, token.end);
  }
  return out.join('');
}

function stripHashComments(source) {
  const out = [...source];
  let quote = null;
  let comment = false;
  let docstring = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (docstring) {
      if (source.startsWith(docstring, i)) {
        out[i] = out[i + 1] = out[i + 2] = ' ';
        i += 2;
        docstring = null;
      } else if (char !== '\n') out[i] = ' ';
      continue;
    }
    if (char === '\n') {
      comment = false;
      continue;
    }
    if (comment) out[i] = ' ';
    else if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      const opening = char.repeat(3);
      const before = source.slice(source.lastIndexOf('\n', i - 1) + 1, i);
      if (source.startsWith(opening, i) && /^\s*$/.test(before)
        && !/[,(=]$/.test(source.slice(0, i).trimEnd())) {
        out[i] = out[i + 1] = out[i + 2] = ' ';
        i += 2;
        docstring = opening;
      } else quote = char;
    }
    else if (char === '#') {
      if ((i === 0 && source[i + 1] === '!') || source[i - 1] === '$' || source[i - 1] === '{') continue;
      out[i] = ' ';
      comment = true;
    }
  }
  return out.join('');
}

function violations(source, extension) {
  const code = extension === '.py' || extension === '.sh'
    ? stripHashComments(source)
    : stripJsComments(source);
  const found = [];
  for (const pattern of FORBIDDEN) {
    for (const match of code.matchAll(pattern)) {
      const line = code.slice(0, match.index).split('\n').length;
      found.push({ line, value: match[0] });
    }
  }
  return found;
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    if (['node_modules', '.omc', 'vendor'].includes(entry.name)) continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if (entry.isFile()) {
      const extension = extname(entry.name);
      const extensions = directory.startsWith('src') ? ['.js', '.jsx'] : ['.mjs', '.js', '.py', '.sh'];
      if (!extensions.includes(extension) || entry.name.endsWith('.test.js')) continue;
      if (file === 'scripts/lib/vault-paths.mjs') continue;
      // 볼트 경로 정의는 vault-paths.mjs(현재 값)와 vault-layout.mjs(이관 매핑) 두 파일에만 둔다
      if (file === 'scripts/lib/vault-layout.mjs') continue;
      yield file;
    }
  }
}

test('주석 제거기는 경로를 담은 주석을 무시하고 코드와 URL 문자열은 보존한다', () => {
  assert.deepEqual(violations('// Log/Strategy\n/* banana-vault */\nconst url = \'https://x\';', '.js'), []);
  assert.deepEqual(violations("const path = 'Log/Strategy';", '.js'), [{ line: 1, value: "'Log/" }]);
  assert.deepEqual(violations("const path = '95_Etna/Jobs';", '.js'), [{ line: 1, value: "'95_Etna/" }]);
  assert.deepEqual(violations("const text = 'see [[State/Holdings]]';", '.js'), [{ line: 1, value: '[State/' }]);
  assert.deepEqual(violations("const text = 'see 95_Etna/Investing';", '.js'), [{ line: 1, value: ' 95_Etna/' }]);
  assert.deepEqual(violations("const url = 'https://x'; const path = 'State';", '.js'), [{ line: 1, value: "'State'" }]);
  assert.deepEqual(violations("join(root, 'State', 'X')", '.js'), [{ line: 1, value: "'State'" }]);
  assert.deepEqual(violations('const root = "banana-vault";', '.js'), [{ line: 1, value: 'banana-vault' }]);
  assert.deepEqual(violations('REPO="/Users/x/stockproject/app"', '.sh'), [{ line: 1, value: 'stockproject/' }]);
  assert.deepEqual(violations("#!/bin/sh\n# 'Log/Strategy'\npath='Facts/'", '.sh'), [{ line: 3, value: "'Facts/" }]);
  assert.deepEqual(violations("x = '# tag' # 'State'", '.py'), []);
  assert.deepEqual(violations('    """\n    `Log/DevRequests/x.md`\n    """', '.py'), []);
  assert.deepEqual(violations('const re = /`([^`]+)`/g; // "State/"', '.js'), []);
});

test('정규식·JSX·셸 특수변수·파이썬 인자 문자열을 코드와 구분한다', () => {
  assert.deepEqual(violations("function f(s){ return /'/.test(s); }\nconst u='https://x'; const p='/Users/a/Stockproject/b';", '.js'),
    [{ line: 2, value: 'Stockproject/' }]);
  assert.deepEqual(violations("const ok = a && /'/.test(s);\nconst p='x'+'//'+'banana-vault';", '.js'),
    [{ line: 2, value: 'banana-vault' }]);
  assert.deepEqual(violations("const view = <p>Don't</p>; const p='/Users/a/Stockproject/b';", '.jsx'),
    [{ line: 1, value: 'Stockproject/' }]);
  assert.deepEqual(violations('N=${#ARR[@]}; REPO=/Users/a/Stockproject/b', '.sh'),
    [{ line: 1, value: 'Stockproject/' }]);
  assert.deepEqual(violations('echo $#; cd /Users/a/Stockproject/b', '.sh'),
    [{ line: 1, value: 'Stockproject/' }]);
  assert.deepEqual(violations('run(\n    """/Users/a/banana-vault/x"""\n)', '.py'),
    [{ line: 2, value: 'banana-vault' }]);
  assert.deepEqual(violations('`${root}/State/X`', '.js'), [{ line: 1, value: '/State/' }]);
  assert.deepEqual(violations("root + '/Knowledge/Index.md'", '.js'), [{ line: 1, value: '/Knowledge/' }]);
  assert.deepEqual(violations("'./State/x'", '.js'), [{ line: 1, value: '/State/' }]);
});

test('실행 코드에 볼트·저장소 경로를 직접 적지 않는다', () => {
  const failures = [];
  for (const file of [...sourceFiles('scripts'), ...sourceFiles('src')]) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const { line, value } of violations(source, extname(file))) {
      if (ALLOWED.some((entry) => entry.file === file && entry.pattern.test(value))) continue;
      failures.push(`${file}:${line}: ${value}`);
    }
  }
  assert.deepEqual(failures, [], `하드코딩 경로 ${failures.length}건:\n${failures.join('\n')}`);
});
