// A write leaf that requests network beyond whatever the run granted.
export default async ({ agent }: any) =>
  agent("needs net", { id: "net", readOnly: false, networkAccess: true });
