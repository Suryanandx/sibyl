/** Virtual module resolved by apps/gateway/build.mjs (see ee-loader.ts). */
declare module "sibyl-ee-entry" {
  import type { EnterpriseRegistrar } from "@open-gpt-live/core";
  const entry: ((registrar: EnterpriseRegistrar) => void | Promise<void>) | undefined;
  export default entry;
}
