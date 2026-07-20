export default async ({ agent, settle }: any) => {
  const caught = await settle(agent("caught failure", { id: "caught" }));
  const middle = await agent(`continue after ${caught.status}`, { id: "middle" });
  const tail = await agent(`terminal after ${JSON.stringify(middle)}`, { id: "tail" });
  return { caught, middle, tail };
};
