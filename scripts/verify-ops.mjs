// Operations flow check:  node scripts/verify-ops.mjs
// Starts a throw-away API (SQLite temp file, short timers) and walks the whole flow:
// customer -> cart -> UPI payment (processing/verification) -> order -> location-based dispatch ->
// admin assignment/change -> tracking -> delivered -> revenue + daily analytics.
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5101, BASE = `http://127.0.0.1:${PORT}/api`;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'rasoi-ops-'));
let pass = 0, failed = 0;
const ok = (c, label, extra = '') => { c ? pass++ : failed++; console.log(`${c ? '  PASS' : '  FAIL'}  ${label}${!c && extra ? '  -> ' + extra : ''}`); };
const call = async (method, p, { token, body } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(400); } return null; };

const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT, DB_TYPE: 'sqlite', SQLITE_FILE: path.join(tmp, 'ops.sqlite'), TRACK_STAGE_SECONDS: '2,8,8', PAY_PROCESSING_MS: '1000', PAY_VERIFY_MS: '1000',
    ADMIN_EMAIL: 'ops.admin@rasoi.test', ADMIN_PASSWORD: 'Admin#Ops123', AUTH_SECRET: 'ops-test-secret' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await sleep(250); }

try {
  const admin = (await call('POST', '/auth/admin-login', { body: { identifier: 'ops.admin@rasoi.test', password: 'Admin#Ops123' } })).data.token;
  const reg = await call('POST', '/auth/register', { body: { name: 'Priya', email: 'priya@example.com', phone: '9876543210', password: 'secret12' } });
  const cust = reg.data.token;
  ok(!!admin && !!cust, 'admin + customer signed in (JWT)');

  console.log('\n[Security]');
  for (const p of ['/admin/dashboard', '/admin/payments', '/admin/revenue/daily', '/admin/orders/live', '/admin/analytics', '/admin/delivery/zones']) {
    ok((await call('GET', p, { token: cust })).status === 403, `customer blocked from ${p}`);
    ok((await call('GET', p)).status === 401, `anonymous blocked from ${p}`);
  }

  console.log('\n[Zones + partners]');
  const zones = (await call('GET', '/admin/delivery/zones', { token: admin })).data;
  ok(zones.length >= 6 && zones.some((z) => z.name === 'Srivilliputhur'), `starting zones seeded (${zones.length})`);
  const zid = (n) => zones.find((z) => z.name === n).id;
  const mk = async (b) => (await call('POST', '/admin/partners', { token: admin, body: b })).data;
  const kumar = await mk({ name: 'Kumar', phone: '9000000001', vehicle: 'Bike', vehicleNo: 'TN 67 AB 1001', zoneId: zid('Srivilliputhur'), lat: 9.5150, lng: 77.6360 });
  const ravi = await mk({ name: 'Ravi', phone: '9000000002', vehicle: 'Scooter', vehicleNo: 'TN 67 CD 2002', zoneId: zid('Rajapalayam'), lat: 9.4528, lng: 77.5539 });
  const suresh = await mk({ name: 'Suresh', phone: '9000000003', vehicle: 'Bike', vehicleNo: 'TN 67 EF 3003', zoneId: zid('Sivakasi'), online: false });
  ok(kumar.id && ravi.id && suresh.id, 'three partners created with zone + coordinates');

  console.log('\n[Customer: cart -> checkout -> UPI payment]');
  const food = (await call('GET', '/foods')).data[0];
  const address = { name: 'Priya', phone: '9876543210', address: '12 Temple Street', city: 'Srivilliputhur', pincode: '626125' };
  const pay = await call('POST', '/payments', { token: cust, body: { paymentMethod: 'upi', items: [{ id: food.id, quantity: 2 }], address, upi: { vpa: 'priya@ybl', app: 'gpay' } } });
  ok(pay.status === 201 && pay.data.status === 'pending', 'payment initiated', JSON.stringify(pay.data));
  const adminPay0 = (await call('GET', '/admin/payments', { token: admin })).data;
  ok(adminPay0.payments.some((p) => p.id === pay.data.id && p.status === 'INITIATED'), 'admin sees payment as INITIATED');
  const conf = await call('POST', `/payments/${pay.data.id}/confirm`, { token: cust, body: { result: 'approve' } });
  ok(conf.data.status === 'processing' && conf.data.phase === 'processing', 'approve -> PROCESSING (not instant success)');
  const mid = (await call('GET', '/admin/payments', { token: admin })).data.payments.find((p) => p.id === pay.data.id);
  ok(mid.status === 'PROCESSING', 'admin sees PROCESSING live');
  await sleep(1300);
  const ver = (await call('GET', `/payments/${pay.data.id}`, { token: cust })).data;
  ok(ver.status === 'processing' && ver.phase === 'verifying', 'then verification phase');
  const done = await until(async () => { const r = (await call('GET', `/payments/${pay.data.id}`, { token: cust })).data; return r.status === 'success' ? r : null; });
  ok(done && done.order && done.transactionId, 'payment SUCCESS, order confirmed', JSON.stringify(done));
  const upiOrder = done.order;

  console.log('\n[Revenue is daily + from real data]');
  let dash = (await call('GET', '/admin/dashboard?range=today', { token: admin })).data;
  ok(dash.revenue.today === upiOrder.total, `today's revenue = paid UPI order (₹${dash.revenue.today})`);
  ok(dash.revenue.yesterday === 0 && dash.revenue.changePct === null, 'yesterday ₹0, no fake change %');
  ok(dash.daily.length === 7 && dash.daily.at(-1).date === dash.today, '7 daily buckets ending today');
  ok(dash.kpis.ordersToday === 1 && dash.kpis.pending + dash.kpis.preparing >= 1, 'order counted in today / live KPIs');
  ok(dash.payments.successful === 1 && dash.payments.successRate === 100, 'payment success rate computed');

  console.log('\n[Location-based dispatch]');
  const rec = (await call('GET', `/admin/delivery/recommendations/${upiOrder.id}`, { token: admin })).data;
  ok(rec.zone?.name === 'Srivilliputhur', 'customer location -> Srivilliputhur zone');
  ok(rec.recommended?.name === 'Kumar', `nearest available partner recommended: ${rec.recommended?.name} ${rec.recommended?.distanceKm} km`);
  const ravi_c = rec.candidates.find((c) => c.name === 'Ravi'), sur = rec.candidates.find((c) => c.name === 'Suresh');
  ok(ravi_c.distanceKm > rec.recommended.distanceKm, `Ravi further away (${ravi_c.distanceKm} km)`);
  ok(sur.status === 'offline' && !sur.eligible, 'offline partner not eligible');
  ok(rec.candidates[0].name === 'Kumar' && rec.candidates.at(-1).name === 'Suresh', 'ranked by distance, ineligible last');

  const a1 = await call('POST', `/admin/orders/${upiOrder.id}/assign-partner`, { token: admin, body: { partnerId: ravi.id } });
  ok(a1.status === 200 && a1.data.partner?.name === 'Ravi', 'admin manually overrides recommendation (Ravi)');
  const a2 = await call('POST', `/admin/orders/${upiOrder.id}/assign-partner`, { token: admin, body: { partnerId: kumar.id } });
  ok(a2.data.partner?.name === 'Kumar', 'admin changes partner again (Kumar)');
  ok((await call('POST', `/admin/orders/${upiOrder.id}/assign-partner`, { token: admin, body: { partnerId: suresh.id } })).status === 409, 'cannot assign an offline partner');

  console.log('\n[COD order, auto-assignment, live board]');
  const cod = (await call('POST', '/orders', { token: cust, body: { paymentMethod: 'cod', items: [{ id: food.id, quantity: 1 }], address: { ...address, address: '4 Market Road' } } })).data;
  ok(cod.id && cod.paymentStatus === 'pay_on_delivery', 'COD order placed');
  const board = (await call('GET', '/admin/orders/live', { token: admin })).data;
  ok(Object.keys(board.board).join() === 'NEW,PREPARING,READY_FOR_PICKUP,OUT_FOR_DELIVERY,DELIVERED,CANCELLED', 'live board has the 6 columns');
  const row = Object.values(board.board).flat().find((o) => o.id === cod.id);
  ok(row && row.customer === 'Priya' && row.phone && row.zone === 'Srivilliputhur' && row.total === cod.total, 'row carries customer, phone, zone, amount');
  dash = (await call('GET', '/admin/dashboard', { token: admin })).data;
  ok(dash.revenue.today === upiOrder.total, 'COD not counted as revenue until cash is collected');

  console.log('\n[Customer tracking]');
  const outOrder = await until(async () => { const o = (await call('GET', `/orders/${upiOrder.id}`, { token: cust })).data; return o.stage === 2 ? o : null; }, 30000);
  ok(outOrder && outOrder.partner?.name === 'Kumar', 'order goes out for delivery with the admin-chosen partner');
  ok(outOrder.tracking.subStage.match(/out_for_delivery|arriving_soon/) && outOrder.tracking.partner?.source === 'estimated', 'tracking says position is ESTIMATED (no GPS feed)');
  ok(outOrder.tracking.distanceKm >= 0 && outOrder.tracking.etaMinutes >= 0 && outOrder.tracking.kitchen && outOrder.tracking.customer, 'distance, ETA, kitchen + customer points present');
  const g = await call('POST', `/admin/delivery/partners/${kumar.id}/location`, { token: admin, body: { lat: 9.5140, lng: 77.6350 } });
  const gpsOrder = (await call('GET', `/orders/${upiOrder.id}`, { token: cust })).data;
  ok(g.status === 200 && gpsOrder.tracking.partner.source === 'gps', 'real GPS report switches tracking source to gps');

  const codRow = await until(async () => { const o = (await call('GET', `/orders/${cod.id}`, { token: cust })).data; return o.stage >= 1 ? o : null; });
  ok(codRow, 'COD order progressed (preparing)');
  const codDone = await until(async () => { const o = (await call('GET', `/orders/${cod.id}`, { token: cust })).data; return o.stage === 3 ? o : null; }, 40000);
  ok(codDone && codDone.partner?.name && codDone.partner.assignedBy === 'system', `unassigned order auto-assigned to recommended partner (${codDone?.partner?.name})`);
  const upiDone = await until(async () => { const o = (await call('GET', `/orders/${upiOrder.id}`, { token: cust })).data; return o.stage === 3 ? o : null; }, 30000);
  ok(upiDone, 'UPI order delivered');

  console.log('\n[Delivered -> revenue + analytics updated]');
  dash = (await call('GET', '/admin/dashboard', { token: admin })).data;
  ok(dash.revenue.today === upiOrder.total + cod.total, `today's revenue now includes COD cash (₹${dash.revenue.today})`);
  ok(dash.kpis.deliveredToday === 2 && dash.kpis.live === 0, 'delivered today = 2, live = 0');
  const day = (await call('GET', `/admin/revenue/day/${dash.today}`, { token: admin })).data;
  ok(day.orders === 2 && day.delivered === 2 && day.revenue === dash.revenue.today && day.avgOrder > 0 && day.orderList.length === 2, 'day drill-down: revenue, orders, delivered, average, order list');
  const rng = (await call('GET', `/admin/revenue?from=${dash.today}&to=${dash.today}`, { token: admin })).data;
  ok(rng.total === day.revenue, 'custom date range total matches');
  const an = (await call('GET', '/admin/analytics?range=7d', { token: admin })).data;
  ok(an.orders.delivered === 2 && an.byChef.length >= 1 && an.byCategory.length >= 1 && an.delivery.avgMinutes !== null, 'analytics: orders, chef, category, delivery time');
  const pf = (await call('GET', '/admin/delivery/partners', { token: admin })).data;
  const k = pf.partners.find((p) => p.id === kumar.id);
  ok(k.completed >= 1 && k.deliveriesToday >= 1 && k.status === 'available', 'partner stats updated, partner free again');
  const detail = (await call('GET', `/admin/orders/${upiOrder.id}/detail`, { token: admin })).data;
  ok(detail.timeline.find((t) => t.key === 'delivered').done && detail.payment.transactionId && detail.items.length === 1, 'order drawer data: timeline, payment, items');

  console.log('\n[Payments: failure, cancel, refund]');
  const p2 = (await call('POST', '/payments', { token: cust, body: { paymentMethod: 'upi', items: [{ id: food.id, quantity: 1 }], address, upi: { vpa: 'priya@ybl', app: 'phonepe' } } })).data;
  await call('POST', `/payments/${p2.id}/confirm`, { token: cust, body: { result: 'decline' } });
  const p3 = (await call('POST', '/payments', { token: cust, body: { paymentMethod: 'upi', items: [{ id: food.id, quantity: 1 }], address, upi: { vpa: 'priya@ybl', app: 'phonepe' } } })).data;
  await call('POST', `/payments/${p3.id}/confirm`, { token: cust, body: { result: 'approve' } });
  const p3done = await until(async () => { const r = (await call('GET', `/payments/${p3.id}`, { token: cust })).data; return r.status === 'success' ? r : null; });
  const cancelled = await call('PATCH', `/admin/orders/${p3done.order.id}`, { token: admin, body: { status: 'cancelled' } });
  ok(cancelled.data.paymentStatus === 'refund_initiated', 'admin cancel of a paid order starts a refund');
  let pays = (await call('GET', '/admin/payments', { token: admin })).data;
  ok(pays.payments.find((p) => p.id === p2.id).status === 'FAILED', 'declined payment shows FAILED');
  ok(pays.payments.find((p) => p.id === p3.id).status === 'REFUND_INITIATED', 'cancelled paid payment shows REFUND_INITIATED');
  ok(pays.summary.failed === 1 && pays.summary.refundsPending === 1 && pays.summary.successRate !== null, `summary: failed=1, refund pending=1, success rate ${pays.summary.successRate}%`);
  ok((await call('POST', `/admin/payments/${p3.id}/refund-complete`, { token: admin })).status === 200, 'admin completes the refund');
  pays = (await call('GET', `/admin/payments/${p3.id}`, { token: admin })).data;
  ok(pays.status === 'REFUNDED' && pays.events.some((e) => e.status === 'refunded'), 'payment detail: REFUNDED with event log');
  dash = (await call('GET', '/admin/dashboard', { token: admin })).data;
  ok(dash.revenue.today === upiOrder.total + cod.total, 'refunded/cancelled order not counted in revenue');

  console.log('\n[Other admin views]');
  const cu = (await call('GET', '/admin/customers', { token: admin })).data;
  ok(cu.length === 1 && cu[0].totalOrders >= 3 && cu[0].favourite, 'customer table: orders, spend, favourite food');
  ok((await call('GET', `/admin/customers/${cu[0].id}`, { token: admin })).data.orders.length >= 3, 'customer detail');
  ok((await call('GET', '/admin/insights/chefs', { token: admin })).data.some((c) => c.ordersToday >= 1), 'chef performance');
  const nt = (await call('GET', '/admin/notifications', { token: admin })).data;
  ok(nt.items.length > 0 && nt.unread > 0, `notifications derived from events (${nt.unread} unread)`);
  await call('POST', '/admin/notifications/read', { token: admin });
  ok((await call('GET', '/admin/notifications', { token: admin })).data.unread === 0, 'mark all read');
  ok((await call('GET', '/admin/search?q=priya', { token: admin })).data.customers.length === 1, 'global search');
  const csv = await fetch(BASE + `/admin/reports/export?type=revenue&range=7d`, { headers: { Authorization: `Bearer ${admin}` } });
  ok(csv.ok && (await csv.text()).includes('Revenue (paid)'), 'CSV export');
} catch (e) {
  failed++; console.log('  ERROR', e);
} finally {
  server.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
  if (failed) console.log('\nServer log:\n' + log.slice(-1500));
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
