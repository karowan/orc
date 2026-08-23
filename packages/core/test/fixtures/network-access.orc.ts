// Narrow-only per-leaf networkAccess on write leaves beside a plain inheriting call.
export default async ({ agent }: any) => ({
  off: await agent("net off", { id: "off", readOnly: false, networkAccess: false }),
  inherit: await agent("net inherit", { id: "inherit", readOnly: false }),
  on: await agent("net on", { id: "on", readOnly: false, networkAccess: true }),
});
