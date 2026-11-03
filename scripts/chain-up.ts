// Starts a local Anvil chain, deploys MockUSDC (TEST ONLY) + AgentEscrow, and writes .agentsettle/local.json.
// Keeps Anvil running in the foreground; Ctrl-C stops it (state is discarded).
import { mkdirSync, writeFileSync } from 'node:fs';
import { deployLocal, startAnvil } from '../sdk/local.ts';

const port = Number(process.env.ANVIL_PORT || 8545);
const { proc, rpcUrl } = await startAnvil(port);
const d = await deployLocal(rpcUrl);
mkdirSync(new URL('../.agentsettle/', import.meta.url), { recursive: true });
writeFileSync(new URL('../.agentsettle/local.json', import.meta.url), JSON.stringify(d, null, 2));

console.log(`Anvil running at ${rpcUrl} (chain 31337)`);
console.log(`  MockUSDC (TEST ONLY): ${d.token}`);
console.log(`  AgentEscrow:          ${d.escrow}  (fee ${d.feeBps} bps)`);
console.log(`  owner ${d.roles.owner} funded with 100 mUSDC`);
console.log('Wrote .agentsettle/local.json. Next: `npm run dev` and `npm run agents:demo` in other terminals. Ctrl-C to stop.');

const stop = () => { proc.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
proc.on('exit', (code) => { console.error(`anvil exited (${code})`); process.exit(code ?? 1); });
