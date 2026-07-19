// Tiny live smoke: two parallel leaves feeding a synthesis. Read-only.
import type { Program } from "@orc/sdk/program";

const OK = { type: "object", properties: { word: { type: "string" } }, required: ["word"] };

const program: Program = async ({ agent, parallel, phase }) => {
  const pair = await phase("gather", () =>
    parallel([
      { prompt: 'Reply with exactly this JSON and nothing else: {"word":"ping"}', schema: OK, id: "left" },
      { prompt: 'Reply with exactly this JSON and nothing else: {"word":"pong"}', schema: OK, id: "right" },
    ]),
  );
  return phase("synthesis", () =>
    agent(
      `Combine these two words into one JSON object {"combined":"<a>-<b>"} using a=${JSON.stringify(pair[0])} b=${JSON.stringify(pair[1])}. Reply with only the JSON.`,
      { schema: { type: "object", properties: { combined: { type: "string" } }, required: ["combined"] }, id: "combine" },
    ),
  );
};
export default program;
