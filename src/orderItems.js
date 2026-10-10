import { getFood, getChef } from './catalog.js';
import { getActiveFoodOffer } from './offerService.js';

// Turns [{ id, quantity }] from the client into trusted line items using the
// server's own prices (read from the database) — the client never decides what something costs.
export const buildLines = async (rawItems) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw Object.assign(new Error('Your cart is empty.'), { status: 400 });
  }
  const merged = new Map();
  for (const item of rawItems) {
    const qty = Number(item?.quantity);
    if (!(await getFood(item?.id)) || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw Object.assign(new Error('One of the items in your cart is not available.'), { status: 400 });
    }
    merged.set(item.id, (merged.get(item.id) || 0) + qty);
  }
  const lines = [];
  for (const [id, quantity] of merged) {
    const f = await getFood(id);
    const chef = await getChef(f.chefId);
    const offer = await getActiveFoodOffer(id);

    let price = f.price;
    let originalPrice = f.price;
    let offerDetails = null;

    if (offer) {
      const discountPct = Number(offer.discountValue) || 10;
      price = Math.round(f.price * (1 - discountPct / 100));
      offerDetails = {
        offerId: offer.id,
        title: offer.name,
        discountPct,
        savedPerItem: originalPrice - price
      };
    }

    lines.push({
      id,
      name: f.name,
      originalPrice,
      price,
      quantity,
      chefId: f.chefId,
      chefName: chef?.name || '',
      offer: offerDetails
    });
  }
  return lines;
};

export const subtotalOf = (lines) => lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
export const originalSubtotalOf = (lines) => lines.reduce((sum, l) => sum + (l.originalPrice || l.price) * l.quantity, 0);
export const offerSavingsOf = (lines) => lines.reduce((sum, l) => sum + ((l.originalPrice || l.price) - l.price) * l.quantity, 0);
