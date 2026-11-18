// Types for demo/chain.mjs (plain JS so the dashboard server needs no build step).
export interface ChainView {
  state(): Promise<Record<string, any>>;
}
export function createChainView(env?: Record<string, string | undefined>): Promise<ChainView>;
