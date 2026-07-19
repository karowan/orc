import { describe, expect, it } from "vitest";
import { fnv1a32, portForHome } from "../src/index.js";

describe("portForHome", () => {
  it("is deterministic for the same home", () => {
    expect(portForHome("/Users/kyle/.orc")).toBe(portForHome("/Users/kyle/.orc"));
    expect(portForHome("/tmp/other-home")).toBe(portForHome("/tmp/other-home"));
  });

  it("stays in the 41000..42999 range", () => {
    for (const home of ["/Users/kyle/.orc", "/tmp/a", "/var/x/y/z", "", "~/.orc", "/some/very/long/path/home"]) {
      const port = portForHome(home);
      expect(port).toBeGreaterThanOrEqual(41000);
      expect(port).toBeLessThanOrEqual(42999);
    }
  });

  it("uses fnv1a32 of the home path", () => {
    expect(portForHome("/x")).toBe(41000 + (fnv1a32("/x") % 2000));
    // FNV-1a 32-bit known vector: fnv1a32("") = offset basis
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });
});
