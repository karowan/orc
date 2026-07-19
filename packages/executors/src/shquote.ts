/**
 * POSIX single-quote shell escaping.
 *
 * Safe for any byte sequence: wraps the string in single quotes and rewrites
 * embedded single quotes as `'\''` (close quote, literal quote, reopen).
 * Plain word-safe strings are returned untouched for readability.
 */
const SAFE_WORD = /^[A-Za-z0-9_/.:=@%^+,-]+$/;

export function shQuote(s: string): string {
  if (s === "") return "''";
  if (SAFE_WORD.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Quote every argv element and join into a single shell command string. */
export function shJoin(cmd: readonly string[]): string {
  return cmd.map(shQuote).join(" ");
}
