export default async ({ agent, ext }: any) =>
  Promise.all([
    agent("write until cancelled", { id: "writer", readOnly: false }),
    ext.never(null),
  ]);
