export default async ({ agent }: any) => {
  return agent("do a write", { readOnly: false });
};
