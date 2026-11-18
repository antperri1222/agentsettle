// `npm run join` (outside developer becomes a provider) and `npm run owner -- onboard` (buyer lets them in), against a
// throwaway chain and relay. HOME and the .env path are redirected to a temp folder so nothing real is touched.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployLocal, startAnvil, type LocalDeployment } from '../../sdk/local.ts';
import { createRelay } from '../../relay/server.ts';

let anvil: ChildProcess;
let relay: Server;
let d: LocalDeployment;
let tmp: string;
let env: Record<string, string>;
const REPO = new URL('../..', import.meta.url).pathname;

// Async on purpose: the relay runs in this process, so a blocking spawnSync would starve it.
function run(script: string, args: string[] = [], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(REPO, script), ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
    p.stdin.end();
    p.on('close', (code) => resolve({ code, out }));
  });
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agentsettle-join-'));
  let rpcUrl: string;
  ({ proc: anvil, rpcUrl } = await startAnvil(20_000 + Math.floor(Math.random() * 20_000)));
  d = await deployLocal(rpcUrl);
  relay = createRelay({ network: 'anvil', rpcUrl, escrow: d.escrow, dataDir: join(tmp, 'relay') });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  const a = relay.address();
  const relayUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  writeFileSync(join(tmp, 'deployment.json'), JSON.stringify({
    network: 'anvil', chainId: 31337, escrow: d.escrow, deployBlock: Number(d.deployBlock), usdc: d.token, relayUrl, rpcUrl,
    hiringBuyer: { label: 'Anthony', owner: d.roles.owner, agent: d.roles.buyerAgent },
  }));
  writeFileSync(join(tmp, 'local.json'), JSON.stringify(d));
  mkdirSync(join(tmp, 'home'));
  env = {
    PATH: process.env.PATH ?? '', HOME: join(tmp, 'home'), CAST_BIN: process.env.CAST_BIN ?? '',
    AGENTSETTLE_DEPLOYMENT_FILE: join(tmp, 'deployment.json'), AGENTSETTLE_ENV_FILE: join(tmp, 'provider.env'),
  };
});

after(() => { relay?.close(); anvil?.kill(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('join creates a private, cast-compatible provider wallet and .env, then reports what is missing', async () => {
  const r = await run('scripts/join.mjs');
  assert.equal(r.code, 0, r.out);
  const address = /created wallet (0x[0-9a-fA-F]{40})/.exec(r.out)?.[1];
  assert.ok(address, r.out);
  assert.match(r.out, /relay .* is up/);
  assert.match(r.out, /escrow verified/);
  assert.match(r.out, /no ETH for transaction fees/);
  assert.match(r.out, /Anthony hasn't allowlisted you/);
  assert.match(r.out, new RegExp(`Not ready yet[\\s\\S]*${address}`));

  const ks = join(tmp, 'home', '.foundry', 'keystores', 'agentsettle-provider-agent');
  const pw = join(tmp, 'home', '.agentsettle', 'agentsettle-provider-agent.password');
  assert.equal(statSync(ks).mode & 0o077, 0, 'keystore private');
  assert.equal(statSync(pw).mode & 0o077, 0, 'password file private');
  const envText = readFileSync(join(tmp, 'provider.env'), 'utf8');
  assert.match(envText, new RegExp(`PROVIDER_AGENT_ADDRESS=${address}`));
  assert.match(envText, /AGENTSETTLE_RELAY_URL=http:\/\/127\.0\.0\.1:/);
  assert.match(r.out, /claude mcp add agentsettle-provider --scope user -e AGENTSETTLE_ROLE=provider --/);
  assert.match(r.out, /codex mcp add agentsettle-provider --env AGENTSETTLE_ROLE=provider --env AGENTSETTLE_CONFIRM_TIMEOUT_MS=45000 --/, 'Codex: answer before its 60 s tool timeout');

  const cast = [process.env.CAST_BIN, join(homedir(), '.foundry', 'bin', 'cast')].find((p) => p && existsSync(p));
  if (cast) {
    const c = spawnSync(cast, ['wallet', 'address', '--keystore', ks, '--password', readFileSync(pw, 'utf8')], { encoding: 'utf8' });
    assert.equal(c.stdout.trim(), address, 'cast reads the keystore and derives the same address');
  }
});

test('owner onboard allowlists the provider and tops up gas; join then reports ready with the same wallet', async () => {
  const address = /PROVIDER_AGENT_ADDRESS=(0x[0-9a-fA-F]{40})/.exec(readFileSync(join(tmp, 'provider.env'), 'utf8'))![1];
  const ownerEnv = { AGENTSETTLE_NETWORK: 'anvil', AGENTSETTLE_LOCAL_FILE: join(tmp, 'local.json') };
  assert.match((await run('scripts/owner.ts', ['onboard', address, '0.02'], ownerEnv)).out, /Refusing to send more than 0\.01 ETH/);
  const o = await run('scripts/owner.ts', ['onboard', address], ownerEnv);
  assert.equal(o.code, 0, o.out);
  assert.match(o.out, /allowlisted/);
  assert.match(o.out, /sent 0\.0005 ETH/);
  assert.match((await run('scripts/owner.ts', ['onboard', address], ownerEnv)).out, /already allowlisted[\s\S]*already has 0\.0005 ETH/, 'idempotent');

  const r = await run('scripts/join.mjs');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`existing wallet ${address}`));
  assert.match(r.out, /buyer agent is allowed to hire you/);
  assert.match(r.out, /Ready\./);
  const envText = readFileSync(join(tmp, 'provider.env'), 'utf8');
  assert.equal(envText.match(/PROVIDER_AGENT_ADDRESS=/g)?.length, 1, 'rerun does not duplicate settings');
});

test('join refuses to touch a buyer/owner .env', async () => {
  const ownerEnvFile = join(tmp, 'owner.env');
  writeFileSync(ownerEnvFile, 'OWNER_ADDRESS=0x0000000000000000000000000000000000000001\n');
  const r = await run('scripts/join.mjs', [], { AGENTSETTLE_ENV_FILE: ownerEnvFile });
  assert.equal(r.code, 1);
  assert.match(r.out, /belongs to a buyer\/owner setup/);
  assert.equal(readFileSync(ownerEnvFile, 'utf8'), 'OWNER_ADDRESS=0x0000000000000000000000000000000000000001\n');
});
