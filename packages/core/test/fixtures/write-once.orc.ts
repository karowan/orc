export default async ({ agent }: any) => {
  const a = await agent("read step", { id: "read" });
  const b = await agent(`write step after ${JSON.stringify(a)}`, { id: "write", readOnly: false });
  return { a, b };
};
