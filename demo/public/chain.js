// On-chain view + mode switching. Renders only data returned by GET /api/chain/state (indexed chain events).
(() => {
  const $ = (id) => document.getElementById(id);
  const MODE_KEY = 'agentsettle.mode';
  let timer = null;

  function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function link(href, text) {
    if (!href) return node('span', 'mono', text);
    const a = node('a', 'mono', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  const short = (h) => (h ? h.slice(0, 10) + '…' + h.slice(-6) : '');
  const eth = (wei) => { const v = Number(BigInt(wei)) / 1e18; return v === 0 ? '0' : v < 0.000001 ? v.toExponential(2) : v.toFixed(6); };

  function setMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('simView').hidden = mode !== 'sim';
    $('chainView').hidden = mode !== 'chain';
    clearInterval(timer);
    if (mode === 'chain') { load(); timer = setInterval(load, 2000); }
    else { const s = $('modeStatus'); s.className = 'status'; s.textContent = '● SIMULATION ONLY'; }
  }

  function role(data, addr) {
    if (!addr) return '';
    const r = data.roleLabels?.[addr.toLowerCase()];
    return r ? `${r} (${short(addr)})` : short(addr);
  }

  function finPill(job, ev) {
    const isTerminal = ev.type === 'PaymentReleased' || ev.type === 'JobRefunded';
    if (isTerminal && ev.finality === 'confirmed') return node('span', 'fin settled', 'SETTLED');
    return node('span', 'fin ' + ev.finality, ev.finality.toUpperCase());
  }

  function drawJob(data, j) {
    const box = node('div', 'job');
    const head = node('div', 'row');
    const title = node('div');
    title.append(node('strong', null, `Job #${j.id} · ${j.amount} USDC`));
    title.append(node('span', 'tiny muted', `buyer ${role(data, j.buyer)} → provider ${role(data, j.provider)}${j.agent ? ' · via agent ' + role(data, j.agent) : ''}${j.arbiter ? ' · arbiter ' + role(data, j.arbiter) : ''}`));
    head.append(title, node('span', 'pill ' + j.status.toLowerCase(), j.status.toUpperCase() + (j.settled ? ' ✓' : '')));
    box.append(head);
    if (j.status === 'Paid' && j.payout) box.append(node('p', 'tiny muted', `Provider received ${j.payout} · protocol fee ${j.fee}`));
    const terms = node('div', 'tiny muted'); terms.append('terms ', node('span', 'mono', short(j.termsHash)));
    if (j.evidenceHash) { terms.append(' · evidence ', node('span', 'mono', short(j.evidenceHash))); }
    terms.append(` · deadline ${new Date(Number(j.deadline) * 1000).toLocaleString()}`);
    box.append(terms);
    for (const ev of j.events) {
      const row = node('div', 'evt');
      row.append(finPill(j, ev), node('span', null, ev.type), link(ev.explorerUrl, short(ev.txHash)));
      const meta = node('span', 'meta',
        `block ${ev.blockNumber} · ${ev.confirmations} conf · signer ${role(data, ev.from)} · gas ${ev.gasUsed ?? '?'} (${ev.gasCostWei ? eth(ev.gasCostWei) + ' ETH' : '?'})`);
      row.append(meta);
      box.append(row);
    }
    box.append(node('p', 'tiny muted', `Total gas for this job: ${eth(j.totalGasCostWei)} ETH`));
    return box;
  }

  function render(data) {
    const status = $('modeStatus');
    if (!data.enabled) {
      status.className = 'status chain'; status.textContent = '● CHAIN NOT CONNECTED';
      $('chainOn').hidden = true; $('chainOff').hidden = false; $('chainOff').textContent = data.reason;
      $('chainBadge').textContent = 'Not connected';
      return;
    }
    status.className = 'status ' + (data.mode === 'TESTNET' ? 'testnet' : 'chain');
    status.textContent = data.mode === 'TESTNET' ? '● BASE SEPOLIA TESTNET · NO REAL FUNDS' : '● LOCAL ANVIL · TEST TOKEN';
    const notices = [];
    if (data.sync?.syncing) notices.push(`Catching up on contract history: ${data.sync.percent}% (block ${data.sync.scannedThrough} of ${data.sync.head}). Jobs below may be incomplete until this reaches 100%.`);
    if (data.stale) notices.push('Showing last known state; RPC error: ' + data.error);
    $('chainOff').hidden = notices.length === 0;
    $('chainOff').textContent = notices.join(' ');
    $('chainOn').hidden = false;
    $('chainEyebrow').textContent = data.network.label;
    const secs = data.network.blockTimeMs ? ` (~${Math.round((data.network.confirmations * data.network.blockTimeMs) / 100) / 10}s)` : '';
    $('chainBadge').textContent = `chain ${data.network.chainId} · confirmed after ${data.network.confirmations} blocks${secs}`;
    $('cHead').textContent = `head block ${data.head} · polled ${new Date(data.polledAt).toLocaleTimeString()}${data.indexSource ? ` · index: ${data.indexSource}` : ''}`;
    $('cEscrowed').textContent = data.balances.escrowContract;
    $('cCount').textContent = String(data.jobs.length);
    $('cSettled').textContent = String(data.jobs.filter((j) => j.settled).length);
    $('cGas').textContent = eth(data.jobs.reduce((n, j) => n + BigInt(j.totalGasCostWei), 0n).toString());

    const jobs = $('cJobs'); jobs.replaceChildren();
    if (!data.jobs.length) { const e = node('div', 'empty'); e.append('No jobs yet. Run ', node('code', 'cmd', 'npm run agents:demo'), '.'); jobs.append(e); }
    for (const j of data.jobs) jobs.append(drawJob(data, j));

    const pol = $('cPolicy'); pol.replaceChildren(); pol.className = data.policy ? '' : 'empty';
    if (!data.policy) pol.textContent = 'No owner/agent pair configured.';
    else {
      const p = data.policy;
      const box = node('div', 'job');
      const h = node('div', 'row'); h.append(node('strong', null, 'buyerAgent ← owner'), node('span', 'pill ' + (p.active ? '' : 'disputed'), p.active ? 'ACTIVE' : 'INACTIVE')); box.append(h);
      for (const [k, v] of [['Per-job cap', p.perJobCap + ' USDC'], ['Daily cap', p.dailyCap + ' USDC'], ['Authorised today (UTC)', p.spentToday + ' USDC'],
        ['providerAgent allowlisted', p.providerAllowed == null ? 'n/a' : p.providerAllowed ? 'yes' : 'no'],
        ['Expires', p.expiresAt === '0' ? '—' : new Date(Number(p.expiresAt) * 1000).toLocaleString()]]) {
        const r = node('div', 'kv'); r.append(node('span', 'muted', k), node('b', null, v)); box.append(r);
      }
      pol.append(box);
    }
    const bal = $('cBalances'); bal.replaceChildren();
    for (const [k, v] of Object.entries(data.balances)) { const r = node('div', 'kv'); r.append(node('span', 'muted', k), node('b', null, v)); bal.append(r); }
    const c = $('cContracts'); c.replaceChildren();
    for (const [k, addr, url] of [['Escrow', data.escrow, data.escrowUrl], ['Token', data.token, data.tokenUrl]]) {
      const r = node('div', 'kv'); r.append(node('span', 'muted', k), link(url, addr)); c.append(r);
    }
  }

  async function load() {
    try { render(await (await fetch('/api/chain/state')).json()); }
    catch (e) { render({ enabled: false, reason: 'Dashboard server unreachable: ' + e.message }); }
  }

  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  let initial = 'sim';
  try { initial = localStorage.getItem(MODE_KEY) === 'chain' ? 'chain' : 'sim'; } catch {}
  setMode(initial);
})();
