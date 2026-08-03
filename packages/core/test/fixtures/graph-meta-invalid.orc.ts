export const meta = {
  graph: {
    nodes: [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  },
};

export default async ({ agent }: any) => {
  await agent("never reached");
  return null;
};
