// Administrator API. Every route needs a valid JWT (requireAuth) AND the "admin" role (requireAdmin).
import { Router } from 'express';
import { users, orders, reviews, chefs as chefStore, foods as foodStore, partners as partnerStore, offers as offerStore } from '../store.js';
import { requireAuth, requireAdmin, publicUser } from '../auth.js';
import { getTierSettings, setTierSettings, calculateUserTier, getCompletedOrdersCount } from '../tierService.js';
import { refreshCatalog, allFoods, allChefs, CATEGORIES, DIETS, SPICES } from '../catalog.js';
import { moveToStage, syncOrder, STAGES } from '../tracking.js';
import { fail, clean } from '../orderService.js';
import { validPoint } from '../geo.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const int = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
};
const str = (v, max) => clean(v).slice(0, max);
const slug = (prefix, existing) => {
  const nums = existing.map((x) => Number(String(x.id).replace(/\D/g, ''))).filter(Number.isFinite);
  return `${prefix}${String(Math.max(0, ...nums) + 1).padStart(2, '0')}`;
};

// ---- dashboard numbers ----
router.get('/stats', async (req, res) => {
  const [allUsers, allOrders, foods, chefs] = await Promise.all([users.all(), orders.all(), allFoods({ includeHidden: true }), allChefs()]);
  const live = allOrders.filter((o) => o.status !== 'cancelled');
  const sold = new Map();
  for (const o of live) for (const it of o.items || []) sold.set(it.id, { name: it.name, qty: (sold.get(it.id)?.qty || 0) + it.quantity });
  const byStatus = { cancelled: allOrders.length - live.length };
  for (const o of live) { const k = ['placed', 'preparing', 'out', 'delivered'][o.stage] || 'placed'; byStatus[k] = (byStatus[k] || 0) + 1; }
  res.json({
    users: allUsers.filter((u) => u.role !== 'admin').length,
    admins: allUsers.filter((u) => u.role === 'admin').length,
    foods: foods.length,
    chefs: chefs.length,
    orders: allOrders.length,
    revenue: live.reduce((s, o) => s + (o.total || 0), 0),
    byStatus,
    topDishes: [...sold.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.qty - a.qty).slice(0, 5),
    recentSignups: allUsers.slice(0, 5).map((u) => ({ id: u.id, name: u.name, email: u.email, createdAt: u.createdAt }))
  });
});

// ---- users ----
router.get('/users', async (req, res) => {
  const [list, allOrders] = await Promise.all([users.all(), orders.all()]);
  const stats = new Map();
  for (const o of allOrders) {
    const s = stats.get(o.userId) || { orders: 0, spent: 0 };
    s.orders += 1;
    if (o.status !== 'cancelled') s.spent += o.total || 0;
    stats.set(o.userId, s);
  }
  res.json(list.map((u) => ({ ...publicUser(u), preferences: undefined, provider: u.preferences?.provider || 'password', ...(stats.get(u.id) || { orders: 0, spent: 0 }) })));
});

router.patch('/users/:id', async (req, res) => {
  const user = await users.byId(req.params.id);
  if (!user) throw fail(404, 'User not found.');
  const patch = {};
  if ('name' in req.body) { patch.name = str(req.body.name, 120); if (!patch.name) throw fail(400, 'Name cannot be empty.'); }
  if ('phone' in req.body) patch.phone = str(req.body.phone, 20);
  if ('role' in req.body) {
    if (user.role === 'user') throw fail(400, 'Customer role cannot be modified by the administrator.');
    if (!['user', 'admin'].includes(req.body.role)) throw fail(400, 'Role must be user or admin.');
    if (user.role === 'admin' && req.body.role !== 'admin' && (await users.countByRole('admin')) <= 1) throw fail(400, 'There must always be at least one administrator.');
    patch.role = req.body.role;
  }
  res.json(publicUser(await users.update(user.id, patch)));
});

