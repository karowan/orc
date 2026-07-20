import { describe, expect, it } from "vitest";
import { LocalExecutor } from "../src/local.js";
import { shJoin, shQuote } from "../src/shquote.js";

const NASTY: string[] = [
  "",
  "plain",
  "with space",
  "single'quote",
  `double"quote`,
  "'''",
  "$HOME and ${PWD}",
  "back`tick`",
  "semi;colon && chain || or",
  "star * glob ? [a-z]",
  "new\nline",
  "tab\there",
  "back\\slash",
  "redirect > file < in 2>&1",
  "hash # comment",
  "tilde ~user",
  "unicode ✓ émoji 🎉",
  "-leading-dash",
  "(parens) {braces}",
  "!history",
  "a'b\"c$d`e\\f g\nh",
  "=ls",
  "^",
  "a^b",
];

describe("shQuote", () => {
  it("round-trips nasty strings through zsh with extended globbing", async () => {
    const local = new LocalExecutor();
    for (const s of NASTY) {
      const { code, stdout } = await local.run([
        "zsh",
        "-f",
        "-o",
        "EXTENDED_GLOB",
        "-c",
        `printf %s ${shQuote(s)}`,
      ]);
      expect(code, `exit for ${JSON.stringify(s)}`).toBe(0);
      expect(stdout, `round-trip of ${JSON.stringify(s)}`).toBe(s);
    }
  });

  it("round-trips argv lists through shJoin", async () => {
    const local = new LocalExecutor();
    const argv = ["echo", "-n", "a b", "c'd", "$e", "f\ng"];
    const { code, stdout } = await local.run([
      "sh",
      "-c",
      `${shJoin(["printf", "%s|", ...argv])}`,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe(argv.join("|") + "|");
  });

  it("quotes every word, including zsh expansion syntax", () => {
    expect(shQuote("abc/def.txt")).toBe("'abc/def.txt'");
    expect(shQuote("a b")).toBe("'a b'");
    expect(shQuote("")).toBe("''");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote("=ls")).toBe("'=ls'");
    expect(shQuote("a^b")).toBe("'a^b'");
  });
});
