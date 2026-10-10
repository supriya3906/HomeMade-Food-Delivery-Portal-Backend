// Admin operations API (revenue, live orders, dispatch, payments, analytics, notifications ...).
// Mounted before routes/admin.js under /api/admin. Every route needs a valid JWT AND the admin role.
// All numbers are calculated from the orders / payments / users / reviews tables on each request.
import { Router } from 'express';
import { users, orders, payments, reviews, partners, zones, chefs as chefStore, foods as foodStore } from '../store.js';
import { requireAuth, requireAdmin } from '../auth.js';
import { allFoods, allChefs, getFood } from '../catalog.js';
import { syncOrder, moveToStage, opsStatus, subStage, liveTracking, readyAtMs, STAGE_SECONDS } from '../tracking.js';
import { recommend, assignPartner, partnerLoad, partnerStatus, partnerPosition, isOpen, orderGeo } from '../dispatch.js';
import { resolveCustomer, validPoint, haversineKm, round } from '../geo.js';
import { fail, clean } from '../orderService.js';
import { gateway } from '../paymentGateway.js';
import { autoAssign } from '../dispatch.js';
import { storeStatus } from '../store.js';

const router = Router();
router.use(requireAuth, requireAdmin);

// ---------- dates (business day = India time unless BUSINESS_TZ_OFFSET_MIN says otherwise) ----------
const OFFSET = Number(process.env.BUSINESS_TZ_OFFSET_MIN ?? 330) * 60000;
const dayKey = (v) => (v ? new Date(new Date(v).getTime() + OFFSET).toISOString().slice(0, 10) : null);
const todayKey = () => dayKey(Date.now());
const shift = (key, days) => new Date(new Date(`${key}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 400; d = shift(d, 1)) out.push(d); return out; };
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (k) => WD[new Date(`${k}T00:00:00Z`).getUTCDay()];
const isKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const parseRange = (q) => {
  const today = todayKey();
  const r = String(q.range || '7d');
  if (r === 'today') return { key: r, from: today, to: today, label: 'Today' };
  if (r === 'yesterday') return { key: r, from: shift(today, -1), to: shift(today, -1), label: 'Yesterday' };
  if (r === '30d') return { key: r, from: shift(today, -29), to: today, label: 'Last 30 days' };
  if (r === 'month') return { key: r, from: `${today.slice(0, 8)}01`, to: today, label: 'This month' };
  if (r === 'custom') {
    if (!isKey(q.from) || !isKey(q.to) || q.from > q.to) throw fail(400, 'Choose a valid date range (from must not be after to).');
    return { key: r, from: q.from, to: q.to, label: `${q.from} to ${q.to}` };
  }
  return { key: '7d', from: shift(today, -6), to: today, label: 'Last 7 days' };
};

// ---------- data ----------
const METHOD = { upi: 'UPI', cod: 'Cash on delivery', card: 'Card' };
const getCtx = async () => {
  const [allOrders, allUsers, pay, partnerList, zoneList, reviewList] = await Promise.all([orders.all(), users.all(), payments.all(), partners.all(), zones.all(), reviews.all()]);
  const synced = [];
  for (const o of allOrders) synced.push(isOpen(o) || !o.stageTimes ? await syncOrder(o) : o); // finished orders never change by the clock
  const ctx = { orders: synced, users: allUsers, payments: pay, partners: partnerList, zones: zoneList, reviews: reviewList };
  ctx.userById = new Map(allUsers.map((u) => [u.id, u]));
  ctx.orderById = new Map(synced.map((o) => [o.id, o]));
  ctx.load = partnerLoad(synced);
  return ctx;
};

const live = (o) => o.status !== 'cancelled';
const deliveredAt = (o) => (live(o) && o.stage >= 3 ? o.stageTimes?.[3] : null);
const customerName = (o, ctx) => o.address?.name || ctx.userById.get(o.userId)?.name || '—';
const minutesBetween = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : null);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const pct = (a, b) => (b ? round((a / b) * 100, 1) : null);

// Money earned = orders actually PAID (UPI at payment, cash on delivery when delivered), by paid date. Cancelled/refunded orders are excluded.
const dayStats = (all, key) => {
  const placed = all.filter((o) => dayKey(o.placedAt) === key);
  const nonCancelled = placed.filter(live);
  const paid = all.filter((o) => live(o) && o.paymentStatus === 'paid' && dayKey(o.paidAt) === key);
  const revenue = paid.reduce((s, o) => s + (o.total || 0), 0);
  const booked = nonCancelled.reduce((s, o) => s + (o.total || 0), 0);
  return {
    date: key, label: dayLabel(key), revenue, paidOrders: paid.length, orderValue: booked, orders: placed.length,
    delivered: all.filter((o) => dayKey(deliveredAt(o)) === key).length,
    cancelled: all.filter((o) => o.status === 'cancelled' && dayKey(o.cancelledAt) === key).length,
    pending: nonCancelled.filter((o) => o.stage < 3).length,
    avgOrder: nonCancelled.length ? Math.round(booked / nonCancelled.length) : 0
  };
};
const series = (all, from, to) => daysBetween(from, to).map((k) => dayStats(all, k));

// ---------- payments (UPI rows + cash-on-delivery orders in one list) ----------
const payStatus = (p, order) => {
  if (order?.paymentStatus === 'refunded') return 'REFUNDED';
  if (order?.paymentStatus === 'refund_initiated') return 'REFUND_INITIATED';
  return ({ pending: 'INITIATED', processing: 'PROCESSING', success: 'SUCCESS', failed: 'FAILED', cancelled: 'CANCELLED' })[p.status] || 'INITIATED';
};
const paymentRows = (ctx) => {
  const rows = ctx.payments.map((p) => {
    const o = p.orderId ? ctx.orderById.get(p.orderId) : null;
    const status = payStatus(p, o);
    return { id: p.id, kind: 'gateway', orderId: p.orderId || null, customer: ctx.userById.get(p.userId)?.name || '—', userId: p.userId, amount: p.amount,
      method: 'UPI', methodId: 'upi', transactionId: p.transactionId || null, status, time: p.paidAt || p.createdAt, createdAt: p.createdAt,
      refundStatus: status === 'REFUNDED' ? 'refunded' : status === 'REFUND_INITIATED' ? 'initiated' : 'none', reason: p.reason || null };
  });
  for (const o of ctx.orders.filter((x) => x.paymentMethod === 'cod')) {
    const status = o.status === 'cancelled' ? 'CANCELLED' : o.paymentStatus === 'paid' ? 'SUCCESS' : 'INITIATED';
    rows.push({ id: `COD-${o.id}`, kind: 'cod', orderId: o.id, customer: customerName(o, ctx), userId: o.userId, amount: o.total, method: 'Cash on delivery', methodId: 'cod',
      transactionId: null, status, time: o.paidAt || o.placedAt, createdAt: o.placedAt, refundStatus: 'none', reason: status === 'INITIATED' ? 'Collect on delivery' : null });
  }
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
};
const paymentSummary = (rows, from, to) => {
  const inR = rows.filter((r) => { const k = dayKey(r.createdAt); return k >= from && k <= to; });
  const count = (f) => inR.filter(f).length;
  const online = inR.filter((r) => r.kind === 'gateway');
  const ok = online.filter((r) => ['SUCCESS', 'REFUND_INITIATED', 'REFUNDED'].includes(r.status)).length;
  const failed = online.filter((r) => r.status === 'FAILED').length;
  const byMethod = {};
  for (const r of inR.filter((x) => !['FAILED', 'CANCELLED'].includes(x.status))) byMethod[r.method] = (byMethod[r.method] || 0) + 1;
  const totalM = Object.values(byMethod).reduce((s, n) => s + n, 0);
  return {
    successful: count((r) => r.status === 'SUCCESS'), failed: count((r) => r.status === 'FAILED'),
    pending: count((r) => ['INITIATED', 'PROCESSING'].includes(r.status)),
    refundsPending: rows.filter((r) => r.status === 'REFUND_INITIATED').length, refundsDone: count((r) => r.status === 'REFUNDED'),
    refundAmountPending: rows.filter((r) => r.status === 'REFUND_INITIATED').reduce((s, r) => s + r.amount, 0),
    cod: count((r) => r.methodId === 'cod'), upi: count((r) => r.methodId === 'upi'), card: count((r) => r.methodId === 'card'),
    successRate: online.length && ok + failed ? pct(ok, ok + failed) : null,
    methodShare: Object.entries(byMethod).map(([method, n]) => ({ method, count: n, percent: pct(n, totalM) })).sort((a, b) => b.count - a.count)
  };
};

// ---------- order summaries ----------
const placeOf = (o, ctx) => resolveCustomer(o.address, ctx.zones);
const summarize = (o, ctx) => {
  const sub = subStage(o);
  const etaMs = o.etaAt ? new Date(o.etaAt).getTime() : null;
  const open = isOpen(o);
  const loc = placeOf(o, ctx);
  return {
    id: o.id, opsStatus: opsStatus(o), subStage: sub, stage: o.stage, cancelled: o.status === 'cancelled',
    customer: customerName(o, ctx), phone: o.address?.phone || '', location: [o.address?.address, o.address?.city].filter(Boolean).join(', '),
    city: o.address?.city || '', zone: loc.zone?.name || null, locationSource: loc.source,
    chefs: (o.chefs || []).map((c) => c.name), items: (o.items || []).map((i) => `${i.quantity}× ${i.name}`),
    total: o.total, paymentMethod: o.paymentLabel || METHOD[o.paymentMethod], paymentMethodId: o.paymentMethod, paymentStatus: o.paymentStatus,
    partner: o.partner ? { id: o.partner.id || null, name: o.partner.name, phone: o.partner.phone, assignedBy: o.partner.assignedBy || null } : null,
    needsPartner: open && !o.partner, placedAt: o.placedAt, etaAt: o.etaAt,
    etaMinutes: open && etaMs ? Math.max(0, Math.ceil((etaMs - Date.now()) / 60000)) : null,
    delayed: open && !!etaMs && etaMs + 60000 < Date.now(),
    readyAt: o.stage === 1 && readyAtMs(o) ? new Date(readyAtMs(o)).toISOString() : null
  };
};

const initials = (n = '') => n.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const lineRevenue = (o) => (o.items || []).reduce((s, i) => s + i.price * i.quantity, 0);

// ---------- notifications & activity (derived from real records) ----------
const buildFeed = (ctx) => {
  const ev = [];
  for (const o of ctx.orders) {
    ev.push({ id: `order:${o.id}`, type: 'order_new', severity: 'info', at: o.placedAt, text: `New order #${o.id} from ${customerName(o, ctx)} (₹${o.total})`, orderId: o.id });
    if (o.partner?.assignedAt) ev.push({ id: `assign:${o.id}`, type: 'assigned', severity: 'info', at: o.partner.assignedAt, text: `Order #${o.id} assigned to ${o.partner.name}${o.partner.assignedBy === 'system' ? ' (auto)' : ''}`, orderId: o.id });
    if (o.stageTimes?.[1]) ev.push({ id: `accept:${o.id}`, type: 'accepted', severity: 'info', at: o.stageTimes[1], text: `${o.chefs?.[0]?.name || 'Chef'} started preparing order #${o.id}`, orderId: o.id });
    if (deliveredAt(o)) ev.push({ id: `done:${o.id}`, type: 'delivered', severity: 'info', at: o.stageTimes[3], text: `Order #${o.id} delivered`, orderId: o.id });
    if (o.status === 'cancelled') ev.push({ id: `cancel:${o.id}`, type: 'cancelled', severity: 'warn', at: o.cancelledAt || o.placedAt, text: `Order #${o.id} cancelled`, orderId: o.id });
    if (o.paymentStatus === 'refund_initiated') ev.push({ id: `refund:${o.id}`, type: 'refund', severity: 'warn', at: o.cancelledAt || o.placedAt, text: `Refund requested for order #${o.id} (₹${o.total})`, orderId: o.id });
  }
  for (const p of ctx.payments) {
    if (p.status === 'success') ev.push({ id: `pay:${p.id}`, type: 'payment_ok', severity: 'info', at: p.paidAt || p.createdAt, text: `Payment ₹${p.amount} successful (${p.transactionId})`, orderId: p.orderId });
    if (p.status === 'failed') ev.push({ id: `payfail:${p.id}`, type: 'payment_failed', severity: 'warn', at: p.createdAt, text: `Payment ₹${p.amount} failed — ${p.reason || 'declined'}`, orderId: p.orderId });
  }
  for (const u of ctx.users.filter((x) => x.role !== 'admin')) ev.push({ id: `user:${u.id}`, type: 'customer_new', severity: 'info', at: u.createdAt, text: `New customer registered: ${u.name}` });
  for (const o of ctx.orders.filter(isOpen)) {
    const s = summarize(o, ctx);
    if (s.delayed) ev.push({ id: `late:${o.id}`, type: 'delayed', severity: 'warn', at: o.etaAt, text: `Order #${o.id} is past its estimated delivery time`, orderId: o.id });
    if (o.stage === 1 && !o.partner && readyAtMs(o) && Date.now() >= readyAtMs(o)) ev.push({ id: `nopartner:${o.id}`, type: 'no_partner', severity: 'warn', at: new Date(readyAtMs(o)).toISOString(), text: `Order #${o.id} is ready but no delivery partner is available`, orderId: o.id });
  }
  return ev.filter((e) => e.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
};
const seenAt = (u) => u.preferences?.adminNotifSeenAt || null;
const notifications = (ctx, me, limit = 60) => {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const feed = buildFeed(ctx).filter((e) => new Date(e.at).getTime() >= cutoff && !['accepted', 'delivered', 'assigned'].includes(e.type));
  const seen = seenAt(me);
  const list = feed.slice(0, limit).map((e) => ({ ...e, unread: !seen || e.at > seen }));
  const open = ctx.orders.filter(isOpen).map((o) => summarize(o, ctx));
  return {
    items: list, unread: list.filter((n) => n.unread).length,
    counts: {
      pendingOrders: open.filter((o) => o.opsStatus === 'NEW').length,
      paymentIssues: ctx.payments.filter((p) => p.status === 'failed' && dayKey(p.createdAt) === todayKey()).length + ctx.orders.filter((o) => o.paymentStatus === 'refund_initiated').length,
      deliveryDelays: open.filter((o) => o.delayed || (o.needsPartner && o.opsStatus === 'READY_FOR_PICKUP')).length
    }
  };
};

// ====================================================================================
// DASHBOARD
// ====================================================================================
router.get('/dashboard', async (req, res) => {
  const ctx = await getCtx();
  const range = parseRange(req.query);
  const today = todayKey();
  const yesterday = shift(today, -1);
  const t = dayStats(ctx.orders, today);
  const y = dayStats(ctx.orders, yesterday);
  const sel = series(ctx.orders, range.from, range.to);
  const open = ctx.orders.filter(isOpen);
  const sums = open.map((o) => summarize(o, ctx));
  const count = (s) => sums.filter((x) => x.opsStatus === s).length;
  const customers = ctx.users.filter((u) => u.role !== 'admin');
  const foods = await allFoods({ includeHidden: true });
  const chefList = await allChefs();
  const activeChefIds = new Set(foods.filter((f) => f.available).map((f) => f.chefId));
  const pRows = paymentRows(ctx);
  const partnersView = ctx.partners.map((p) => {
    const pos = partnerPosition(p, ctx.zones);
    return { id: p.id, name: p.name, status: partnerStatus(p, ctx.load.get(p.id) || 0), lat: pos?.lat ?? null, lng: pos?.lng ?? null, positionSource: pos?.source || 'unknown', activeOrders: ctx.load.get(p.id) || 0 };
  });
  const sold = new Map();
  const chefSales = new Map();
  for (const o of ctx.orders.filter((x) => live(x) && x.placedAt && dayKey(x.placedAt) >= range.from && dayKey(x.placedAt) <= range.to)) {
    for (const i of o.items || []) {
      const a = sold.get(i.id) || { id: i.id, name: i.name, qty: 0, revenue: 0 }; a.qty += i.quantity; a.revenue += i.price * i.quantity; sold.set(i.id, a);
      const c = chefSales.get(i.chefId) || { id: i.chefId, name: i.chefName, orders: new Set(), revenue: 0 }; c.orders.add(o.id); c.revenue += i.price * i.quantity; chefSales.set(i.chefId, c);
    }
  }
  const feed = buildFeed(ctx);
  res.json({
    generatedAt: new Date().toISOString(), today, yesterday, range,
    revenue: {
      today: t.revenue, yesterday: y.revenue, changePct: y.revenue ? round(((t.revenue - y.revenue) / y.revenue) * 100, 1) : null,
      selected: sel.reduce((s, d) => s + d.revenue, 0), selectedOrders: sel.reduce((s, d) => s + d.orders, 0)
    },
    kpis: {
      ordersToday: t.orders, pending: count('NEW'), preparing: count('PREPARING'), ready: count('READY_FOR_PICKUP'), outForDelivery: count('OUT_FOR_DELIVERY'),
      deliveredToday: t.delivered, cancelledToday: t.cancelled, live: open.length,
      activePartners: partnersView.filter((p) => p.status !== 'offline').length, partnersTotal: partnersView.length,
      customers: customers.length, activeChefs: chefList.filter((c) => activeChefIds.has(c.id)).length, chefsTotal: chefList.length, avgOrderValue: t.avgOrder
    },
    daily: series(ctx.orders, shift(today, -6), today),
    selected: sel,
    payments: paymentSummary(pRows, today, today),
    topChefs: [...chefSales.values()].map((c) => ({ id: c.id, name: c.name, orders: c.orders.size, revenue: c.revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    topFoods: [...sold.values()].sort((a, b) => b.qty - a.qty).slice(0, 5),
    liveOrders: sums.sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt))).slice(0, 8),
    partners: partnersView, zones: ctx.zones.map((z) => ({ id: z.id, name: z.name, lat: z.lat, lng: z.lng, radiusKm: z.radiusKm })),
    mapOrders: open.map((o) => { const l = placeOf(o, ctx); return l.point ? { id: o.id, ...l.point, status: opsStatus(o) } : null; }).filter(Boolean),
    activity: feed.slice(0, 14),
    notifications: notifications(ctx, req.user, 6)
  });
});

// ====================================================================================
// REVENUE
// ====================================================================================
router.get('/revenue/daily', async (req, res) => {
  const ctx = await getCtx();
  const n = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const today = todayKey();
  res.json({ basis: 'Paid orders by payment date (cash on delivery counts once delivered). Cancelled and refunded orders are excluded.', days: series(ctx.orders, shift(today, -(n - 1)), today).reverse() });
});
router.get('/revenue/day/:date', async (req, res) => {
  if (!isKey(req.params.date)) throw fail(400, 'Use a date like 2026-10-06.');
  const ctx = await getCtx();
  const key = req.params.date;
  const placed = ctx.orders.filter((o) => dayKey(o.placedAt) === key);
  const paid = ctx.orders.filter((o) => live(o) && o.paymentStatus === 'paid' && dayKey(o.paidAt) === key);
  const byMethod = {};
  for (const o of paid) byMethod[o.paymentLabel] = (byMethod[o.paymentLabel] || 0) + o.total;
  res.json({ ...dayStats(ctx.orders, key), byMethod, orderList: [...new Map([...placed, ...paid].map((o) => [o.id, o])).values()].map((o) => summarize(o, ctx)) });
});
router.get('/revenue', async (req, res) => {
  const ctx = await getCtx();
  const range = isKey(req.query.from) && isKey(req.query.to) ? parseRange({ range: 'custom', from: req.query.from, to: req.query.to }) : parseRange(req.query);
  const days = series(ctx.orders, range.from, range.to);
  const orderCount = days.reduce((s, d) => s + d.orders, 0);
  res.json({ range, total: days.reduce((s, d) => s + d.revenue, 0), orders: orderCount, orderValue: days.reduce((s, d) => s + d.orderValue, 0), cancelled: days.reduce((s, d) => s + d.cancelled, 0), days });
});

// ====================================================================================
// LIVE ORDERS
// ====================================================================================
router.get('/orders/live', async (req, res) => {
  const ctx = await getCtx();
  const today = todayKey();
  const relevant = ctx.orders.filter((o) => isOpen(o) || dayKey(o.placedAt) === today || dayKey(deliveredAt(o)) === today || (o.status === 'cancelled' && dayKey(o.cancelledAt) === today));
  const board = { NEW: [], PREPARING: [], READY_FOR_PICKUP: [], OUT_FOR_DELIVERY: [], DELIVERED: [], CANCELLED: [] };
  for (const o of relevant) board[opsStatus(o)].push(summarize(o, ctx));
  for (const k of Object.keys(board)) board[k].sort((a, b) => String(b.placedAt).localeCompare(String(a.placedAt)));
  res.json({ serverTime: new Date().toISOString(), board, counts: Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])), autoAssign });
});

