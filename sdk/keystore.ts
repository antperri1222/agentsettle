import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex, concat, hexToBytes, keccak256, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export function keystorePath(name: string): string {
  if (!/^[\w-]{1,64}$/.test(name)) throw new Error(`Invalid keystore name "${name}"`);
  return join(homedir(), '.foundry', 'keystores', name);
}

/**
 * Loads a signer from an encrypted Foundry keystore (~/.foundry/keystores/<name>) by asking `cast` to decrypt it.
 * `cast` prompts for the password on the terminal. The private key exists only in this process's memory: it is
 * never written to disk, logged, or placed in the environment. Use for interactive scripts.
 */
export function loadKeystoreAccount(name: string): PrivateKeyAccount {
  const file = keystorePath(name);
  if (!existsSync(file)) throw new Error(`Keystore not found: ${file}. Create it with: cast wallet new ~/.foundry/keystores ${name}`);
  const cast = [process.env.CAST_BIN, join(homedir(), '.foundry', 'bin', 'cast')].find((p) => p && existsSync(p)) ?? 'cast';
  process.stderr.write(`Unlocking keystore "${name}"…\n`);
  const r = spawnSync(cast, ['wallet', 'private-key', '--account', name], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Could not unlock keystore "${name}" (wrong password?)`);
  const key = r.stdout.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`Unexpected output while unlocking "${name}"`);
  return privateKeyToAccount(key as `0x${string}`);
}

/**
 * Decrypts a Web3 Secret Storage v3 keystore (the format Foundry/cast writes) in-process.
 * Supports scrypt and pbkdf2 KDFs with aes-128-ctr. Throws on a wrong password (MAC mismatch).
 */
export function decryptKeystoreJson(json: string, password: string): `0x${string}` {
  const ks = JSON.parse(json);
  const c = ks.crypto ?? ks.Crypto;
  if (!c || ks.version !== 3) throw new Error('Unsupported keystore format (expected version 3)');
  if (c.cipher !== 'aes-128-ctr') throw new Error(`Unsupported cipher ${c.cipher}`);
  const p = c.kdfparams;
  const salt = Buffer.from(p.salt, 'hex');
  let derived: Buffer;
  if (c.kdf === 'scrypt') {
    derived = scryptSync(Buffer.from(password.normalize('NFKC')), salt, p.dklen, { N: p.n, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 });
  } else if (c.kdf === 'pbkdf2') {
    if (p.prf !== 'hmac-sha256') throw new Error(`Unsupported pbkdf2 prf ${p.prf}`);
    derived = pbkdf2Sync(Buffer.from(password.normalize('NFKC')), salt, p.c, p.dklen, 'sha256');
  } else throw new Error(`Unsupported kdf ${c.kdf}`);
  const ciphertext = Buffer.from(c.ciphertext, 'hex');
  const mac = hexToBytes(keccak256(concat([derived.subarray(16, 32), ciphertext])));
  const expected = Buffer.from(c.mac, 'hex');
  if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(mac), expected)) throw new Error('Wrong keystore password');
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32) throw new Error('Unexpected private key length');
  return bytesToHex(key);
}

/**
 * Non-interactive unlock for long-running agent processes (e.g. the MCP server), which cannot prompt because
 * stdin/stdout carry the protocol. The password is read from a file that must be private to the user (mode 600).
 */
export function loadKeystoreWithPasswordFile(keystoreFile: string, passwordFile: string): PrivateKeyAccount {
  if (!existsSync(keystoreFile)) throw new Error(`Keystore not found: ${keystoreFile}`);
  if (!existsSync(passwordFile)) throw new Error(`Password file not found: ${passwordFile}`);
  const mode = statSync(passwordFile).mode & 0o077;
  if (process.platform !== 'win32' && mode !== 0) {
    throw new Error(`Password file ${passwordFile} is readable by other users; run: chmod 600 "${passwordFile}"`);
  }
  const password = readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, '');
  return privateKeyToAccount(decryptKeystoreJson(readFileSync(keystoreFile, 'utf8'), password));
}

/**
 * Encrypts a private key as a Web3 Secret Storage v3 keystore (scrypt + aes-128-ctr), the same format Foundry/cast
 * reads and writes, so a wallet created here also works with `cast --account <name>`.
 */
export function encryptKeystoreJson(privateKey: Hex, password: string, kdf: { n: number; r: number; p: number } = { n: 8192, r: 8, p: 1 }): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = scryptSync(Buffer.from(password.normalize('NFKC')), salt, 32, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()]);
  const mac = keccak256(concat([derived.subarray(16, 32), ciphertext])).slice(2);
  return JSON.stringify({
    version: 3,
    id: randomUUID(),
    address: privateKeyToAccount(privateKey).address.slice(2).toLowerCase(),
    crypto: {
      cipher: 'aes-128-ctr', cipherparams: { iv: iv.toString('hex') }, ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt', kdfparams: { dklen: 32, n: kdf.n, r: kdf.r, p: kdf.p, salt: salt.toString('hex') }, mac,
    },
  });
}
