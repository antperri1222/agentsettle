import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoEngine, parseUsdc, formatUsdc } from '../engine.mjs';

const create = (engine, overrides = {}) => engine.createJob({ buyerId: 'buyer-agent', providerId: 'research-agent', task: 'Research AI agent payments with sources', amount: '5.00', idempotencyKey: crypto.randomUUID(), ...overrides });

test('USDC amounts preserve exact six-decimal units', () => {
  assert.equal(parseUsdc('1.123456'), 1123456n);
  assert.equal(formatUsdc(1123456n), '1.123456');
  assert.equal(formatUsdc(25000n), '0.025');
  assert.throws(() => parseUsdc('1.1234567'));
  assert.throws(() => parseUsdc('-1'));
  assert.throws(() => parseUsdc('0'));
});

test('happy path creates, delivers and releases payment exactly once', () => {
  const engine = new DemoEngine();
  const job = create(engine);
  assert.equal(job.status, 'FUNDED');
  assert.throws(() => engine.approve(job.id, { actorId: 'buyer-agent' }));
  engine.deliver(job.id, { actorId: 'research-agent', resultSummary: 'Report is complete. Three sources have been checked.' });
  assert.throws(() => engine.deliver(job.id, { actorId: 'research-agent', resultSummary: 'Trying again...' }));
  const paid = engine.approve(job.id, { actorId: 'buyer-agent' });
  assert.equal(paid.status, 'PAID');
  assert.equal(formatUsdc(paid.fee), '0.025');
  assert.equal(formatUsdc(paid.payout), '4.975');
  assert.throws(() => engine.approve(job.id, { actorId: 'buyer-agent' }));
});

test('prevents unauthorized delivery and unauthorized approval', () => {
  const engine = new DemoEngine();
  const job = create(engine);
  assert.throws(() => engine.deliver(job.id, { actorId: 'buyer-agent', resultSummary: 'Unauthorized report submission' }));
  engine.deliver(job.id, { actorId: 'research-agent', resultSummary: 'Authorized report submission' });
  assert.throws(() => engine.approve(job.id, { actorId: 'research-agent' }));
});

test('spending caps, allowlists, and idempotency enforce expected rules', () => {
  const engine = new DemoEngine();
  const key = crypto.randomUUID();
  const job = create(engine, { amount: '10', idempotencyKey: key });
  assert.equal(create(engine, { amount: '10', idempotencyKey: key }).id, job.id);
  assert.equal(engine.view().dailyAuthorized, '10');
  assert.throws(() => create(engine, { amount: '10.000001' }), /Per-job/);
});

test('daily authorization limit cannot be bypassed with multiple tasks', () => {
  const engine = new DemoEngine();
  create(engine, { amount: '10' });
  create(engine, { amount: '10' });
  assert.throws(() => create(engine, { amount: '6' }), /Daily/);
  create(engine, { amount: '5' });
  assert.equal(engine.view().dailyAuthorized, '25');
});

test('refund at deadline requires buyer and only when not delivered', () => {
  let now = Date.UTC(2026, 9, 8, 12);
  const engine = new DemoEngine({ now: () => now });
  const job = create(engine, { deliveryWindowHours: 1 });
  assert.throws(() => engine.refundExpired(job.id, { actorId: 'buyer-agent' }), /not passed/);
  now += 3_600_001;
  assert.throws(() => engine.refundExpired(job.id, { actorId: 'research-agent' }), /Unauthorized/);
  assert.equal(engine.refundExpired(job.id, { actorId: 'buyer-agent' }).status, 'REFUNDED');
});

test('dispute may only be resolved by arbiter', () => {
  const engine = new DemoEngine();
  const job = create(engine);
  engine.dispute(job.id, { actorId: 'buyer-agent' });
  assert.throws(() => engine.resolve(job.id, { actorId: 'buyer-agent', decision: 'pay' }), /Unauthorized/);
  assert.equal(engine.resolve(job.id, { actorId: 'arbiter', decision: 'refund' }).status, 'REFUNDED');
});

test('duplicate idempotency keys cannot alter job parameters', () => {
  const engine = new DemoEngine();
  const key = crypto.randomUUID();
  create(engine, { idempotencyKey: key });
  assert.throws(() => create(engine, { idempotencyKey: key, amount: '7.00' }), /different parameters/);
});


test('allowlist blocks registered providers that buyer has not approved', () => {
  const engine = new DemoEngine();
  engine.agents.set('unknown-provider', { id: 'unknown-provider', name: 'Not approved', dailyLimit: 0n, perJobLimit: 0n, allowlist: [] });
  assert.throws(() => create(engine, { providerId: 'unknown-provider' }), /allowlist/);
});

test('deadline is enforced for provider delivery', () => {
  let now = Date.UTC(2026, 9, 8, 12);
  const engine = new DemoEngine({ now: () => now });
  const job = create(engine, { deliveryWindowHours: 1 });
  now += 3_600_001;
  assert.throws(() => engine.deliver(job.id, { actorId: 'research-agent', resultSummary: 'Late delivery with required minimum length' }), /expired/);
});
