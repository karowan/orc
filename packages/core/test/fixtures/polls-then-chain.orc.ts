// Three read-only ext polls (seq 0-2), then four sequential agent leaves (seq 3-6).
export default async ({ ext, agent }: any) => {
  for (let i = 0; i < 3; i++) await ext.poll({ i });
  await agent("work a", { id: "a" });
  await agent("work b", { id: "b" });
  await agent("work c", { id: "c" });
  await agent("work d", { id: "d" });
  return { done: true };
};
