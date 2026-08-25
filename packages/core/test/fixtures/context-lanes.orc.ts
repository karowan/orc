// Parallel lanes carry their own context; a lane may omit it.
export default async ({ parallel }: any) =>
  parallel([
    { prompt: "a", context: "lane A" },
    { prompt: "b" },
  ]);
