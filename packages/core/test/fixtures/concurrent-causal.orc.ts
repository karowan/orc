export default async ({ agent }: any) =>
  Promise.all([
    agent("fails first", { id: "causal" }),
    agent("finishes later", { id: "sibling" }),
  ]);