// Order management table: every order, filterable. (GET /orders/live is the board; this is the searchable list.)
router.get('/orders/list', async (req, res) => {
  const ctx = await getCtx();
  const q = clean(req.query.q).toLowerCase();
  const range = isKey(req.query.from) && isKey(req.query.to) ? { from: req.query.from, to: req.query.to } : { from: '0000-01-01', to: '9999-12-31' };
  const list = ctx.orders.map((o) => summarize(o, ctx)).filter((o) => (!req.query.status || o.opsStatus === req.query.status)
    && (!req.query.payment || o.paymentStatus === req.query.payment) && dayKey(o.placedAt) >= range.from && dayKey(o.placedAt) <= range.to
    && (!q || [o.id, o.customer, o.phone, o.zone, o.partner?.name, ...o.chefs].some((v) => String(v || '').toLowerCase().includes(q))));
  res.json({ total: list.length, orders: list.slice(0, 300) });
});

router.get('/orders/:id/detail', async (req, res) => {
  const ctx = await getCtx();
  const o = ctx.orderById.get(req.params.id);
  if (!o) throw fail(404, 'Order not found.');
  const user = ctx.userById.get(o.userId);
  const pay = ctx.payments.find((p) => p.orderId === o.id);
  const tr = await liveTracking(o);
  const ready = readyAtMs(o);
  const T = o.stageTimes || [];
  const timeline = [
    { key: 'placed', label: 'Order placed', at: o.placedAt },
    { key: 'payment', label: o.paymentMethod === 'cod' ? 'Payment: cash on delivery' : 'Payment confirmed', at: o.paymentMethod === 'cod' ? null : o.paidAt, done: o.paymentMethod === 'cod' ? true : !!o.paidAt },
    { key: 'accepted', label: 'Chef accepted', at: T[1] },
    { key: 'preparing', label: 'Preparing', at: T[1] },
    { key: 'ready', label: 'Ready for pickup', at: o.stage >= 2 ? o.partner?.assignedAt || T[2] : ready && Date.now() >= ready ? new Date(ready).toISOString() : null },
    { key: 'assigned', label: 'Partner assigned', at: o.partner?.assignedAt || null },
    { key: 'picked', label: 'Picked up', at: T[2] },
    { key: 'out', label: 'Out for delivery', at: T[2] },
    { key: 'delivered', label: 'Delivered', at: o.status === 'cancelled' ? null : T[3] }
  ].map((s) => ({ ...s, done: s.done ?? !!s.at }));
  res.json({
    ...summarize(o, ctx), placedAt: o.placedAt, invoiceNo: o.invoiceNo,
    customerDetail: { id: o.userId, name: customerName(o, ctx), email: user?.email || '', phone: o.address?.phone || user?.phone || '', address: o.address },
    items: (o.items || []).map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, chef: i.chefName })),
    bill: { subtotal: o.subtotal, deliveryFee: o.deliveryFee, discount: o.discount, tax: o.tax, total: o.total },
    payment: { method: o.paymentLabel, amount: o.total, transactionId: o.transactionId || null, status: o.paymentStatus, paymentId: pay?.id || null, upiId: o.upiId || null, paidAt: o.paidAt },
    delivery: { partner: o.partner || null, tracking: tr },
    timeline, cancelledAt: o.cancelledAt || null,
    recommendation: isOpen(o) ? await recommend(o, { allOrders: ctx.orders, allPartners: ctx.partners, zones: ctx.zones }) : null
  });
});

