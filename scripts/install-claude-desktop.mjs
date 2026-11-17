// Adds the AgentSettle buyer and provider MCP servers to Claude Desktop's config, safely:
// backs up the existing file, keeps every other setting and server, refuses to touch a file it cannot parse.
//
//   npm run mcp:install-desktop
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(repo, 'mcp', 'server.ts');
const configPath = process.env.CLAUDE_DESKTOP_CONFIG
  || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? homedir(), 'Claude', 'claude_desktop_config.json')
      : join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`✗ Node ${process.versions.node} is too old; the MCP server needs Node 22.18 or newer.`);
  process.exit(1);
}

let config = {};
if (existsSync(configPath)) {
  const raw = readFileSync(configPath, 'utf8');
  if (raw.trim()) {
    try { config = JSON.parse(raw); } catch (e) {
      console.error(`✗ ${configPath} is not valid JSON (${e.message}). Fix or remove it, then run this again. Nothing was changed.`);
      process.exit(1);
    }
  }
  const backup = `${configPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(configPath, backup);
  console.log(`Backed up existing config to:\n  ${backup}`);
} else {
  mkdirSync(dirname(configPath), { recursive: true });
}

if (typeof config !== 'object' || config === null || Array.isArray(config)) {
  console.error('✗ Unexpected config format; nothing was changed.');
  process.exit(1);
}
// Prefer a stable Node path: Homebrew's versioned Cellar path disappears on the next `brew upgrade node`.
let nodePath = process.execPath;
if (nodePath.includes('/Cellar/')) {
  const stable = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p));
  if (stable) nodePath = stable;
}

config.mcpServers ??= {};
for (const role of ['buyer', 'provider']) {
  config.mcpServers[`agentsettle-${role}`] = { command: nodePath, args: [serverPath], env: { AGENTSETTLE_ROLE: role } };
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`✓ Added agentsettle-buyer and agentsettle-provider to:\n  ${configPath}`);
console.log(`  (node: ${nodePath})`);

if ((process.env.AGENTSETTLE_NETWORK || '') === 'base-sepolia') {
  for (const role of ['buyer', 'provider']) {
    const pw = join(homedir(), '.agentsettle', `agentsettle-${role}-agent.password`);
    if (!existsSync(pw)) console.warn(`⚠ ${pw} is missing; run: npm run mcp:setup -- ${role}`);
  }
}
console.log('\nNext: fully quit Claude (Cmd+Q, not just closing the window) and open it again.');
