import { createRequire } from "node:module";

/**
 * Meteora DLMM SDK loaded through its CommonJS build. Its ESM build imports `{ BN }` from
 * @coral-xyz/anchor's CommonJS entry, which Node 22 cannot see as a named export
 * ("does not provide an export named 'BN'"); require() works on every Node version.
 */
export const meteoraSdk: typeof import("@meteora-ag/dlmm") = createRequire(import.meta.url)("@meteora-ag/dlmm");
