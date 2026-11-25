import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const GUARDED = ['AGENTSETTLE_NETWORK', 'ESCROW_ADDRESS', 'ESCROW_DEPLOY_BLOCK'] as const;

/**
 * Refuses to run when the shell environment holds different deployment settings than the .env file. Node's
 * --env-file never overrides variables already in the environment, so a terminal where `.env` was once `source`d keeps
 * the OLD escrow address after a redeploy — and commands would silently target the old contract.
 */
export function assertEnvMatchesFile(envFile: string): void {
  if (!existsSync(envFile)) return;
  const file = parseEnv(readFileSync(envFile, 'utf8'));
  const stale = GUARDED.filter((k) => file[k] !== undefined && process.env[k] !== undefined && process.env[k] !== file[k]);
  if (!stale.length) return;
  const lines = stale.map((k) => `  ${k}: this terminal has ${process.env[k]}, ${envFile} has ${file[k]}`);
  throw new Error(`This terminal holds old settings that override .env:\n${lines.join('\n')}\nOpen a new terminal window, or run: unset ${stale.join(' ')}`);
}
