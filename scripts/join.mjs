// Entry point for `npm run join`. Plain JavaScript so it can explain an old Node.js version instead of crashing on
// TypeScript syntax; the real work is in join-provider.ts.
import { existsSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`AgentSettle needs Node.js 22.18 or newer; this is ${process.versions.node}.`);
  console.error('Install the current LTS from https://nodejs.org (or with nvm: nvm install --lts), then run npm run join again.');
  process.exit(1);
}
if (!existsSync(new URL('../node_modules/viem', import.meta.url))) {
  console.error('Dependencies are missing. Run npm install first, then npm run join.');
  process.exit(1);
}
await import('./join-provider.ts');
