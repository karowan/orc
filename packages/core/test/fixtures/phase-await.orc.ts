// Two concurrent phase scopes, each with an await BETWEEN two agent calls.
// The buggy global-marker design would mislabel the post-await calls.
export default async ({ agent, phase }: any) => {
  await Promise.all([
    phase("alpha", async () => {
      await agent("alpha-1", { id: "a1" });
      await agent("alpha-2", { id: "a2" }); // must still be phase "alpha"
    }),
    phase("beta", async () => {
      await agent("beta-1", { id: "b1" });
      await agent("beta-2", { id: "b2" }); // must still be phase "beta"
    }),
  ]);
  return { done: true };
};
