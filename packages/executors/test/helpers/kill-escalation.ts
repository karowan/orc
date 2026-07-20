import { LocalExecutor } from "../../src/local.js";

const proc = new LocalExecutor({ killGraceMs: 250 }).spawn(
  ["sh", "-c", `sh -c 'trap "" TERM; echo $$; exec </dev/null >/dev/null 2>&1; exec sleep 100' & wait`],
  { stdin: "ignore" },
);

let stdout = "";
for await (const chunk of proc.stdout) {
  stdout += chunk;
  if (stdout.includes("\n")) break;
}
const descendantPid = Number(stdout.trim());
if (!Number.isInteger(descendantPid) || descendantPid <= 0) throw new Error(`invalid descendant pid: ${stdout}`);

await new Promise<void>((resolve, reject) => {
  process.stdout.write(`${descendantPid}\n`, (error) => (error ? reject(error) : resolve()));
});
proc.kill();
await proc.exited;
proc.stdout.destroy();
proc.stderr.destroy();
