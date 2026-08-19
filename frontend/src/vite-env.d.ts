/// <reference types="vite/client" />

// styles.stacking.test.ts reads the stylesheet off disk to check the reading
// overlay's z-index order — the one thing jsdom cannot see, since it has no
// layout and so no idea what covers what. Declared here rather than pulling in
// @types/node for a single call.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}
