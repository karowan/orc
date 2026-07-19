// An orchestration with a remote (ssh) leaf that requires a permission bubble.
// The write leaf runs codex ON frank in manual mode; its approval request flows
// back over the ssh app-server pipe and bubbles to the operator.
import type { Program } from "@orc/sdk/program";

const program: Program = async ({ agent, phase }) => {
  const plan = await phase("plan", () =>
    agent('Pick a filename. Reply with ONLY this JSON: {"name":"orc-ssh-demo.txt"}', {
      id: "plan-local",
      readOnly: true,
      schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    }),
  );

  return phase("apply", () =>
    agent(
      `Create a file named ${(plan as any).name} containing the single word "orc" in the current working directory, ` +
        `using a shell command (e.g. printf 'orc' > ${(plan as any).name}). Then reply with ONLY {"created":true}.`,
      {
        id: "apply-on-frank",
        host: "frank",
        cwd: "/Users/frank/orc-playground",
        readOnly: false,
        schema: { type: "object", properties: { created: { type: "boolean" } }, required: ["created"] },
      },
    ),
  );
};
export default program;
