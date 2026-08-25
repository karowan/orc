// A single identified leaf carrying per-leaf context, for cap error naming.
export default async ({ agent }: any) =>
  agent("task", { id: "capped", context: "x".repeat(64) });
