// A slightly meatier run so the waterfall has something to look at: three
// independent lanes (each a two-step audit→plan chain) that finish on their own
// time, then a synthesis. Read-only.
import type { Program } from "@orc/sdk/program";

const FINDINGS = { type: "object", properties: { area: { type: "string" }, note: { type: "string" } }, required: ["area", "note"] };
const PLAN = { type: "object", properties: { area: { type: "string" }, step: { type: "string" } }, required: ["area", "step"] };

const program: Program = async ({ agent, phase, log }) => {
  log("starting a 3-lane audit");
  const areas = ["auth", "logging", "config"];

  const plans = await phase("audit", () =>
    Promise.all(
      areas.map(async (area) => {
        const finding = await agent(
          `You are auditing the "${area}" area of a small web service. Invent one plausible concern and reply with only JSON.`,
          { schema: FINDINGS, harness: area === "logging" ? "codex" : "claude", id: `audit-${area}` },
        );
        return agent(
          `Given this finding, propose one concrete remediation step. Reply with only JSON. Finding: ${JSON.stringify(finding)}`,
          { schema: PLAN, id: `plan-${area}` },
        );
      }),
    ),
  );

  return phase("synthesis", () =>
    agent(
      `Summarize these remediation plans into one JSON object {"summary":"...","count":N}. Only JSON. Plans: ${JSON.stringify(plans)}`,
      { schema: { type: "object", properties: { summary: { type: "string" }, count: { type: "number" } }, required: ["summary", "count"] }, id: "summary" },
    ),
  );
};
export default program;