router.delete('/users/:id', async (req, res) => {
  const user = await users.byId(req.params.id);
  if (!user) throw fail(404, 'User not found.');
  if (user.id === req.user.id) throw fail(400, 'You cannot delete your own administrator account.');
  if (user.role === 'admin' && (await users.countByRole('admin')) <= 1) throw fail(400, 'There must always be at least one administrator.');
  await users.remove(user.id);
  res.json({ ok: true });
});

// ---- dishes ----
const foodFields = async (body, current = {}) => {
  const f = {};
  const has = (k) => k in body;
  if (!current.id || has('name')) { f.name = str(body.name, 160); if (!f.name) throw fail(400, 'Dish name is required.'); }
  if (!current.id || has('nameTa')) f.nameTa = str(body.nameTa, 220) || f.name || current.name;
  if (!current.id || has('category')) { if (!CATEGORIES.includes(body.category)) throw fail(400, 'Choose a valid category.'); f.category = body.category; }
  if (!current.id || has('meals') || has('category')) {
    const meals = Array.isArray(body.meals) ? body.meals.filter((m) => CATEGORIES.includes(m)) : [];
    const cat = f.category || current.category;
    f.meals = [...new Set([cat, ...meals])];
  }
  if (!current.id || has('chefId')) { if (!(await chefStore.byId(body.chefId))) throw fail(400, 'Choose a valid chef.'); f.chefId = body.chefId; }
  if (!current.id || has('price')) f.price = int(body.price, 1, 5000, 'Price');
  if (!current.id || has('prepMinutes')) f.prepMinutes = int(body.prepMinutes ?? 20, 1, 240, 'Preparation time');
  if (!current.id || has('diet')) { if (!DIETS.includes(body.diet)) throw fail(400, 'Choose veg, vegan or non-veg.'); f.diet = body.diet; }
  if (!current.id || has('spice')) { if (!SPICES.includes(body.spice)) throw fail(400, 'Choose a valid spice level.'); f.spice = body.spice; }
  if (!current.id || has('description')) f.description = str(body.description, 600);
  if (!current.id || has('descriptionTa')) f.descriptionTa = str(body.descriptionTa, 800) || f.description || current.description || '';
  if (has('icon')) f.icon = str(body.icon, 16);
  if (has('photo')) {
    const photo = str(body.photo, 500);
    if (photo && !/^(https?:\/\/|\/images\/)/.test(photo)) throw fail(400, 'Photo must be a web address (https://…) or a /images/… path.');
    f.photo = photo || null;
  }
  if (has('tags')) f.tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',')).map((t) => str(t, 40)).filter(Boolean).slice(0, 6);
  if (has('available')) f.available = !!body.available;
  return f;
};

router.get('/foods', async (req, res) => res.json(await allFoods({ includeHidden: true })));
router.post('/foods', async (req, res) => {
  const existing = await foodStore.all();
  const fields = await foodFields(req.body);
  const food = await foodStore.insert({
    id: slug('f', existing), icon: '🍽️', rating: 0, reviews: 0, tags: [], photo: null, photoCredit: null, photoQuery: null, available: true, ...fields
  });
  await refreshCatalog();
  res.status(201).json(food);
});
router.patch('/foods/:id', async (req, res) => {
  const current = await foodStore.byId(req.params.id);
  if (!current) throw fail(404, 'Dish not found.');
  const food = await foodStore.update(current.id, await foodFields(req.body, current));
  await refreshCatalog();
  res.json(food);
});
router.delete('/foods/:id', async (req, res) => {
  if (!(await foodStore.byId(req.params.id))) throw fail(404, 'Dish not found.');
  await foodStore.remove(req.params.id); // past orders keep their own copy of the dish name and price
  await refreshCatalog();
  res.json({ ok: true });
});

