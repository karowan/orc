// Per-leaf context whose surrounding whitespace must survive verbatim.
export default async ({ agent }: any) => agent("task", { context: " leaf ctx " });
