import { Router } from 'express';
import { allFoods, allChefs, getFood, getChef } from '../catalog.js';
import { searchFoods } from '../search.js';
import { PAYMENT_METHODS, UPI_APPS, DELIVERY_FEE, TAX_RATE } from '../pricing.js';
import { priceCart } from '../orderService.js';
import { optionalAuth } from '../auth.js';
import { getTierSettings, getUserTier } from '../tierService.js';
import { getActiveFoodOffers } from '../offerService.js';

const router = Router();

// Menu (read from the database). Filters: ?category=sweets&diet=veg&maxPrice=150&q=jalebi&sort=rating&chef=c1
router.get('/foods', async (req, res) => {
  const { category, chef, diet, q, sort } = req.query;
  const maxPrice = Number(req.query.maxPrice) || 0;
  const [foods, chefs, { byFoodId }] = await Promise.all([allFoods(), allChefs(), getActiveFoodOffers()]);
  const enriched = foods.map((f) => {
    const o = byFoodId.get(f.id);
    if (!o) return f;
    const discountPct = Number(o.discountValue) || 10;
    return {
      ...f,
      offer: {
        id: o.id,
        title: o.name,
        discountPct,
        originalPrice: f.price,
        discountedPrice: Math.round(f.price * (1 - discountPct / 100)),
        endDate: o.endDate
      }
    };
  });
  const list = searchFoods(enriched, chefs, { q: String(q || ''), category: String(category || ''), diet: String(diet || ''), maxPrice, sort: String(sort || 'popular') });
  res.json(chef ? list.filter((f) => f.chefId === chef) : list);
});
router.get('/foods/:id', async (req, res) => {
  const food = await getFood(req.params.id);
  if (!food) return res.status(404).json({ message: 'Dish not found.' });
  const { byFoodId } = await getActiveFoodOffers();
  const o = byFoodId.get(food.id);
  if (o) {
    const discountPct = Number(o.discountValue) || 10;
    return res.json({
      ...food,
      offer: {
        id: o.id,
        title: o.name,
        discountPct,
        originalPrice: food.price,
        discountedPrice: Math.round(food.price * (1 - discountPct / 100)),
        endDate: o.endDate
      }
    });
  }
  res.json(food);
});

router.get('/chefs', async (req, res) => res.json(await allChefs()));
router.get('/chefs/:id', async (req, res) => {
  const chef = await getChef(req.params.id);
  if (!chef) return res.status(404).json({ message: 'Chef not found.' });
  res.json({ ...chef, dishes: (await allFoods()).filter((f) => f.chefId === chef.id) });
});

router.get('/pricing/config', (req, res) =>
  res.json({
    deliveryFee: DELIVERY_FEE, // cash on delivery only; UPI has no delivery fee
    taxRate: TAX_RATE,
    upiApps: UPI_APPS,
    paymentMethods: Object.values(PAYMENT_METHODS)
  })
);

router.get('/tiers', async (req, res) => {
  res.json(await getTierSettings());
});

// Live price breakdown for the checkout page: automatically resolves customer's earned tier
router.post('/pricing/quote', optionalAuth, async (req, res) => {
  let tier = null;
  if (req.user?.id) {
    tier = await getUserTier(req.user.id);
  }
  const { bill } = await priceCart(req.body.items, req.body.paymentMethod, req.body.couponCode, tier);
  res.json(bill);
});

export default router;
