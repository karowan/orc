// Six read-only ext polls, then three agent leaves.
export default async ({ ext, agent }: any) => {
  const polls = [];
  for (let i = 0; i < 6; i++) polls.push(await ext.poll({ i }));
  const a = await agent("work a", { id: "a" });
  const b = await agent("work b", { id: "b" });
  const c = await agent("work c", { id: "c" });
  return { polls: polls.length, work: [a, b, c].length };
};