// ====================================================================================
// DELIVERY: recommendation, assignment, partners, zones
// ====================================================================================
router.get('/delivery/recommendations/:orderId', async (req, res) => {
  const ctx = await getCtx();
  let o = ctx.orderById.get(req.params.orderId);
  if (!o) o = await orders.byId(req.params.orderId);
  if (!o) throw fail(404, 'Order not found.');
  res.json(await recommend(o, { allOrders: ctx.orders, allPartners: ctx.partners, zones: ctx.zones }));
});

router.post('/orders/:orderId/assign-partner', async (req, res) => {
  const o = await orders.byId(req.params.orderId);
  if (!o) throw fail(404, 'Order not found.');
  const cur = await syncOrder(o);
  if (cur.status === 'cancelled' || cur.stage >= 3) throw fail(400, 'This order is already finished.');
  let updated = await assignPartner(cur, clean(req.body.partnerId), `admin:${req.user.name}`);
  if (updated && updated.stage === 0) {
    updated = await moveToStage(updated, 1);
  }
  res.json(summarize(await syncOrder(updated), await getCtx()));
});

const partnerView = async (p, ctx) => {
  const mine = ctx.orders.filter((o) => o.partner?.id === p.id);
  const done = mine.filter((o) => live(o) && o.stage >= 3);
  const current = mine.find(isOpen);
  const rated = ctx.reviews.filter((r) => r.deliveryRating && mine.some((o) => o.id === r.id));
  const pos = partnerPosition(p, ctx.zones);
  const zone = ctx.zones.find((z) => z.id === p.zoneId);
  return {
    id: p.id, name: p.name, initials: initials(p.name), phone: p.phone || '', vehicle: p.vehicle || '', vehicleNo: p.vehicleNo || '', zoneId: p.zoneId || null, zone: zone?.name || null,
    area: p.area || zone?.name || '', lat: pos?.lat ?? null, lng: pos?.lng ?? null, positionSource: pos?.source || 'unknown', locationAt: p.locationAt || null,
    active: p.active !== false, online: p.online !== false, maxOrders: p.maxOrders || 2, activeOrders: ctx.load.get(p.id) || 0,
    status: partnerStatus(p, ctx.load.get(p.id) || 0), currentOrder: current ? summarize(current, ctx) : null,
    deliveriesToday: done.filter((o) => dayKey(o.stageTimes[3]) === todayKey()).length, completed: done.length,
    avgDeliveryMin: round(avg(done.map((o) => minutesBetween(o.placedAt, o.stageTimes[3])).filter((x) => x !== null)), 0),
    rating: rated.length ? round(avg(rated.map((r) => r.deliveryRating))) : null, ratings: rated.length
  };
};
router.get('/delivery/partners', async (req, res) => {
  const ctx = await getCtx();
  const list = await Promise.all(ctx.partners.map((p) => partnerView(p, ctx)));
  res.json({ partners: list, counts: { all: list.length, available: list.filter((p) => p.status === 'available').length, on_delivery: list.filter((p) => p.status === 'on_delivery').length, offline: list.filter((p) => p.status === 'offline').length } });
});
router.get('/delivery/partners/:id/history', async (req, res) => {
  const ctx = await getCtx();
  if (!ctx.partners.some((p) => p.id === req.params.id)) throw fail(404, 'Delivery partner not found.');
  res.json(ctx.orders.filter((o) => o.partner?.id === req.params.id).map((o) => ({ ...summarize(o, ctx), deliveredAt: deliveredAt(o), minutes: round(minutesBetween(o.placedAt, deliveredAt(o)), 0) })).slice(0, 100));
});
router.get('/delivery/partners/:id/route', async (req, res) => {
  const ctx = await getCtx();
  const o = ctx.orders.find((x) => x.partner?.id === req.params.id && isOpen(x));
  if (!o) return res.json({ order: null });
  res.json({ order: summarize(o, ctx), tracking: await liveTracking(o) });
});
// A partner app (or any GPS source) reports the real position here. Customers then see GPS instead of an estimate.
router.post('/delivery/partners/:id/location', async (req, res) => {
  const p = await partners.byId(req.params.id);
  if (!p) throw fail(404, 'Delivery partner not found.');
  const pt = validPoint(req.body.lat, req.body.lng);
  if (!pt) throw fail(400, 'Send a valid latitude and longitude.');
  await partners.update(p.id, { lat: pt.lat, lng: pt.lng, locationAt: new Date().toISOString() });
  res.json({ ok: true });
});

