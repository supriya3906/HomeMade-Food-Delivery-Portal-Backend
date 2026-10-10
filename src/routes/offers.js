import { Router } from 'express';
import { offers as offerStore, foods as foodStore } from '../store.js';

const router = Router();

// Public / Customer endpoint: active food offers valid for today
router.get('/', async (req, res) => {
  const [all, allFoodsList] = await Promise.all([offerStore.all(), foodStore.all()]);
  const foodMap = new Map(allFoodsList.map((f) => [f.id, f]));
  const todayStr = new Date().toISOString().slice(0, 10);

  const active = all.filter((o) => {
    if (!o.active) return false;
    const startStr = o.startDate ? o.startDate.slice(0, 10) : '';
    const endStr = o.endDate ? o.endDate.slice(0, 10) : '';
    if (startStr && startStr > todayStr) return false;
    if (endStr && endStr < todayStr) return false;
    return true;
  });

  res.json(active.map((o) => {
    const food = o.foodId ? foodMap.get(o.foodId) : null;
    const discountPct = Number(o.discountValue) || 10;
    const originalPrice = food ? food.price : null;
    const discountedPrice = food ? Math.round(food.price * (1 - discountPct / 100)) : null;

    return {
      id: o.id,
      foodId: o.foodId || null,
      foodName: food?.name || o.name || 'Special Dish Offer',
      foodPhoto: food?.photo || null,
      foodCategory: food?.category || '',
      foodDiet: food?.diet || '',
      title: o.name || (food ? `${discountPct}% Off on ${food.name}` : 'Special Offer'),
      name: o.name || (food ? `${discountPct}% Off on ${food.name}` : 'Special Offer'),
      description: o.description || (food ? `Special offer on ${food.name} at ₹${discountedPrice}` : ''),
      discountType: 'percent',
      discountValue: discountPct,
      discountPct,
      originalPrice,
      discountedPrice,
      savings: originalPrice && discountedPrice ? originalPrice - discountedPrice : null,
      startDate: o.startDate,
      endDate: o.endDate,
      active: !!o.active,
      createdAt: o.createdAt
    };
  }));
});

export default router;
