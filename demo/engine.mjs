import { createHash, randomUUID } from 'node:crypto';

const MICRO = 1_000_000n;

export function parseUsdc(amount) {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(amount)) {
    throw new Error('Amount must be a decimal USDC string with up to six decimal places');
  }
  const [whole, frac = ''] = amount.split('.');
  const units = BigInt(whole) * MICRO + BigInt(frac.padEnd(6, '0'));
  if (units <= 0n) throw new Error('Amount must be greater than zero');
  return units;
}

export function formatUsdc(units) {
  const v = BigInt(units);
  const whole = v / MICRO;
  const frac = String(v % MICRO).padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''}`;
}

function requireAgentId(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{2,39}$/.test(id)) throw new Error('Invalid agent ID');
}

// Educational in-memory simulator. NO private keys, real USDC, or blockchain transactions.
export class DemoEngine {
  constructor({ now = () => Date.now(), feeBps = 50 } = {}) {
    this.now = now;
    this.feeBps = feeBps;
    this.agents = new Map([
      ['buyer-agent', { id: 'buyer-agent', name: 'Alex / Procurement Agent', dailyLimit: 25n * MICRO, perJobLimit: 10n * MICRO, allowlist: ['research-agent', 'data-agent'] }],
      ['research-agent', { id: 'research-agent', name: 'Mira / Research Agent', dailyLimit: 0n, perJobLimit: 0n, allowlist: [] }],
      ['data-agent', { id: 'data-agent', name: 'Atlas / Data Agent', dailyLimit: 0n, perJobLimit: 0n, allowlist: [] }],
    ]);
    this.jobs = new Map();
    this.audit = [];
    this.idempotency = new Map();
    this.authorizedPerDay = new Map();
  }

  _day() { return new Date(this.now()).toISOString().slice(0, 10); }
  _event(type, job, detail = {}) {
    const event = { type, jobId: job.id, at: new Date(this.now()).toISOString(), ...detail };
    this.audit.unshift(event);
    return event;
  }
  _readJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found');
    return job;
  }
  _actor(actual, expected) {
    if (actual !== expected) throw new Error('Unauthorized actor for this operation');
  }
  _state(job, ...expected) {
    if (!expected.includes(job.status)) throw new Error(`Action not allowed from ${job.status} status`);
  }

  createJob({ buyerId = 'buyer-agent', providerId = 'research-agent', amount, task, idempotencyKey, deliveryWindowHours = 24 }) {
    requireAgentId(buyerId);
    requireAgentId(providerId);
    if (buyerId === providerId) throw new Error('Buyer and provider must differ');
    if (!this.agents.has(providerId) || !this.agents.has(buyerId)) throw new Error('Unknown agent');
    if (typeof task !== 'string' || task.trim().length < 10 || task.length > 500) throw new Error('Describe the task in 10-500 characters');
    if (!Number.isInteger(deliveryWindowHours) || deliveryWindowHours < 1 || deliveryWindowHours > 168) throw new Error('Delivery window must be 1-168 hours');
    if (typeof idempotencyKey !== 'string' || !/^[\w-]{8,100}$/.test(idempotencyKey)) throw new Error('Valid idempotency key required');
    if (this.idempotency.has(idempotencyKey)) {
      const existing = this._readJob(this.idempotency.get(idempotencyKey));
      const same = existing.buyerId === buyerId && existing.providerId === providerId && existing.amount === parseUsdc(amount) && existing.task === task.trim();
      if (!same) throw new Error('Idempotency key reused with different parameters');
      return existing;
    }
    const units = parseUsdc(amount);
    const buyer = this.agents.get(buyerId);
    if (!buyer.allowlist.includes(providerId)) throw new Error('Recipient not on spending allowlist');
    if (units > buyer.perJobLimit) throw new Error(`Per-job spending limit exceeded ($${formatUsdc(buyer.perJobLimit)})`);
    const spendKey = `${buyerId}:${this._day()}`;
    const used = this.authorizedPerDay.get(spendKey) ?? 0n;
    if (used + units > buyer.dailyLimit) throw new Error(`Daily spending limit exceeded ($${formatUsdc(buyer.dailyLimit)})`);
    this.authorizedPerDay.set(spendKey, used + units); // refunds do not erase authorization consumption
    const job = {
      id: randomUUID(), buyerId, providerId, amount: units, task: task.trim(), status: 'FUNDED',
      termsHash: createHash('sha256').update(task.trim()).digest('hex'),
      createdAt: new Date(this.now()).toISOString(),
      deliveryDeadline: new Date(this.now() + deliveryWindowHours * 3600_000).toISOString(),
      evidenceHash: null, deliveredAt: null, resultSummary: null,
      fee: 0n, payout: 0n,
    };
    this.jobs.set(job.id, job);
    this.idempotency.set(idempotencyKey, job.id);
    this._event('ESCROW_FUNDED', job, { amount: formatUsdc(units) });
    return job;
  }

  deliver(id, { actorId, resultSummary }) {
    const job = this._readJob(id);
    this._actor(actorId, job.providerId);
    this._state(job, 'FUNDED');
    if (this.now() > Date.parse(job.deliveryDeadline)) throw new Error('Delivery deadline has expired');
    if (typeof resultSummary !== 'string' || resultSummary.trim().length < 12 || resultSummary.length > 2000) throw new Error('Result summary must be 12-2000 characters');
    job.evidenceHash = createHash('sha256').update(resultSummary).digest('hex');
    job.resultSummary = resultSummary.trim();
    job.deliveredAt = new Date(this.now()).toISOString();
    job.status = 'DELIVERED';
    this._event('EVIDENCE_SUBMITTED', job, { evidenceHash: job.evidenceHash });
    return job;
  }

  approve(id, { actorId }) {
    const job = this._readJob(id);
    this._actor(actorId, job.buyerId);
    this._state(job, 'DELIVERED');
    return this._pay(job, 'BUYER_APPROVAL');
  }

  _pay(job, reason) {
    job.fee = (job.amount * BigInt(this.feeBps)) / 10_000n;
    job.payout = job.amount - job.fee;
    job.status = 'PAID';
    this._event('PAYMENT_RELEASED', job, { reason, providerPayout: formatUsdc(job.payout), protocolFee: formatUsdc(job.fee) });
    return job;
  }

  dispute(id, { actorId }) {
    const job = this._readJob(id);
    if (actorId !== job.buyerId && actorId !== job.providerId) throw new Error('Only the parties can dispute');
    this._state(job, 'FUNDED', 'DELIVERED');
    job.status = 'DISPUTED';
    this._event('DISPUTE_OPENED', job, { actorId });
    return job;
  }

  resolve(id, { actorId, decision }) {
    const job = this._readJob(id);
    this._actor(actorId, 'arbiter');
    this._state(job, 'DISPUTED');
    if (decision === 'pay') return this._pay(job, 'ARBITRATION');
    if (decision !== 'refund') throw new Error('Decision must be pay or refund');
    return this._refund(job, 'ARBITRATION');
  }

  _refund(job, reason) {
    job.status = 'REFUNDED';
    this._event('PAYMENT_REFUNDED', job, { reason, amount: formatUsdc(job.amount) });
    return job;
  }

  refundExpired(id, { actorId }) {
    const job = this._readJob(id);
    this._actor(actorId, job.buyerId);
    this._state(job, 'FUNDED');
    if (this.now() <= Date.parse(job.deliveryDeadline)) throw new Error('Delivery deadline has not passed');
    return this._refund(job, 'DELIVERY_EXPIRED');
  }

  providerRefund(id, { actorId }) {
    const job = this._readJob(id);
    this._actor(actorId, job.providerId);
    this._state(job, 'FUNDED', 'DELIVERED');
    return this._refund(job, 'VOLUNTARY_PROVIDER_REFUND');
  }

  view() {
    const jobView = (j) => ({ ...j, amount: formatUsdc(j.amount), payout: formatUsdc(j.payout), fee: formatUsdc(j.fee) });
    const agents = [...this.agents.values()].map(a => ({ id: a.id, name: a.name, dailyLimit: formatUsdc(a.dailyLimit), perJobLimit: formatUsdc(a.perJobLimit), allowlist: a.allowlist }));
    const todayKey = `buyer-agent:${this._day()}`;
    return { mode: 'SIMULATION_ONLY', feeBps: this.feeBps, dailyAuthorized: formatUsdc(this.authorizedPerDay.get(todayKey) ?? 0n), agents, jobs: [...this.jobs.values()].map(jobView).reverse(), audit: this.audit.slice(0, 100) };
  }
}