const zoneBody = (b, cur = {}) => {
  const z = {};
  if (!cur.id || 'name' in b) { z.name = clean(b.name).slice(0, 80); if (!z.name) throw fail(400, 'Zone name is required.'); }
  if (!cur.id || 'lat' in b || 'lng' in b) { const pt = validPoint(b.lat ?? cur.lat, b.lng ?? cur.lng); if (!pt) throw fail(400, 'Enter a valid latitude and longitude for the zone centre.'); z.lat = pt.lat; z.lng = pt.lng; }
  if ('radiusKm' in b) { const r = Number(b.radiusKm); if (!(r > 0 && r <= 100)) throw fail(400, 'Radius must be between 0 and 100 km.'); z.radiusKm = r; } else if (!cur.id) z.radiusKm = 8;
  if ('keywords' in b) z.keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',')).map((k) => clean(k).toLowerCase()).filter(Boolean).slice(0, 12);
  else if (!cur.id) z.keywords = [clean(b.name).toLowerCase()];
  if ('active' in b) z.active = !!b.active;
  return z;
};
router.get('/delivery/zones', async (req, res) => {
  const ctx = await getCtx();
  const today = todayKey();
  res.json(await Promise.all(ctx.zones.map(async (z) => {
    const inZone = ctx.orders.filter((o) => placeOf(o, ctx).zone?.id === z.id);
    const done = inZone.filter((o) => live(o) && o.stage >= 3);
    const zp = ctx.partners.filter((p) => p.zoneId === z.id);
    return { ...z, partners: zp.length, activePartners: zp.filter((p) => partnerStatus(p, ctx.load.get(p.id) || 0) !== 'offline').length,
      openOrders: inZone.filter(isOpen).length, ordersToday: inZone.filter((o) => dayKey(o.placedAt) === today).length,
      pendingOrders: inZone.filter((o) => isOpen(o) && !o.partner).length,
      avgDeliveryMin: round(avg(done.map((o) => minutesBetween(o.placedAt, o.stageTimes[3])).filter((x) => x !== null)), 0) };
  })));
});
router.post('/delivery/zones', async (req, res) => {
  const all = await zones.all();
  const id = `z${String(Math.max(0, ...all.map((z) => Number(String(z.id).replace(/\D/g, '')) || 0)) + 1).padStart(2, '0')}`;
  res.status(201).json(await zones.insert({ id, active: true, ...zoneBody(req.body) }));
});
router.patch('/delivery/zones/:id', async (req, res) => {
  const cur = await zones.byId(req.params.id);
  if (!cur) throw fail(404, 'Zone not found.');
  res.json(await zones.update(cur.id, zoneBody(req.body, cur)));
});
router.delete('/delivery/zones/:id', async (req, res) => {
  if (!(await zones.byId(req.params.id))) throw fail(404, 'Zone not found.');
  if ((await partners.all()).some((p) => p.zoneId === req.params.id)) throw fail(409, 'Partners are still assigned to this zone. Move them first.');
  await zones.remove(req.params.id);
  res.json({ ok: true });
});

