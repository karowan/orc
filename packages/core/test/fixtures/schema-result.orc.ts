export default async ({ agent }: any) =>
  agent("return a number", {
    id: "schema",
    schema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
  });
