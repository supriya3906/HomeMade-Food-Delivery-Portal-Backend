// Rasoi assistant + personalised recommendations. Everything is computed from the database:
// the live menu, this user's orders, what they recently viewed and the cart they send along.
import { Router } from 'express';
import { orders, recent } from '../store.js';
import { requireAuth } from '../auth.js';
import { allFoods, allChefs, getFood } from '../catalog.js';
import { answer, rankForUser } from '../assistant/engine.js';
import { syncOrder } from '../tracking.js';
import { DELIVERY_FEE, TAX_RATE } from '../pricing.js';

const router = Router();
router.use(requireAuth);

// What this person likes: categories they ordered (weighted by quantity) and viewed, and whether they eat meat.
const buildProfile = async (userId, foods) => {
  const byId = new Map(foods.map((f) => [f.id, f]));
  const history = await orders.forUser(userId);
  const views = await recent.list(userId, 30);
  const catScore = {};
  const orderedIds = new Set();
  const recentIds = new Set();
  let meat = 0;
  let total = 0;
  for (const o of history) {
    if (o.status === 'cancelled') continue;
    for (const it of o.items || []) {
      const f = byId.get(it.id);
      if (!f) continue;
      orderedIds.add(f.id);
      catScore[f.category] = (catScore[f.category] || 0) + 2 * it.quantity;
      total += it.quantity;
      if (f.diet === 'non-veg') meat += it.quantity;
    }
  }
  for (const v of views) {
    if (v.type === 'food') {
      const f = byId.get(v.id);
      if (f) { recentIds.add(f.id); catScore[f.category] = (catScore[f.category] || 0) + 1; }
    } else if (v.type === 'category') catScore[v.id] = (catScore[v.id] || 0) + 1;
  }
  return { catScore, orderedIds, recentIds, mostlyVeg: total >= 2 && meat / total < 0.2, hasHistory: orderedIds.size > 0 || recentIds.size > 0 };
};

router.post('/chat', async (req, res) => {
  const text = String(req.body.text || '').slice(0, 400);
  const hour = Number.isInteger(req.body.hour) && req.body.hour >= 0 && req.body.hour < 24 ? req.body.hour : null;
  const [foods, chefs] = await Promise.all([allFoods(), allChefs()]);

  // The cart lives in the browser; prices and names always come from the database.
  const cartItems = [];
  for (const row of Array.isArray(req.body.cart) ? req.body.cart.slice(0, 50) : []) {
    const food = await getFood(row?.id);
    const quantity = Number(row?.quantity);
    if (food && Number.isInteger(quantity) && quantity > 0 && quantity <= 50) cartItems.push({ food, quantity });
  }
  const latest = (await orders.forUser(req.user.id))[0];
  const lastOrder = latest ? await syncOrder(latest) : null;
  const profile = await buildProfile(req.user.id, foods);

  const result = answer(text, {
    foods, chefs, cartItems, lastOrder, profile, hour,
    pricing: { deliveryFee: DELIVERY_FEE, taxPercent: Math.round(TAX_RATE * 100) }
  });
  res.json({ ...result, dishes: result.dishes.map((id) => foods.find((f) => f.id === id)).filter(Boolean) });
});

// Personalised picks for the signed-in user (ordered + viewed history, rating, diet).
router.get('/recommendations', async (req, res) => {
  const foods = await allFoods();
  const profile = await buildProfile(req.user.id, foods);
  const limit = Math.min(Number(req.query.limit) || 6, 12);
  const category = String(req.query.category || '');
  const pool = category ? foods.filter((f) => (f.meals?.length ? f.meals : [f.category]).includes(category)) : foods;
  res.json({ personalised: profile.hasHistory, items: rankForUser(pool, profile).slice(0, limit) });
});

export default router;