// ---- chefs ----
const chefFields = (body, current = {}) => {
  const c = {};
  const has = (k) => k in body;
  if (!current.id || has('name')) { c.name = str(body.name, 120); if (!c.name) throw fail(400, 'Chef name is required.'); }
  if (!current.id || has('nameTa')) c.nameTa = str(body.nameTa, 160) || c.name || current.name;
  for (const [k, max] of [['city', 80], ['cityTa', 80], ['cuisine', 120], ['cuisineTa', 160], ['speciality', 255], ['specialityTa', 400], ['bio', 800], ['bioTa', 1200]]) {
    if (!current.id || has(k)) c[k] = str(body[k], max);
  }
  if (!current.id || has('experience')) c.experience = int(body.experience ?? 0, 0, 80, 'Experience');
  if (has('lat') || has('lng')) {
    if (body.lat === '' || body.lat === null || body.lat === undefined) { c.lat = null; c.lng = null; } else {
      const pt = validPoint(body.lat, body.lng);
      if (!pt) throw fail(400, 'Kitchen latitude / longitude are not valid.');
      Object.assign(c, pt);
    }
  }
  if (has('color')) { const col = str(body.color, 9); if (col && !/^#[0-9a-fA-F]{6}$/.test(col)) throw fail(400, 'Colour must look like #2F6B4F.'); c.color = col || '#2F6B4F'; }
  return c;
};
router.get('/chefs', async (req, res) => res.json(await allChefs()));
router.post('/chefs', async (req, res) => {
  const existing = await chefStore.all();
  const chef = await chefStore.insert({ id: slug('c', existing), rating: 0, orders: 0, color: '#2F6B4F', ...chefFields(req.body) });
  await refreshCatalog();
  res.status(201).json(chef);
});
router.patch('/chefs/:id', async (req, res) => {
  const current = await chefStore.byId(req.params.id);
  if (!current) throw fail(404, 'Chef not found.');
  const chef = await chefStore.update(current.id, chefFields(req.body, current));
  await refreshCatalog();
  res.json(chef);
});
router.delete('/chefs/:id', async (req, res) => {
  if (!(await chefStore.byId(req.params.id))) throw fail(404, 'Chef not found.');
  if ((await foodStore.all()).some((f) => f.chefId === req.params.id)) throw fail(409, 'This chef still has dishes. Move or delete those dishes first.');
  await chefStore.remove(req.params.id);
  await refreshCatalog();
  res.json({ ok: true });
});

// ---- orders ----
router.get('/orders', async (req, res) => {
  const [list, allUsers] = await Promise.all([orders.all(), users.all()]);
  const who = new Map(allUsers.map((u) => [u.id, u]));
  const synced = await Promise.all(list.map(syncOrder));
  res.json(synced.map((o) => ({ ...o, deliveryOtp: undefined, customer: who.get(o.userId) ? { name: who.get(o.userId).name, email: who.get(o.userId).email } : null })));
});
// Move an order to a stage (0-3) or cancel it.
router.patch('/orders/:id', async (req, res) => {
  const order = await orders.byId(req.params.id);
  if (!order) throw fail(404, 'Order not found.');
  let current = await syncOrder(order);
  if (req.body.status === 'cancelled') {
    if (current.status === 'cancelled') return res.json(current);
    if (current.stage >= STAGES - 1) throw fail(400, 'A delivered order cannot be cancelled.');
    current = await orders.update(current.id, {
      status: 'cancelled', cancelledAt: new Date().toISOString(), nextStageAt: null, etaAt: null,
      paymentStatus: current.paymentStatus === 'paid' ? 'refund_initiated' : 'cancelled'
    });
    if (current.partner?.id) {
      try { await partnerStore.update(current.partner.id, { online: true, active: true }); } catch { /* ignore */ }
    }
  } else if ('stage' in req.body) {
    const stage = int(req.body.stage, 0, STAGES - 1, 'Stage');
    if (current.status === 'cancelled') throw fail(400, 'This order was cancelled.');
    if (stage <= current.stage) throw fail(400, 'An order can only move forward.');
    for (let s = current.stage + 1; s <= stage; s += 1) current = await moveToStage(current, s, Date.now());
  } else throw fail(400, 'Send a stage or status.');
  res.json({ ...current, deliveryOtp: undefined });
});
router.delete('/orders/:id', async (req, res) => {
  if (!(await orders.byId(req.params.id))) throw fail(404, 'Order not found.');
  await orders.remove(req.params.id);
  res.json({ ok: true });
});

// ---- reviews (read-only) ----
router.get('/reviews', async (req, res) => {
  const [list, allUsers] = await Promise.all([reviews.all(), users.all()]);
  const who = new Map(allUsers.map((u) => [u.id, u.name]));
  res.json(list.map((r) => ({ ...r, customer: who.get(r.userId) || '—' })));
});

// ---- delivery partners ----
const partnerFields = (body, current = {}) => {
  const p = {};
  if (!current.id || 'name' in body) { p.name = str(body.name, 120); if (!p.name) throw fail(400, 'Partner name is required.'); }
  if ('vehicle' in body) p.vehicle = str(body.vehicle, 40);
  if ('phone' in body) p.phone = str(body.phone, 20);
  if ('active' in body) p.active = !!body.active;
  if ('online' in body) p.online = !!body.online;
  if ('vehicleNo' in body) p.vehicleNo = str(body.vehicleNo, 30);
  if ('area' in body) p.area = str(body.area, 80);
  if ('maxOrders' in body) p.maxOrders = int(body.maxOrders, 1, 10, 'Maximum active orders');
  if ('zoneId' in body) p.zoneId = clean(body.zoneId) || null;
  if ('lat' in body || 'lng' in body) {
    if (body.lat === '' || body.lat === null) { p.lat = null; p.lng = null; } else {
      const pt = validPoint(body.lat, body.lng);
      if (!pt) throw fail(400, 'Enter a valid latitude and longitude.');
      Object.assign(p, pt); // typed in by the admin: a base position, not a live GPS report (only /delivery/partners/:id/location sets locationAt)
    }
  }
  return p;
};
router.get('/partners', async (req, res) => res.json(await partnerStore.all()));
router.post('/partners', async (req, res) => {
  const existing = await partnerStore.all();
  res.status(201).json(await partnerStore.insert({ id: slug('d', existing), vehicle: '', phone: '', active: true, online: true, maxOrders: 2, ...partnerFields(req.body) }));
});
router.patch('/partners/:id', async (req, res) => {
  const current = await partnerStore.byId(req.params.id);
  if (!current) throw fail(404, 'Delivery partner not found.');
  res.json(await partnerStore.update(current.id, partnerFields(req.body, current)));
});
router.delete('/partners/:id', async (req, res) => {
  if (!(await partnerStore.byId(req.params.id))) throw fail(404, 'Delivery partner not found.');
  await partnerStore.remove(req.params.id);
  res.json({ ok: true });
});

// ---- admin offers management (Food-Specific Offers) ----
const formatOffer = (o, food = null) => {
  const discountPct = Number(o.discountValue) || 10;
  const originalPrice = food ? food.price : null;
  const discountedPrice = food ? Math.round(food.price * (1 - discountPct / 100)) : null;
  return {
    id: o.id,
    foodId: o.foodId || null,
    foodName: food?.name || '',
    foodPhoto: food?.photo || null,
    foodCategory: food?.category || '',
    originalPrice,
    discountedPrice,
    savingsPerItem: originalPrice && discountedPrice ? originalPrice - discountedPrice : null,
    title: o.name || (food ? `${discountPct}% Off on ${food.name}` : 'Special Food Offer'),
    name: o.name || (food ? `${discountPct}% Off on ${food.name}` : 'Special Food Offer'),
    code: o.code || '',
    description: o.description || '',
    discountType: 'percent',
    discountValue: discountPct,
    discountPct,
    minOrder: Number(o.minOrder) || 0,
    startDate: o.startDate ? new Date(o.startDate).toISOString().slice(0, 10) : '',
    endDate: o.endDate ? new Date(o.endDate).toISOString().slice(0, 10) : '',
    active: !!o.active,
    createdAt: o.createdAt
  };
};

router.get('/offers', async (req, res) => {
  const [allOffers, allFoodsList] = await Promise.all([offerStore.all(), foodStore.all()]);
  const foodMap = new Map(allFoodsList.map((f) => [f.id, f]));
  res.json(allOffers.map((o) => formatOffer(o, foodMap.get(o.foodId))));
});

router.post('/offers', async (req, res) => {
  const foodId = str(req.body.foodId, 40);
  if (!foodId) throw fail(400, 'Please select a dish from the menu.');
  const food = await foodStore.byId(foodId);
  if (!food) throw fail(404, 'Selected dish does not exist.');

  const discountValue = int(req.body.discountValue ?? req.body.discountPct ?? 10, 1, 90, 'Discount percentage');
  const name = str(req.body.title || req.body.name, 120) || `${discountValue}% Off on ${food.name}`;
  const startDate = req.body.startDate ? new Date(req.body.startDate) : new Date();
  const endDate = req.body.endDate ? new Date(req.body.endDate) : new Date(Date.now() + 30 * 86400000);
  const active = req.body.active !== false;

  const id = `off_${Date.now()}`;
  const offer = await offerStore.insert({
    id,
    foodId,
    name,
    code: null,
    description: str(req.body.description, 255) || `Promotional discount on fresh ${food.name}`,
    discountType: 'percent',
    discountValue,
    minOrder: 0,
    maxDiscount: null,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    active,
    createdAt: new Date().toISOString()
  });
  res.status(201).json(formatOffer(offer, food));
});

router.patch('/offers/:id', async (req, res) => {
  const current = await offerStore.byId(req.params.id);
  if (!current) throw fail(404, 'Offer not found.');
  const patch = {};
  let targetFoodId = current.foodId;
  if ('foodId' in req.body) {
    targetFoodId = str(req.body.foodId, 40);
    const food = await foodStore.byId(targetFoodId);
    if (!food) throw fail(404, 'Selected dish does not exist.');
    patch.foodId = targetFoodId;
  }
  const food = targetFoodId ? await foodStore.byId(targetFoodId) : null;

  if ('title' in req.body || 'name' in req.body) patch.name = str(req.body.title || req.body.name, 120);
  if ('description' in req.body) patch.description = str(req.body.description, 255);
  if ('discountValue' in req.body || 'discountPct' in req.body) patch.discountValue = int(req.body.discountValue ?? req.body.discountPct, 1, 90, 'Discount percentage');
  if ('startDate' in req.body) patch.startDate = req.body.startDate ? new Date(req.body.startDate).toISOString() : null;
  if ('endDate' in req.body) patch.endDate = req.body.endDate ? new Date(req.body.endDate).toISOString() : null;
  if ('active' in req.body) patch.active = !!req.body.active;

  const updated = await offerStore.update(current.id, patch);
  res.json(formatOffer(updated, food));
});

router.delete('/offers/:id', async (req, res) => {
  const current = await offerStore.byId(req.params.id);
  if (!current) throw fail(404, 'Offer not found.');
  await offerStore.remove(current.id);
  res.json({ ok: true });
});

// ---- admin membership tier limits & discounts ----
router.get('/tiers', async (req, res) => {
  const tierSettings = await getTierSettings();
  const allUsers = (await users.all()).filter((u) => u.role !== 'admin');
  const counts = { silver: 0, gold: 0, vip: 0 };
  for (const u of allUsers) {
    const ordersCount = await getCompletedOrdersCount(u.id);
    const userTier = calculateUserTier(ordersCount, tierSettings);
    counts[userTier.tier] = (counts[userTier.tier] || 0) + 1;
  }
  res.json({ settings: tierSettings, counts, totalUsers: allUsers.length });
});

router.post('/tiers', async (req, res) => {
  const updated = await setTierSettings(req.body);
  res.json({ settings: updated, ok: true });
});

export default router;