// ====================================================================================
// PAYMENTS
// ====================================================================================
router.get('/payments', async (req, res) => {
  const ctx = await getCtx();
  const rows = paymentRows(ctx);
  const q = clean(req.query.q).toLowerCase();
  const range = isKey(req.query.from) && isKey(req.query.to) ? { from: req.query.from, to: req.query.to } : parseRange({ range: req.query.range || '30d' });
  const shown = rows.filter((r) => (!req.query.status || r.status === req.query.status) && (!req.query.method || r.methodId === req.query.method)
    && (!q || [r.id, r.orderId, r.customer, r.transactionId].some((v) => String(v || '').toLowerCase().includes(q)))
    && dayKey(r.createdAt) >= range.from && dayKey(r.createdAt) <= range.to);
  res.json({ summary: paymentSummary(rows, range.from, range.to), todaySummary: paymentSummary(rows, todayKey(), todayKey()), gateway: { name: gateway.label, live: gateway.live }, payments: shown.slice(0, 300) });
});
router.get('/payments/:id', async (req, res) => {
  const ctx = await getCtx();
  const row = paymentRows(ctx).find((r) => r.id === req.params.id);
  if (!row) throw fail(404, 'Payment not found.');
  const raw = ctx.payments.find((p) => p.id === row.id);
  const o = row.orderId ? ctx.orderById.get(row.orderId) : null;
  res.json({
    ...row, gateway: row.kind === 'gateway' ? { name: gateway.label, live: gateway.live } : null, upiId: raw?.vpa || o?.upiId || null, attempts: raw?.attempts || 0,
    expiresAt: raw?.expiresAt || null,
    events: raw?.events || [{ status: 'initiated', at: row.createdAt, note: 'Cash on delivery order placed' }, ...(row.status === 'SUCCESS' ? [{ status: 'success', at: row.time, note: 'Cash collected on delivery' }] : [])],
    order: o ? summarize(o, ctx) : null, customerEmail: ctx.userById.get(row.userId)?.email || ''
  });
});
router.post('/payments/:id/refund-complete', async (req, res) => {
  const ctx = await getCtx();
  const row = paymentRows(ctx).find((r) => r.id === req.params.id);
  if (!row) throw fail(404, 'Payment not found.');
  const o = row.orderId ? ctx.orderById.get(row.orderId) : null;
  if (!o || o.paymentStatus !== 'refund_initiated') throw fail(400, 'There is no pending refund for this payment.');
  await gateway.refund(row);
  await orders.update(o.id, { paymentStatus: 'refunded' });
  const raw = ctx.payments.find((p) => p.id === row.id);
  if (raw) await payments.update(raw.id, { events: [...(raw.events || []), { status: 'refunded', at: new Date().toISOString(), note: `Refund of ₹${row.amount} completed by ${req.user.name}` }] });
  res.json({ ok: true });
});

