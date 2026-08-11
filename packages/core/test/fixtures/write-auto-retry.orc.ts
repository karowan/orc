export default async ({ agent }: any) => {
  return agent("do a flaky write", {
    id: "flaky-write",
    readOnly: false,
    autoRetry: true,
  });
};
