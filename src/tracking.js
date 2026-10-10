// Order tracking. An order moves through four stages on a timer, the way a
// real delivery app updates on its own:
//
//   0 Order placed  ->  1 Being prepared  ->  2 Out for delivery  ->  3 Delivered
//
// STAGE_SECONDS are the gaps between them. The defaults are short so you can
// watch a whole delivery in about four minutes; for realistic timings set e.g.
//   TRACK_STAGE_SECONDS=120,1200,900   (2 min, 20 min, 15 min)
import { orders, partners, zones as zoneStore } from './store.js';
import { autoAssign, autoAssignIfPossible, orderGeo, partnerPosition } from './dispatch.js';
import { haversineKm, round } from './geo.js';

export const STAGES = 4;

const parse = (value) => {
  const nums = String(value || '').split(',').map((n) => Number(n.trim()));
  return nums.length === 3 && nums.every((n) => n > 0) ? nums : [25, 35, 30];
};
export const STAGE_SECONDS = parse(process.env.TRACK_STAGE_SECONDS);

const remainingMs = (fromStage) => STAGE_SECONDS.slice(fromStage).reduce((a, b) => a + b, 0) * 1000;
// Delivery partners are assigned by location-aware dispatch (dispatch.js): by the admin, or by the
// system once the food is ready (AUTO_ASSIGN=off disables that). With no partners configured,
// orders still progress without one (as before).
const anyPartner = async () => (await partners.all()).some((p) => p.active !== false);

// Food counts as ready after this share of the "being prepared" window.
const READY_SHARE = 0.7;
export const readyAtMs = (order) => {
  const t = order.stageTimes?.[1];
  return t ? new Date(t).getTime() + STAGE_SECONDS[1] * 1000 * READY_SHARE : null;
};

export const ADMIN_ASSIGN_WINDOW_MS = 2 * 60 * 1000; // 2 minutes for admin assignment before auto-assigning nearest rider

// Fields every new order starts with.
export const initialTracking = (id, now = Date.now()) => {
  const ts = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : typeof now === 'string' ? new Date(now).getTime() : (now?.placedAt ? new Date(now.placedAt).getTime() : Date.now()));
  return {
    stage: 0,
    status: 'active',
    stageTimes: [new Date(ts).toISOString(), null, null, null],
    nextStageAt: new Date(ts + STAGE_SECONDS[0] * 1000).toISOString(),
    etaAt: new Date(ts + remainingMs(0)).toISOString(),
    partner: null,
    autoAssignAt: new Date(ts + ADMIN_ASSIGN_WINDOW_MS).toISOString(),
    deliveryOtp: String(1000 + Math.floor(Math.random() * 9000))
  };
};

// Moves an order to `stage`, recording when that happened.
export const moveToStage = async (order, stage, atMs = Date.now()) => {
  const stageTimes = [...(order.stageTimes || [])];
  stageTimes[stage] = new Date(atMs).toISOString();
  const patch = {
    stage,
    stageTimes,
    nextStageAt: stage < STAGES - 1 ? new Date(atMs + STAGE_SECONDS[stage] * 1000).toISOString() : null,
    etaAt: stage < STAGES - 1 ? new Date(atMs + remainingMs(stage)).toISOString() : stageTimes[stage]
  };
  if (stage === STAGES - 1 && order.paymentStatus === 'pay_on_delivery') {
    patch.paymentStatus = 'paid';
    patch.paidAt = patch.etaAt;
  }
  let updated = (await orders.update(order.id, patch)) || order;
  // If delivery is completed (stage 3): partner automatically becomes available again!
  if (stage === STAGES - 1 && updated.partner?.id) {
    try {
      await partners.update(updated.partner.id, { online: true, active: true });
    } catch { /* ignore */ }
  }
  // Going out for delivery needs a partner (when any exist): pick the recommended one if nobody was assigned.
  if (stage === 2 && !updated.partner && (await anyPartner())) {
    try {
      updated = await autoAssignIfPossible(updated);
    } catch { /* ignore */ }
  }
  return updated;
};

// Brings an order up to date with the clock. Called on every read.
export const syncOrder = async (order) => {
  if (!order || order.status === 'cancelled') return order;
  if (!order.stageTimes) {
    // Order saved by an older version: keep its stage, don't auto-advance it.
    return (await orders.update(order.id, {
      status: 'active',
      stageTimes: Array.from({ length: STAGES }, (_, i) => (i <= order.stage ? order.placedAt : null)),
      nextStageAt: null,
      etaAt: null,
      partner: order.partner || null,
      deliveryOtp: String(1000 + Math.floor(Math.random() * 9000))
    })) || order;
  }
  let current = order;
  const now = Date.now();

  // 2-minute admin assignment window:
  // If no partner was assigned by admin within 2 minutes of the order being placed,
  // automatically assign the nearest available partner!
  if (!current.partner && current.status !== 'cancelled' && current.stage < STAGES - 1) {
    const placedTime = new Date(current.placedAt).getTime();
    if (now - placedTime >= ADMIN_ASSIGN_WINDOW_MS && (await anyPartner())) {
      try {
        current = await autoAssignIfPossible(current);
      } catch (err) {
        console.warn('Auto assign partner after 2-min window:', err.message);
      }
    }
  }

  while (current.stage < STAGES - 1 && current.nextStageAt && new Date(current.nextStageAt).getTime() <= now) {
    // If advancing and still missing a partner, auto-assign
    if (!current.partner && (await anyPartner())) {
      try {
        current = await autoAssignIfPossible(current);
      } catch (err) {
        console.warn('Auto assign partner sync:', err.message);
      }
    }
    // An order cannot advance to stage 2 (Out for delivery) or stage 3 (Delivered) without a delivery partner assigned
    if (current.stage >= 1 && !current.partner) {
      break;
    }
    const due = new Date(current.nextStageAt).getTime();
    current = await moveToStage(current, current.stage + 1, due);
  }
  return current;
};

