export default async ({ ext, agent }: any) => {
  const fetched = await ext.lookup({ key: "alpha" });
  const summarized = await agent(`summarize ${JSON.stringify(fetched)}`);
  return { fetched, summarized };
};
