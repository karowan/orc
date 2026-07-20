/**
 * POSIX single-quote shell escaping.
 *
 * Wraps every string in single quotes and rewrites embedded single quotes as
 * `'\''` (close quote, literal quote, reopen). Always quoting also prevents
 * zsh-specific expansion of words such as `=ls` and `a^b`.
 */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Quote every argv element and join into a single shell command string. */
export function shJoin(cmd: readonly string[]): string {
  return cmd.map(shQuote).join(" ");
}
