const el = (id) => document.getElementById(id);
let snapshot;
function usd(value) { return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function short(id) { return id.slice(0, 8); }
function message(text, isError = false) { const a = el('alert'); a.textContent = text; a.className = 'alert ' + (isError ? 'error' : 'ok'); }
async function request(path, payload) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  render(data);
}
function button(label, cb, className = 'secondary') {
  const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = label; b.addEventListener('click', cb); return b;
}
function cell(cls, text) { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; }
async function act(path, data, success) {
  try { await request(path, data); message(success); } catch (err) { message(err.message, true); }
}
function drawJob(j) {
  const box = document.createElement('div'); box.className = 'job';
  const header = document.createElement('div'); header.className = 'row';
  const title = document.createElement('div');
  const bold = document.createElement('strong'); bold.textContent = usd(j.amount) + ' USDC · ' + j.providerId; title.append(bold);
  title.append(cell('tiny muted', 'ID ' + short(j.id) + ' · ' + new Date(j.createdAt).toLocaleString()));
  header.append(title, cell('pill ' + j.status.toLowerCase(), j.status)); box.append(header);
  const desc = document.createElement('p'); desc.className = 'tiny'; desc.textContent = j.task; box.append(desc);
  if (j.evidenceHash) {
    const proof = document.createElement('details'); const sum = document.createElement('summary'); sum.textContent = 'View work evidence & hash';
    const p = document.createElement('p'); p.textContent = j.resultSummary;
    const hash = document.createElement('code'); hash.style.overflowWrap = 'anywhere'; hash.textContent = j.evidenceHash;
    proof.append(sum, p, hash); box.append(proof);
  }
  if (j.status === 'PAID') {
    const row = document.createElement('p'); row.className = 'tiny muted'; row.textContent = `Provider received ${usd(j.payout)} · protocol fee ${usd(j.fee)}`; box.append(row);
  }
  const actions = document.createElement('div'); actions.className = 'action-row';
  if (j.status === 'FUNDED') {
    actions.append(button('Simulate provider delivery', async () => {
      const summary = 'Delivered a structured competitor comparison covering pricing, identity, settlement and security controls. Includes data collection steps and a review checklist.';
      await act('/api/deliver', { id: j.id, actorId: j.providerId, resultSummary: summary }, 'Provider submitted evidence. Awaiting buyer approval.');
    }));
    actions.append(button('Open dispute', () => act('/api/dispute', { id: j.id, actorId: j.buyerId }, 'Escrow disputed.')));
    actions.append(button('Provider refund', () => act('/api/provider-refund', { id: j.id, actorId: j.providerId }, 'Escrow refunded.'), 'outline'));
    if (Date.now() > Date.parse(j.deliveryDeadline)) actions.append(button('Refund expired escrow', () => act('/api/refund-expired', { id: j.id, actorId: j.buyerId }, 'Expired escrow refunded.')));
  }
  if (j.status === 'DELIVERED') {
    actions.append(button('Buyer approves & pays', () => act('/api/approve', { id: j.id, actorId: j.buyerId }, 'Payment released to provider.')));
    actions.append(button('Dispute result', () => act('/api/dispute', { id: j.id, actorId: j.buyerId }, 'Dispute opened.'), 'outline'));
  }
  if (j.status === 'DISPUTED') {
    actions.append(button('Arbiter: pay provider', () => act('/api/resolve', { id: j.id, actorId: 'arbiter', decision: 'pay' }, 'Arbiter released payment.')));
    actions.append(button('Arbiter: refund buyer', () => act('/api/resolve', { id: j.id, actorId: 'arbiter', decision: 'refund' }, 'Arbiter refunded buyer.'), 'outline'));
  }
  if (actions.childNodes.length) box.append(actions);
  return box;
}
function render(data) {
  snapshot = data;
  const total = data.jobs.reduce((n, j) => n + Number(j.amount), 0);
  el('volume').textContent = usd(total);
  el('count').textContent = String(data.jobs.length);
  el('settled').textContent = String(data.jobs.filter(j => j.status === 'PAID').length);
  el('budget').textContent = usd(data.dailyAuthorized);
  const jobs = el('jobs'); jobs.replaceChildren();
  if (!data.jobs.length) jobs.append(cell('empty', 'No transactions yet. Create a job above.'));
  for (const job of data.jobs) jobs.append(drawJob(job));
  const timeline = el('timeline'); timeline.replaceChildren(); timeline.className = data.audit.length ? '' : 'empty';
  if (!data.audit.length) timeline.textContent = 'No events yet.';
  for (const evt of data.audit.slice(0, 12)) {
    const div = document.createElement('div'); div.className = 'log';
    const time = document.createElement('time'); time.textContent = new Date(evt.at).toLocaleTimeString();
    const text = document.createElement('span'); text.textContent = evt.type.replaceAll('_', ' ') + ' · ' + short(evt.jobId);
    div.append(time, text); timeline.append(div);
  }
}
el('newJob').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.currentTarget);
  await act('/api/jobs', { buyerId: 'buyer-agent', providerId: form.get('providerId'), amount: String(form.get('amount')), task: String(form.get('task')), idempotencyKey: crypto.randomUUID(), deliveryWindowHours: 24 }, 'Mock escrow funded. Ask provider to deliver.');
});
fetch('/api/state').then(r => r.json()).then(render).catch(e => message(e.message, true));
