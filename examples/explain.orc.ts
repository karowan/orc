// Real code-reading run: each leaf opens actual source files in the working
// directory and describes what that package does, then a synthesis combines them.
import type { Program } from "@orc/sdk/program";

const DESC = {
  type: "object",
  properties: {
    package: { type: "string" },
    purpose: { type: "string" },
    keyFiles: { type: "array", items: { type: "string" } },
    notableDetail: { type: "string" },
  },
  required: ["package", "purpose", "keyFiles", "notableDetail"],
};

const program: Program = async ({ agent, phase, log }) => {
  const packages = ["core", "executors", "harness-codex"];
  log("reading orc's own source");

  const summaries = await phase("read", () =>
    Promise.all(
      packages.map((pkg) =>
        agent(
          `Read the actual TypeScript source under packages/${pkg}/src/ in the current working directory. ` +
            `Use your file tools to open and read the files. Then describe what the "${pkg}" package does, ` +
            `which files are the important ones, and one notable implementation detail you actually saw in the code.`,
          // `schema` drives structured output natively via the SDK — no need to
          // also say "reply in JSON" in the prompt (that fights the mechanism).
          { schema: DESC, id: `read-${pkg}` },
        ),
      ),
    ),
  );

  return phase("synthesis", () =>
    agent(
      `Here are three package descriptions from reading a TypeScript orchestration runtime called "orc". ` +
        `Write a 3-4 sentence plain-English overview of what the whole project is, grounded ONLY in these. ` +
        `Descriptions: ${JSON.stringify(summaries)}`,
      { schema: { type: "object", properties: { overview: { type: "string" } }, required: ["overview"] }, id: "overview" },
    ),
  );
};
export default program;
