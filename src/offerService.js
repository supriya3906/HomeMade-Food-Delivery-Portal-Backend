import { offers as offerStore, foods as foodStore } from './store.js';

export const getActiveFoodOffers = async () => {
  const all = await offerStore.all();
  const todayStr = new Date().toISOString().slice(0, 10);
  const activeOffers = all.filter((o) => {
    if (!o.active) return false;
    const startStr = o.startDate ? o.startDate.slice(0, 10) : '';
    const endStr = o.endDate ? o.endDate.slice(0, 10) : '';
    if (startStr && startStr > todayStr) return false;
    if (endStr && endStr < todayStr) return false;
    return true;
  });

  const map = new Map();
  for (const o of activeOffers) {
    if (o.foodId) {
      map.set(o.foodId, o);
    }
  }
  return { list: activeOffers, byFoodId: map };
};

export const getActiveFoodOffer = async (foodId) => {
  if (!foodId) return null;
  const { byFoodId } = await getActiveFoodOffers();
  return byFoodId.get(foodId) || null;
};
