import { readFileSync } from 'node:fs';

// Optional State files default only when they have never been created. Permission,
// I/O, and filesystem errors must reach callers so order paths stop instead of
// interpreting an unreadable kill switch as disabled.
export function readOptionalStateFile(filePath, readFile = readFileSync) {
  try {
    return readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
