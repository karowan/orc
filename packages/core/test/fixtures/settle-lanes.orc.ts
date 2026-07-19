// One settle()'d lane fails and is collected instead of sinking the run. The
// parallel() group has a failing member too, and — because lanes are now
// independent — its siblings still run to completion and come back as per-lane
// settled outcomes.
export default async ({ agent, settle, parallel }: any) => {
  const lanes = await Promise.all([
    settle(agent("lane ok", { id: "ok-lane" })),
    settle(agent("lane bad", { id: "bad-lane" })),
  ]);
  const grouped = await parallel([{ prompt: "g1" }, { prompt: "g2" }, { prompt: "g3" }]);
  return { lanes, grouped };
};