// ====================================================================================
// CUSTOMERS / CHEFS / FOODS insights
// ====================================================================================
const customerRows = (ctx) => {
  const today = todayKey();
  return ctx.users.filter((u) => u.role !== 'admin').map((u) => {
    const mine = ctx.orders.filter((o) => o.userId === u.id);
    const good = mine.filter(live);
    const qty = new Map();
    for (const o of good) for (const i of o.items || []) qty.set(i.name, (qty.get(i.name) || 0) + i.quantity);
    const last = mine[0];
    const spent = good.reduce((s, o) => s + (o.total || 0), 0);
    const daysSince = last ? (Date.now() - new Date(last.placedAt)) / 86400000 : null;
    const isNew = (Date.now() - new Date(u.createdAt)) / 86400000 <= 7;
    return {
      id: u.id, name: u.name, email: u.email, phone: u.phone || last?.address?.phone || '', location: u.city || last?.address?.city || '',
      totalOrders: mine.length, todayOrders: mine.filter((o) => dayKey(o.placedAt) === today).length, totalSpent: spent,
      lastOrder: last?.placedAt || null, avgOrder: good.length ? Math.round(spent / good.length) : 0,
      favourite: [...qty.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null, joinedAt: u.createdAt,
      status: daysSince !== null && daysSince <= 30 ? 'active' : 'inactive', isNew, highValue: spent >= 2000, frequent: good.length >= 5
    };
  });
};
router.get('/customers', async (req, res) => res.json(customerRows(await getCtx())));
router.get('/customers/:id', async (req, res) => {
  const ctx = await getCtx();
  const row = customerRows(ctx).find((c) => c.id === req.params.id);
  if (!row) throw fail(404, 'Customer not found.');
  const mine = ctx.orders.filter((o) => o.userId === row.id);
  const addresses = [...new Map(mine.map((o) => [`${o.address?.address}|${o.address?.pincode}`, o.address]).filter(([, a]) => a)).values()];
  res.json({
    ...row, user: { ...ctx.userById.get(row.id), hash: undefined, salt: undefined, preferences: undefined }, orders: mine.map((o) => summarize(o, ctx)), addresses,
    payments: paymentRows(ctx).filter((p) => p.userId === row.id),
    reviews: ctx.reviews.filter((r) => r.userId === row.id).map((r) => ({ ...r, items: (ctx.orderById.get(r.id)?.items || []).map((i) => i.name) })),
    activity: buildFeed(ctx).filter((e) => mine.some((o) => o.id === e.orderId)).slice(0, 15)
  });
});

const foodStats = (ctx, foods) => {
  const today = todayKey();
  const m = new Map(foods.map((f) => [f.id, { ordersToday: 0, qtyToday: 0, totalQty: 0, revenue: 0 }]));
  for (const o of ctx.orders.filter(live)) for (const i of o.items || []) {
    const s = m.get(i.id); if (!s) continue;
    s.totalQty += i.quantity; s.revenue += i.price * i.quantity;
    if (dayKey(o.placedAt) === today) { s.ordersToday += 1; s.qtyToday += i.quantity; }
  }
  return m;
};
router.get('/insights/foods', async (req, res) => {
  const ctx = await getCtx();
  const [foods, chefList] = await Promise.all([allFoods({ includeHidden: true }), allChefs()]);
  const stats = foodStats(ctx, foods);
  res.json(foods.map((f) => ({ id: f.id, chefName: chefList.find((c) => c.id === f.chefId)?.name || '', ...stats.get(f.id) })));
});
router.get('/insights/chefs', async (req, res) => {
  const ctx = await getCtx();
  const [foods, chefList] = await Promise.all([allFoods({ includeHidden: true }), allChefs()]);
  const today = todayKey();
  res.json(chefList.map((c) => {
    const mine = foods.filter((f) => f.chefId === c.id);
    const todays = ctx.orders.filter((o) => live(o) && dayKey(o.placedAt) === today && o.items?.some((i) => i.chefId === c.id));
    const all = ctx.orders.filter((o) => live(o) && o.items?.some((i) => i.chefId === c.id));
    return { id: c.id, name: c.name, city: c.city, cuisine: c.cuisine, rating: c.rating, activeDishes: mine.filter((f) => f.available).length, totalDishes: mine.length,
      ordersToday: todays.length, revenueToday: todays.reduce((s, o) => s + o.items.filter((i) => i.chefId === c.id).reduce((a, i) => a + i.price * i.quantity, 0), 0),
      totalOrders: all.length, totalRevenue: all.reduce((s, o) => s + o.items.filter((i) => i.chefId === c.id).reduce((a, i) => a + i.price * i.quantity, 0), 0),
      prepMinutes: mine.length ? Math.round(avg(mine.map((f) => f.prepMinutes || 20))) : null, available: mine.some((f) => f.available) };
  }));
});
router.get('/insights/chefs/:id', async (req, res) => {
  const ctx = await getCtx();
  const [foods, chefList] = await Promise.all([allFoods({ includeHidden: true }), allChefs()]);
  const chef = chefList.find((c) => c.id === req.params.id);
  if (!chef) throw fail(404, 'Chef not found.');
  const today = todayKey();
  const orderList = ctx.orders.filter((o) => o.items?.some((i) => i.chefId === chef.id));
  const mineIds = new Set(orderList.map((o) => o.id));
  const stats = foodStats(ctx, foods);
  res.json({ chef, menu: foods.filter((f) => f.chefId === chef.id).map((f) => ({ ...f, ...stats.get(f.id) })),
    todayOrders: orderList.filter((o) => dayKey(o.placedAt) === today).map((o) => summarize(o, ctx)),
    daily: daysBetween(shift(today, -6), today).map((k) => ({ date: k, label: dayLabel(k), revenue: orderList.filter((o) => live(o) && dayKey(o.placedAt) === k).reduce((s, o) => s + o.items.filter((i) => i.chefId === chef.id).reduce((a, i) => a + i.price * i.quantity, 0), 0) })),
    reviews: ctx.reviews.filter((r) => mineIds.has(r.id)).map((r) => ({ ...r, customer: ctx.userById.get(r.userId)?.name || '—' })),
    performance: { orders: orderList.length, cancelled: orderList.filter((o) => o.status === 'cancelled').length, avgPrepMinutes: Math.round(avg(foods.filter((f) => f.chefId === chef.id).map((f) => f.prepMinutes || 20)) || 0) } });
});

// ====================================================================================
// REVIEWS
// ====================================================================================
router.get('/reviews', async (req, res) => {
  const ctx = await getCtx();
  const list = ctx.reviews.map((r) => {
    const o = ctx.orderById.get(r.id);
    return { id: r.id, orderId: r.id, customer: ctx.userById.get(r.userId)?.name || '—', foods: (o?.items || []).map((i) => i.name), chefs: (o?.chefs || []).map((c) => c.name),
      rating: r.rating, deliveryRating: r.deliveryRating, comment: r.comment || '', createdAt: r.createdAt, flagged: !!r.flagged, partner: o?.partner?.name || null };
  });
  const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const r of list) dist[r.rating] += 1;
  res.json({ average: list.length ? round(avg(list.map((r) => r.rating)), 2) : null, count: list.length, distribution: dist, flagged: list.filter((r) => r.flagged).length, reviews: list });
});
router.patch('/reviews/:id', async (req, res) => {
  if (!(await reviews.byId(req.params.id))) throw fail(404, 'Review not found.');
  await reviews.update(req.params.id, { flagged: !!req.body.flagged });
  res.json({ ok: true });
});

