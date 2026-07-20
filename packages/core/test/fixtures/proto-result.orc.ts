export default async ({ agent }: any) => {
  (JSON as any).parse = () => ({ poison: true });
  const value = await agent("return a proto key", { id: "proto" });
  return {
    hasOwn: Object.prototype.hasOwnProperty.call(value, "__proto__"),
    keys: Object.keys(value),
    protoValue: value.__proto__,
  };
};
