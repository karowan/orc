// A whitespace-only per-leaf slot counts as empty.
export default async ({ agent }: any) => agent("task", { context: "  \n " });
