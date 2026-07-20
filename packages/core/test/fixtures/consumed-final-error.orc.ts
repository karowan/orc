export default async ({ agent, settle }: any) => {
  await settle(agent("caught final failure", { id: "caught-final" }));
  throw new Error("program bug after consuming the leaf failure");
};
