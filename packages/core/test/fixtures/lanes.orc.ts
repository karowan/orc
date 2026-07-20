// Concurrent lanes with completion-time edges + a bounded convergence loop.
export default async ({ agent, parallel, phase, settle }: any) => {
  const inventory = await agent("list modules", { id: "inventory" });

  // Two independent lanes; each lane's second step starts when ITS OWN first
  // step finishes (no barrier).
  const lanes = await Promise.all(
    ["alpha", "beta"].map(async (name) => {
      const findings = await agent(`audit ${name} using ${JSON.stringify(inventory)}`, { id: `audit-${name}` });
      return agent(`plan ${name} from ${JSON.stringify(findings)}`, { id: `plan-${name}` });
    }),
  );

  // Bounded loop with a data-dependent break.
  let verdict: any = null;
  for (let round = 0; round < 3; round++) {
    const check = await agent(`converged? round ${round} ${JSON.stringify(lanes)}`, { id: `check-${round}` });
    if ((check as any).seq >= 5) { verdict = check; break; }
  }

  await phase("wrapup", async () => {
    const wrapped = await parallel([
      { prompt: "wrap A" },
      { prompt: "wrap B" },
    ]);
    verdict = { verdict, wrapped };
  });
  return { done: true, verdict };
};
