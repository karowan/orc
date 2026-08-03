const reviewTitle = "Review";

export const meta = {
  graph: {
    nodes: [
      { id: "plan", title: "Plan" },
      { id: "review", title: reviewTitle, kind: "gate" },
    ],
    edges: [
      { from: "plan", to: "review" },
      { from: "review", to: "plan", kind: "loop", label: "Changes requested" },
    ],
  },
};

export default async ({ agent, phase }: any) => {
  await phase("plan", () => agent("plan", { id: "plan" }));
  await phase("review", () => agent("review", { id: "review" }));
  return { done: true };
};
