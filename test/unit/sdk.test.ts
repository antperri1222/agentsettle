import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_CHAIN_IDS, NETWORKS, getNetwork } from '../../sdk/networks.ts';
import { canonicalTerms, clientRefFromKey, formatUsdcUnits, hashTerms, parseUsdcUnits, type TaskTermsV1 } from '../../sdk/terms.ts';

const base: TaskTermsV1 = {
  version: 'agentsettle.terms.v1', chainId: 84532, escrow: '0xAbC0000000000000000000000000000000000001',
  provider: '0xDEF0000000000000000000000000000000000002', amountUnits: '5000000', deadline: 1_800_000_000,
  description: 'Research brief', acceptanceCriteria: ['a', 'b'],
};

test('no mainnet network is registered and lookups refuse unknown networks', () => {
  for (const n of Object.values(NETWORKS)) {
    assert.equal(n.isTestnet, true);
    assert.ok(!FORBIDDEN_CHAIN_IDS.has(n.chainId));
  }
  assert.throws(() => getNetwork('base'), /unsupported/i);
  assert.throws(() => getNetwork('mainnet'), /unsupported/i);
  assert.equal(NETWORKS['base-sepolia'].chainId, 84532);
  assert.equal(NETWORKS['base-sepolia'].usdcAddress, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  assert.equal(NETWORKS['base-sepolia'].allowsDevKeys, false);
});

test('terms hashing is canonical: key order and address case do not matter', () => {
  const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as TaskTermsV1;
  assert.equal(hashTerms(reordered), hashTerms(base));
  assert.equal(hashTerms({ ...base, provider: base.provider.toLowerCase() }), hashTerms(base));
  assert.notEqual(hashTerms({ ...base, amountUnits: '5000001' }), hashTerms(base));
  assert.ok(!/[:,] /.test(canonicalTerms(base)), 'no structural whitespace');
});

test('terms reject floats and non-integer amounts', () => {
  assert.throws(() => hashTerms({ ...base, amountUnits: '5.0' }), /base-unit/);
  assert.throws(() => hashTerms({ ...base, deadline: 1.5 }), /safe integers/);
});

test('USDC parsing is exact integer math', () => {
  assert.equal(parseUsdcUnits('4.975'), 4_975_000n);
  assert.equal(parseUsdcUnits('0.000001'), 1n);
  assert.equal(formatUsdcUnits(25_000n), '0.025');
  for (const bad of ['1e3', '0.1234567', '-1', '0', '01', '', ' 1']) assert.throws(() => parseUsdcUnits(bad));
});

test('clientRef is deterministic and validates keys', () => {
  assert.equal(clientRefFromKey('order-12345'), clientRefFromKey('order-12345'));
  assert.notEqual(clientRefFromKey('order-12345'), clientRefFromKey('order-12346'));
  assert.throws(() => clientRefFromKey('short'));
});

test('keystore: encrypt → decrypt round-trips; wrong password is rejected', async () => {
  const { encryptKeystoreJson, decryptKeystoreJson } = await import('../../sdk/keystore.ts');
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const json = encryptKeystoreJson(key, 'correct horse');
  assert.equal(JSON.parse(json).address, '70997970c51812dc3a010c7d01b50e0d17dc79c8');
  assert.equal(decryptKeystoreJson(json, 'correct horse'), key);
  assert.throws(() => decryptKeystoreJson(json, 'wrong'), /Wrong keystore password/);
});
