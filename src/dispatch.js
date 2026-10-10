// Delivery assignment. Ranks the delivery partners for an order by real distance, current load,
// zone and availability, recommends the best one and records the assignment (admin or system).
import { orders, partners, zones as zoneStore, reviews } from './store.js';
import { getChef } from './catalog.js';
import { haversineKm, round, resolveCustomer, resolveKitchen } from './geo.js';

const SPEED_KMH = 22; // average city speed used for travel-time estimates
const GPS_FRESH_MS = 3 * 60 * 1000;
export const autoAssign = (process.env.AUTO_ASSIGN || 'off').toLowerCase() === 'on';

export const isOpen = (o) => o && o.status !== 'cancelled' && o.stage < 3;
const minutes = (km) => Math.max(1, Math.ceil((km / SPEED_KMH) * 60));

export const maxOrdersOf = () => 1; // 1 delivery per partner: assigned = unavailable until delivered
export const isOnline = (p) => p.active !== false && p.online !== false;

export const partnerLoad = (allOrders) => {
  const m = new Map();
  for (const o of allOrders) if (isOpen(o) && o.partner?.id) m.set(o.partner.id, (m.get(o.partner.id) || 0) + 1);
  return m;
};

// available | on_delivery | offline  (disabled partners count as offline)
export const partnerStatus = (p, load = 0) => {
  if (!isOnline(p)) return 'offline';
  return load >= 1 ? 'on_delivery' : 'available';
};

export const partnerPosition = (p, zones) => {
  if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
    const fresh = p.locationAt && Date.now() - new Date(p.locationAt).getTime() < GPS_FRESH_MS;
    return { lat: p.lat, lng: p.lng, source: fresh ? 'gps' : 'last_known', at: p.locationAt || null };
  }
  const z = zones.find((x) => x.id === p.zoneId);
  return z ? { lat: z.lat, lng: z.lng, source: 'zone', at: null } : null;
};

export const orderGeo = async (order, zones) => {
  const customer = resolveCustomer(order.address, zones);
  const chef = await getChef(order.chefs?.[0]?.id);
  return { customer, kitchen: resolveKitchen(chef, zones, customer.zone) };
};

export const recommend = async (order, { allOrders, allPartners, zones } = {}) => {
  zones ||= await zoneStore.all();
  allPartners ||= await partners.all();
  allOrders ||= await orders.all();
  const load = partnerLoad(allOrders);
  const { customer, kitchen } = await orderGeo(order, zones);

  const candidates = allPartners.map((p) => {
    const active = load.get(p.id) || 0;
    const status = partnerStatus(p, active);
    const pos = partnerPosition(p, zones);
    const toCustomer = pos && customer.point ? haversineKm(pos, customer.point) : null;
    const toKitchen = pos && kitchen.point ? haversineKm(pos, kitchen.point) : null;
    const kitchenToCustomer = kitchen.point && customer.point ? haversineKm(kitchen.point, customer.point) : 0;
    const sameZone = !!customer.zone && p.zoneId === customer.zone.id;
    const eligible = status === 'available' && active === 0;
    // Lower is better: distance to customer directly dominates
    const dist = toCustomer ?? (sameZone ? 4 : 20);
    const score = dist + active * 50 + (sameZone ? 0 : 3);
    const pickupMin = toKitchen !== null ? minutes(toKitchen) : null;
    const etaMin = pickupMin !== null || toCustomer !== null ? (pickupMin ?? 5) + minutes(kitchenToCustomer || toCustomer || 0) : null;
    return {
      partnerId: p.id, name: p.name, phone: p.phone, vehicle: p.vehicle, vehicleNo: p.vehicleNo || '', zoneId: p.zoneId || null,
      area: p.area || zones.find((z) => z.id === p.zoneId)?.name || '',
      status, eligible, activeOrders: active, maxOrders: 1, sameZone,
      distanceKm: round(toCustomer), pickupKm: round(toKitchen), positionSource: pos?.source || 'unknown',
      pickupMinutes: pickupMin, etaMinutes: etaMin, score: round(score, 2)
    };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || ((a.distanceKm ?? 999) - (b.distanceKm ?? 999)) || a.score - b.score);

  const best = candidates.find((c) => c.eligible) || null;
  if (best) {
    const parts = [];
    if (best.distanceKm !== null) parts.push(`Nearest nearby partner (${best.distanceKm} km from customer)`);
    else parts.push('Nearest available partner (location estimated)');
    if (best.sameZone) parts.push(`Assigned to ${customer.zone?.name || 'Local'} zone`);
    if (best.activeOrders === 0) parts.push('Currently available for delivery');
    if (best.pickupMinutes !== null) parts.push(`Estimated pickup in ${best.pickupMinutes} min`);
    best.reason = parts;
  }
  return {
    orderId: order.id,
    zone: customer.zone ? { id: customer.zone.id, name: customer.zone.name } : null,
    customerLocation: { ...(customer.point || {}), source: customer.source },
    kitchenLocation: { ...(kitchen.point || {}), source: kitchen.source },
    candidates, recommended: best
  };
};

const ratingOf = async (partnerId, allOrders) => {
  const ids = new Set(allOrders.filter((o) => o.partner?.id === partnerId).map((o) => o.id));
  const rs = (await reviews.all()).filter((r) => ids.has(r.id) && r.deliveryRating);
  return rs.length ? round(rs.reduce((s, r) => s + r.deliveryRating, 0) / rs.length) : null;
};

export const assignPartner = async (order, partnerId, by = 'system') => {
  const p = await partners.byId(partnerId);
  if (!p) throw Object.assign(new Error('Delivery partner not found.'), { status: 404 });
  const allOrders = await orders.all();
  const load = partnerLoad(allOrders.filter((o) => o.id !== order.id));
  if (!isOnline(p)) throw Object.assign(new Error(`${p.name} is offline or disabled.`), { status: 409 });
  if ((load.get(p.id) || 0) >= 1 && !by.startsWith('system')) throw Object.assign(new Error(`${p.name} is currently on an active delivery and unavailable.`), { status: 409 });

  const now = Date.now();
  const patch = {
    partner: {
      id: p.id,
      name: p.name,
      vehicle: p.vehicle || '',
      vehicleNo: p.vehicleNo || '',
      phone: p.phone || '',
      rating: await ratingOf(p.id, allOrders),
      assignedAt: new Date(now).toISOString(),
      assignedBy: by
    }
  };

  if (order.stage === 0) {
    const stageTimes = [...(order.stageTimes || [new Date(now).toISOString(), null, null, null])];
    stageTimes[1] = new Date(now).toISOString();
    patch.stage = 1;
    patch.stageTimes = stageTimes;
    patch.nextStageAt = new Date(now + 35 * 1000).toISOString();
  }

  const updated = await orders.update(order.id, patch);

  try {
    await partners.update(p.id, { online: true, active: true });
  } catch { /* ignore */ }

  return updated;
};

// Automatically assigns the nearest available partner (e.g. after the 2-minute admin window)
export const autoAssignIfPossible = async (order) => {
  if (order.partner) return order;
  const rec = await recommend(order);
  const target = rec.recommended || rec.candidates?.find((c) => c.eligible) || rec.candidates?.[0];
  return target ? assignPartner(order, target.partnerId, 'system:auto-timeout') : order;
};