// The delivery OTP is only useful (and only shown) once the order is on its way.
export const forClient = (order) => {
  const { deliveryOtp, ...rest } = order;
  return { ...rest, deliveryOtp: order.stage === 2 ? deliveryOtp : null };
};

// Where the order is in the real-world journey (finer than the 4 timer stages).
export const subStage = (order, now = Date.now()) => {
  if (order.status === 'cancelled') return 'cancelled';
  if (order.stage >= 3) return 'delivered';
  if (order.stage === 2) {
    const out = order.stageTimes?.[2] ? new Date(order.stageTimes[2]).getTime() : now;
    const end = order.etaAt ? new Date(order.etaAt).getTime() : out;
    const progress = end > out ? (now - out) / (end - out) : 1;
    return progress >= 0.85 ? 'arriving_soon' : 'out_for_delivery';
  }
  if (order.stage === 1) {
    const ready = readyAtMs(order);
    if (ready && now >= ready) return order.partner ? 'partner_assigned' : 'ready';
    return 'preparing';
  }
  return 'placed';
};
// Admin operations board column.
export const opsStatus = (order) => ({
  placed: 'NEW', preparing: 'PREPARING', ready: 'READY_FOR_PICKUP', partner_assigned: 'READY_FOR_PICKUP',
  out_for_delivery: 'OUT_FOR_DELIVERY', arriving_soon: 'OUT_FOR_DELIVERY', delivered: 'DELIVERED', cancelled: 'CANCELLED'
})[subStage(order)];

// Live tracking block sent to the customer and the admin. The partner's position is real GPS when a
// location feed has reported recently (POST /api/admin/delivery/partners/:id/location, ready for a
// partner app); otherwise it is an ESTIMATE along the kitchen -> customer line, and says so (source).
export const liveTracking = async (order, now = Date.now()) => {
  const zones = await zoneStore.all();
  const { customer, kitchen } = await orderGeo(order, zones);
  const sub = subStage(order, now);
  const out = { subStage: sub, customer: customer.point ? { ...customer.point, source: customer.source, zone: customer.zone?.name || null } : null,
    kitchen: kitchen.point ? { ...kitchen.point, source: kitchen.source, zone: kitchen.zone?.name || null } : null,
    partner: null, distanceKm: null, totalKm: null, progress: null, etaMinutes: null, lastUpdatedAt: null };
  if (order.status === 'cancelled' || !out.customer) return out;

  const road = 1.3; // straight-line -> road distance
  const total = out.kitchen ? haversineKm(out.kitchen, out.customer) * road : null;
  const etaMs = order.etaAt ? new Date(order.etaAt).getTime() : null;
  out.etaMinutes = etaMs ? Math.max(0, Math.ceil((etaMs - now) / 60000)) : null;

  out.totalKm = total === null ? null : round(total);
  if (order.stage >= 3) { out.distanceKm = 0; out.etaMinutes = 0; out.progress = 1; return out; }
  const p = order.partner?.id ? await partners.byId(order.partner.id) : null;
  if (!p || order.stage < 2) { out.distanceKm = total === null ? null : round(total); return out; }

  const pos = partnerPosition(p, zones);
  if (pos && pos.source === 'gps') {
    out.partner = { lat: pos.lat, lng: pos.lng, source: 'gps', updatedAt: pos.at };
    out.distanceKm = round(haversineKm(pos, out.customer) * road);
    out.lastUpdatedAt = pos.at;
    out.progress = total ? round(Math.min(1, Math.max(0, 1 - out.distanceKm / total)), 2) : null;
  } else if (out.kitchen) {
    const start = order.stageTimes?.[2] ? new Date(order.stageTimes[2]).getTime() : now;
    const progress = etaMs && etaMs > start ? Math.min(1, Math.max(0, (now - start) / (etaMs - start))) : 0;
    out.partner = {
      lat: out.kitchen.lat + (out.customer.lat - out.kitchen.lat) * progress,
      lng: out.kitchen.lng + (out.customer.lng - out.kitchen.lng) * progress,
      source: 'estimated', updatedAt: new Date(now).toISOString(), progress: round(progress, 2)
    };
    out.distanceKm = total === null ? null : round(total * (1 - progress));
    out.lastUpdatedAt = out.partner.updatedAt;
    out.progress = out.partner.progress;
  }
  return out;
};