// ====================================================================================
// ANALYTICS
// ====================================================================================
router.get('/analytics', async (req, res) => {
  const ctx = await getCtx();
  const range = parseRange(req.query);
  const days = series(ctx.orders, range.from, range.to);
  const inRange = ctx.orders.filter((o) => dayKey(o.placedAt) >= range.from && dayKey(o.placedAt) <= range.to);
  const good = inRange.filter(live);
  const byCategory = {}, byChef = {};
  for (const o of good) for (const i of o.items || []) {
    const f = await getFood(i.id, { includeHidden: true });
    const cat = f?.category || 'other';
    byCategory[cat] = (byCategory[cat] || 0) + i.quantity;
    byChef[i.chefName || '—'] = (byChef[i.chefName || '—'] || 0) + i.quantity;
  }
  const pRows = paymentRows(ctx);
  const done = good.filter((o) => o.stage >= 3);
  const delivMin = done.map((o) => minutesBetween(o.placedAt, o.stageTimes[3])).filter((x) => x !== null);
  const signups = daysBetween(range.from, range.to).map((k) => ({ date: k, label: dayLabel(k), signups: ctx.users.filter((u) => u.role !== 'admin' && dayKey(u.createdAt) === k).length }));
  let cumulative = ctx.users.filter((u) => u.role !== 'admin' && dayKey(u.createdAt) < range.from).length;
  const growth = signups.map((s) => ({ ...s, total: (cumulative += s.signups) }));
  const buyers = new Set(good.map((o) => o.userId));
  const firstSeen = new Map();
  for (const o of [...ctx.orders].reverse()) if (!firstSeen.has(o.userId)) firstSeen.set(o.userId, dayKey(o.placedAt));
  const toRank = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  res.json({
    range, days,
    revenue: { total: days.reduce((s, d) => s + d.revenue, 0), orderValue: days.reduce((s, d) => s + d.orderValue, 0), best: [...days].sort((a, b) => b.revenue - a.revenue)[0] || null },
    orders: { total: inRange.length, delivered: done.length, cancelled: inRange.length - good.length, cancelRate: pct(inRange.length - good.length, inRange.length), avg: good.length ? Math.round(good.reduce((s, o) => s + o.total, 0) / good.length) : 0 },
    customers: { buyers: buyers.size, newBuyers: [...buyers].filter((id) => firstSeen.get(id) >= range.from).length, repeatBuyers: [...buyers].filter((id) => good.filter((o) => o.userId === id).length > 1).length, signups: signups.reduce((s, d) => s + d.signups, 0) },
    growth, byCategory: toRank(byCategory), byChef: toRank(byChef).slice(0, 8),
    payments: paymentSummary(pRows, range.from, range.to),
    delivery: {
      avgMinutes: round(avg(delivMin), 0), fastest: delivMin.length ? Math.round(Math.min(...delivMin)) : null, slowest: delivMin.length ? Math.round(Math.max(...delivMin)) : null,
      daily: daysBetween(range.from, range.to).map((k) => ({ date: k, label: dayLabel(k), minutes: round(avg(done.filter((o) => dayKey(o.stageTimes[3]) === k).map((o) => minutesBetween(o.placedAt, o.stageTimes[3]))), 0) })),
      lateNow: ctx.orders.filter(isOpen).filter((o) => summarize(o, ctx).delayed).length
    }
  });
});

// ====================================================================================
// NOTIFICATIONS, ACTIVITY, SEARCH, SETTINGS, REPORTS
// ====================================================================================
router.get('/notifications', async (req, res) => res.json(notifications(await getCtx(), req.user)));
router.post('/notifications/read', async (req, res) => {
  const me = await users.byId(req.user.id);
  await users.update(me.id, { preferences: { ...(me.preferences || {}), adminNotifSeenAt: new Date().toISOString() } });
  res.json({ ok: true });
});
router.get('/activity', async (req, res) => res.json(buildFeed(await getCtx()).slice(0, 60)));

