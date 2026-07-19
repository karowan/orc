/**
 * Live ssh tests — skipped unless ORC_SSH_TEST_HOST is set, e.g.
 *   ORC_SSH_TEST_HOST=frank npx vitest run packages/executors/test/ssh-live.test.ts
 */
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { SshExecutor } from "../src/ssh.js";

const host = process.env.ORC_SSH_TEST_HOST;

describe.skipIf(!host)("SshExecutor (live)", () => {
  const ssh = new SshExecutor(host ?? "unused");
  const playground = "orc-playground"; // relative to the remote $HOME

  it("echoes through the login shell", async () => {
    const { code, stdout } = await ssh.run(["echo", "hello from orc"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("hello from orc");
  });

  it("readFile/writeFile round-trip in ~/orc-playground", async () => {
    const mk = await ssh.run(["mkdir", "-p", playground]);
    expect(mk.code).toBe(0);
    // Resolve $HOME so we can use absolute paths with readFile/writeFile.
    const home = (await ssh.run(["sh", "-c", 'printf %s "$HOME"'])).stdout;
    expect(home.startsWith("/")).toBe(true);
    const file = `${home}/${playground}/orc-live-test.txt`;
    const payload = `orc live test ${Date.now()}\nsecond line with 'quotes' $dollar\n`;
    await ssh.writeFile(file, payload);
    expect(await ssh.exists(file)).toBe(true);
    expect(await ssh.readFile(file)).toBe(payload);
    await ssh.run(["rm", "-f", file]);
  });

  it("resolves harness binaries via the login shell PATH", async () => {
    const report = await doctor(ssh, { harnesses: ["claude", "codex"] });
    expect(report.host).toBe(host);
    for (const h of report.harnesses) {
      // eslint-disable-next-line no-console
      console.log(`[live] ${h.name}: found=${h.found} path=${h.path} version=${h.version}`);
    }
    expect(report.harnesses).toHaveLength(2);
  });
});
