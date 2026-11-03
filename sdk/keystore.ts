import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/**
 * Loads a signer from an encrypted Foundry keystore (~/.foundry/keystores/<name>) by asking `cast` to decrypt it.
 * `cast` prompts for the password on the terminal (or reads ETH_PASSWORD). The private key exists only in this
 * process's memory: it is never written to disk, logged, or placed in the environment.
 */
export function loadKeystoreAccount(name: string): PrivateKeyAccount {
  if (!/^[\w-]{1,64}$/.test(name)) throw new Error(`Invalid keystore name "${name}"`);
  const file = join(homedir(), '.foundry', 'keystores', name);
  if (!existsSync(file)) throw new Error(`Keystore not found: ${file}. Create it with: cast wallet new ~/.foundry/keystores ${name}`);
  const cast = [process.env.CAST_BIN, join(homedir(), '.foundry', 'bin', 'cast')].find((p) => p && existsSync(p)) ?? 'cast';
  process.stderr.write(`Unlocking keystore "${name}"…\n`);
  const r = spawnSync(cast, ['wallet', 'private-key', '--account', name], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Could not unlock keystore "${name}" (wrong password?)`);
  const key = r.stdout.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`Unexpected output while unlocking "${name}"`);
  return privateKeyToAccount(key as `0x${string}`);
}
