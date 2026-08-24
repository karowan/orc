export default async ({ agent }: any) => {
  const first = await agent("return a number", {
    id: "schema",
    schema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
  });
  const second = await agent("use the number", { id: "after" });
  return { first, second };
};
