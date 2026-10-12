import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { VAULT_REL } from './vault-paths.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';

function validLocal(year, month, day, hour, minute, second) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

export function parseCallFilename(filename) {
  const stem = basename(filename, extname(filename)).normalize('NFC');
  const match = stem.match(/^통화(?: 녹음)? (.+)_(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/u);
  if (!match) return null;
  const [, contact, yy, month, day, hour, minute, second] = match;
  const year = 2000 + Number(yy);
  if (!contact.trim() || !validLocal(year, Number(month), Number(day), Number(hour), Number(minute), Number(second))) return null;
  const occurred = `20${yy}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
  return { contact, occurred };
}

export function contactFromFilename(filename) {
  const stem = basename(filename, extname(filename)).normalize('NFC');
  return stem.replace(/^통화(?: 녹음)? /u, '')
    .replace(/_\d{6}_\d{6}$/u, '').trim() || stem;
}

export function contactKey(value) {
  return String(value ?? '').normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFE0F\uFEFF]/gu, '').trim();
}

export function isLinkedCall(contact, people) {
  const key = contactKey(contact);
  return Boolean(key) && people.some((person) => person.contacts.some((name) => contactKey(name) === key));
}

export function loadPeople(root, { strict = false } = {}) {
  const directory = join(root, VAULT_REL.people);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.md')).map((filename) => {
    const title = basename(filename, '.md').normalize('NFC');
    const path = join(directory, filename);
    if (strict && !lstatSync(path).isFile()) throw new Error(`인물 노트가 일반 파일이 아닙니다: ${filename}`);
    const content = readFileSync(path, 'utf8');
    if (strict && !/^---\n[\s\S]*?\n---(?:\n|$)/.test(content)) {
      throw new Error(`인물 노트 머리말 오류: ${filename}`);
    }
    const fields = parseFrontmatter(content);
    if (strict && fields.phoneContacts !== undefined && !Array.isArray(fields.phoneContacts)) {
      throw new Error(`인물 노트 연락처 형식 오류: ${filename}`);
    }
    return {
      title, contacts: Array.isArray(fields.phoneContacts)
        ? fields.phoneContacts.map((name) => String(name).normalize('NFC')) : [],
      aliases: Array.isArray(fields.aliases)
        ? fields.aliases.map((name) => String(name).normalize('NFC')) : [],
      family: (Array.isArray(fields.category) ? fields.category : [fields.category])
        .some((category) => typeof category === 'string' && /\[\[01_Home\/20\d\s/.test(category)),
    };
  });
}

export function matchPeople(kind, filename, contact, people) {
  if (kind === 'Calls') {
    const matches = people.filter((person) => isLinkedCall(contact, [person]));
    if (matches.length > 1) throw new Error('연락처가 여러 인물 노트에 연결됨');
    return matches;
  }
  const stem = basename(filename, extname(filename)).normalize('NFC');
  return people.filter((person) => [person.title, ...person.aliases]
    .some((name) => name && stem.includes(name)));
}
