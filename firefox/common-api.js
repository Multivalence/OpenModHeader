/* OpenModHeader — browser API shim.

   Extracted from common.js so that secretstore.js can use it without a
   circular import (common.js imports secretstore.js for migration).

   Firefox exposes promise-based `browser.*`; Chrome exposes `chrome.*`,
   which also returns promises for every API this extension touches. */
export const api = globalThis.browser ?? globalThis.chrome;