router.get('/search', async (req, res) => {
  const q = clean(req.query.q).toLowerCase();
  if (q.length < 2) return res.json({ orders: [], customers: [], chefs: [] });
  const ctx = await getCtx();
  const chefList = await allChefs();
  res.json({
    orders: ctx.orders.filter((o) => [o.id, o.address?.name, o.address?.phone].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 6).map((o) => summarize(o, ctx)),
    customers: customerRows(ctx).filter((c) => [c.name, c.email, c.phone].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 6),
    chefs: chefList.filter((c) => [c.name, c.city, c.cuisine].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 6).map((c) => ({ id: c.id, name: c.name, city: c.city }))
  });
});

router.get('/settings', async (req, res) => res.json({
  database: storeStatus.kind, businessTimezoneOffsetMinutes: OFFSET / 60000, autoAssign, paymentGateway: { name: gateway.label, live: gateway.live },
  trackingStageSeconds: STAGE_SECONDS, gpsSource: 'No GPS feed connected by default — partner positions are estimates until a partner app posts to /api/admin/delivery/partners/:id/location.'
}));

router.get('/reports/generate', async (req, res) => {
  const ctx = await getCtx();
  const dateQuery = clean(req.query.date);
  const monthQuery = clean(req.query.month);

  let from, to, label, periodType, periodVal;
  if (dateQuery && /^\d{4}-\d{2}-\d{2}$/.test(dateQuery)) {
    from = dateQuery;
    to = dateQuery;
    periodType = 'date';
    periodVal = dateQuery;
    label = new Date(`${dateQuery}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } else if (monthQuery && /^\d{4}-\d{2}$/.test(monthQuery)) {
    const [y, m] = monthQuery.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    from = `${monthQuery}-01`;
    to = `${monthQuery}-${String(lastDay).padStart(2, '0')}`;
    periodType = 'month';
    periodVal = monthQuery;
    label = new Date(`${monthQuery}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  } else {
    const today = todayKey();
    from = today;
    to = today;
    periodType = 'date';
    periodVal = today;
    label = `Today (${dayText(today)})`;
  }

  const periodOrders = ctx.orders.filter((o) => {
    const dk = dayKey(o.placedAt);
    return dk >= from && dk <= to;
  });

  const nonCancelled = periodOrders.filter(live);
  const delivered = periodOrders.filter((o) => live(o) && o.stage >= 3);
  const cancelled = periodOrders.filter((o) => o.status === 'cancelled');
  const pending = nonCancelled.filter((o) => o.stage < 3);

  const grossSales = nonCancelled.reduce((s, o) => s + (o.total || 0), 0);
  const paidOrders = periodOrders.filter((o) => o.paymentStatus === 'paid');
  const paidRevenue = paidOrders.reduce((s, o) => s + (o.total || 0), 0);
  const avgOrderValue = nonCancelled.length ? Math.round(grossSales / nonCancelled.length) : 0;

  const methodMap = {};
  for (const o of nonCancelled) {
    const m = METHOD[o.paymentMethod] || o.paymentMethod || 'Other';
    if (!methodMap[m]) methodMap[m] = { count: 0, amount: 0 };
    methodMap[m].count += 1;
    methodMap[m].amount += (o.total || 0);
  }

  const deliveryTimes = delivered
    .map((o) => minutesBetween(o.placedAt, deliveredAt(o)))
    .filter((x) => x !== null && x > 0);
  const avgDeliveryMin = deliveryTimes.length ? Math.round(avg(deliveryTimes)) : 0;

  const dishMap = {};
  const chefMap = {};
  for (const o of nonCancelled) {
    for (const it of (o.items || [])) {
      dishMap[it.name] = (dishMap[it.name] || 0) + (it.quantity || 1);
      if (it.chefName || it.chef) {
        const cn = it.chefName || it.chef;
        chefMap[cn] = (chefMap[cn] || 0) + (it.quantity || 1);
      }
    }
  }
  const topDishes = Object.entries(dishMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5);
  const topChefs = Object.entries(chefMap).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 5);

  const partnerMap = {};
  for (const o of delivered) {
    if (o.partner?.id) {
      partnerMap[o.partner.name] = (partnerMap[o.partner.name] || 0) + 1;
    }
  }
  const partnerMetrics = Object.entries(partnerMap).map(([name, count]) => ({ name, deliveries: count }));

  const orderList = periodOrders.map((o) => {
    const s = summarize(o, ctx);
    return {
      id: s.id,
      placedAt: s.placedAt,
      customer: s.customer,
      phone: s.phone,
      total: s.total,
      items: s.items.join(', '),
      paymentMethod: s.paymentMethod,
      paymentStatus: s.paymentStatus,
      status: s.opsStatus,
      partner: s.partner?.name || '—',
      zone: s.zone || '—'
    };
  });

  res.json({
    period: { type: periodType, value: periodVal, from, to, label },
    summary: {
      totalOrders: periodOrders.length,
      deliveredOrders: delivered.length,
      cancelledOrders: cancelled.length,
      pendingOrders: pending.length,
      grossSales,
      paidRevenue,
      avgOrderValue,
      avgDeliveryMin,
      totalDeliveryPartners: ctx.partners.length
    },
    paymentMethods: Object.entries(methodMap).map(([method, data]) => ({ method, ...data })),
    topDishes,
    topChefs,
    partnerMetrics,
    orders: orderList
  });
});

const csv = (rows) => rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
router.get('/reports/export', async (req, res) => {
  const ctx = await getCtx();
  const range = parseRange(req.query);
  const type = String(req.query.type || 'revenue');
  let rows;
  if (type === 'orders') rows = [['Order', 'Placed', 'Customer', 'Phone', 'Zone', 'Items', 'Total', 'Payment', 'Payment status', 'Status', 'Partner'],
    ...ctx.orders.filter((o) => dayKey(o.placedAt) >= range.from && dayKey(o.placedAt) <= range.to).map((o) => { const s = summarize(o, ctx); return [s.id, s.placedAt, s.customer, s.phone, s.zone, s.items.join('; '), s.total, s.paymentMethod, s.paymentStatus, s.opsStatus, s.partner?.name || '']; })];
  else if (type === 'payments') rows = [['Payment', 'Order', 'Customer', 'Amount', 'Method', 'Transaction', 'Status', 'Time'],
    ...paymentRows(ctx).filter((r) => dayKey(r.createdAt) >= range.from && dayKey(r.createdAt) <= range.to).map((r) => [r.id, r.orderId, r.customer, r.amount, r.method, r.transactionId, r.status, r.time])];
  else rows = [['Date', 'Revenue (paid)', 'Orders', 'Order value', 'Delivered', 'Cancelled', 'Avg order'], ...series(ctx.orders, range.from, range.to).map((d) => [d.date, d.revenue, d.orders, d.orderValue, d.delivered, d.cancelled, d.avgOrder])];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rasoi-${type}-${range.from}_${range.to}.csv"`);
  res.send(csv(rows));
});

export default router;
