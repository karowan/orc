export default async ({ parallel, phase }: any) =>
  phase("implementation", () =>
    parallel(
      [
        { prompt: "write lane a", id: "lane-a", readOnly: false },
        { prompt: "write lane b", id: "lane-b", readOnly: false },
      ],
      { id: "wave-1", title: "Foundation" },
    ),
  );
