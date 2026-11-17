// One-time setup for running an AgentSettle MCP server in Claude (Desktop or Code).
//
//   npm run mcp:setup -- buyer
//   npm run mcp:setup -- provider
//
// On Base Sepolia it asks for the agent keystore's password once, checks it actually unlocks the keystore, and saves
// it to ~/.agentsettle/<keystore>.password with permissions 600 so the MCP server can start without a terminal.
// That makes the agent key as safe as your Mac user account — fine for a testnet agent whose spending is capped
// on-chain by the owner's policy. Never do this for a key that holds real funds.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { decryptKeystoreJson, keystorePath } from '../sdk/keystore.ts';

const role = process.argv[2];
if (role !== 'buyer' && role !== 'provider') { console.error('Usage: npm run mcp:setup -- buyer|provider'); process.exit(1); }
const network = process.env.AGENTSETTLE_NETWORK || 'anvil';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverPath = join(repo, 'mcp', 'server.ts');

function askHidden(question: string): Promise<string> {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    (rl as any)._writeToOutput = (s: string) => { if (!muted) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); res(answer); });
    muted = true;
  });
}

const env: Record<string, string> = { AGENTSETTLE_ROLE: role };
if (network === 'base-sepolia') {
  const name = `agentsettle-${role}-agent`;
  const ks = keystorePath(name);
  if (!existsSync(ks)) { console.error(`Keystore ${ks} not found.`); process.exit(1); }
  const json = readFileSync(ks, 'utf8');
  const password = await askHidden(`Password for keystore "${name}": `);
  let address: string;
  try { address = privateKeyToAccount(decryptKeystoreJson(json, password)).address; }
  catch (e) { console.error(`✗ ${(e as Error).message}`); process.exit(1); }
  const expected = role === 'buyer' ? process.env.BUYER_AGENT_ADDRESS : process.env.PROVIDER_AGENT_ADDRESS;
  if (expected && expected.toLowerCase() !== address.toLowerCase()) { console.error(`✗ Keystore is ${address}, .env says ${expected}`); process.exit(1); }
  const dir = join(homedir(), '.agentsettle');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${name}.password`);
  writeFileSync(file, password, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`✓ Unlocked ${name} (${address}); password saved to ${file} (mode 600).`);
} else {
  console.log('Local Anvil: the MCP server uses the public Anvil dev key for this role; no password needed.');
}

const name = `agentsettle-${role}`;
const desktop = { mcpServers: { [name]: { command: process.execPath, args: [serverPath], env } } };
console.log(`\n── Claude Desktop ──\nSettings → Developer → Edit Config, then merge this into claude_desktop_config.json and restart Claude:\n`);
console.log(JSON.stringify(desktop, null, 2));
console.log(`\n── Claude Code ──\n`);
console.log(`claude mcp add ${name} ${Object.entries(env).map(([k, v]) => `-e ${k}=${v}`).join(' ')} -- "${process.execPath}" "${serverPath}"`);
console.log(`\nThe server reads the rest of its settings (network, escrow, RPC URL, addresses) from ${join(repo, '.env')}.`);
