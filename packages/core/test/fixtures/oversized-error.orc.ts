export default async ({ agent, settle }: any) => {
  (globalThis as any).Error = function () {
    return { message: "poisoned error constructor" };
  };
  const outcome = await settle(agent("fail with a long error", { id: "long-error" }));
  return outcome;
};
