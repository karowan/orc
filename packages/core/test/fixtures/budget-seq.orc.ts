// Two sequential leaves — used to exercise the run budget cap.
export default async ({ agent }: any) => {
  await agent("first", { id: "a" });
  await agent("second", { id: "b" });
  return "done";
};
