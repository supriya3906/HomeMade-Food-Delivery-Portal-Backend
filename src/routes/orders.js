import { Router } from 'express';
import { orders, reviews, partners } from '../store.js';
import { requireAuth } from '../auth.js';
import { PAYMENT_METHODS } from '../pricing.js';
import { syncOrder, forClient, liveTracking, STAGES } from '../tracking.js';
import { fail, clean, cleanAddress, priceCart, createOrder } from '../orderService.js';
import { getUserTier } from '../tierService.js';

const router = Router();
router.use(requireAuth);

const publicReview = (r) => (r ? { rating: r.rating, deliveryRating: r.deliveryRating, comment: r.comment || '', createdAt: r.createdAt } : null);
const present = async (order) => ({ ...forClient(order), review: publicReview(await reviews.byId(order.id)), tracking: await liveTracking(order) });

const own = async (req) => {
  const order = await orders.byId(req.params.id);
  if (!order || order.userId !== req.user.id) throw fail(404, 'Order not found.');
  return syncOrder(order);
};

router.get('/', async (req, res) => {
  const list = (await Promise.all((await orders.forUser(req.user.id)).map(syncOrder))).map(forClient);
  const byOrder = new Map((await reviews.forUser(req.user.id)).map((r) => [r.id, publicReview(r)]));
  res.json(list.map((o) => ({ ...o, review: byOrder.get(o.id) || null })));
});
router.get('/:id', async (req, res) => res.json(await present(await own(req))));

// Cash on delivery is the only order that can be placed without paying first.
// UPI orders are created by /api/payments once the payment succeeds,
// so nobody can get an order marked "paid" without going through it.
router.post('/', async (req, res) => {
  const method = PAYMENT_METHODS[req.body.paymentMethod];
  if (!method) throw fail(400, 'Please choose a valid payment method.');
  if (method.online) throw fail(400, 'Please complete the payment to place this order.');

  const address = cleanAddress(req.body.address);
  const membershipTier = req.user?.id ? await getUserTier(req.user.id) : null;
  const { lines, bill } = await priceCart(req.body.items, method.id, req.body.couponCode, membershipTier);
  const order = await createOrder({ userId: req.user.id, lines, bill, address });
  res.status(201).json(await present(order));
});

// Review a delivered order (once). rating = food, deliveryRating = delivery (optional).
router.post('/:id/review', async (req, res) => {
  const order = await own(req);
  if (order.status === 'cancelled' || order.stage < STAGES - 1) throw fail(400, 'You can review an order after it has been delivered.');
  if (await reviews.byId(order.id)) throw fail(409, 'You have already reviewed this order. Thank you!');

  const stars = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
  };
  const rating = stars(req.body.rating);
  if (!rating) throw fail(400, 'Please choose a star rating from 1 to 5.');
  const deliveryRating = req.body.deliveryRating ? stars(req.body.deliveryRating) : null;
  if (req.body.deliveryRating && !deliveryRating) throw fail(400, 'Delivery rating must be from 1 to 5 stars.');
  const comment = clean(req.body.comment).slice(0, 500);

  await reviews.insert({ id: order.id, userId: req.user.id, rating, deliveryRating, comment, createdAt: new Date().toISOString() });
  res.status(201).json(await present(order));
});

// Cancelling keeps the order (so it shows in history) and starts a refund
// for anything already paid online.
router.delete('/:id', async (req, res) => {
  const order = await own(req);
  if (order.status === 'cancelled') return res.json(await present(order));
  if (order.stage >= 2) throw fail(400, 'This order is already out for delivery and cannot be cancelled.');
  const updated = await orders.update(order.id, {
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    nextStageAt: null,
    etaAt: null,
    paymentStatus: order.paymentStatus === 'paid' ? 'refund_initiated' : 'cancelled'
  });
  if (order.partner?.id) {
    try { await partners.update(order.partner.id, { online: true, active: true }); } catch { /* ignore */ }
  }
  res.json(await present(updated));
});

// Remove a single order from your history (not the same as cancelling an active one).
// Allowed for any status; deletes the order and its review for good.
router.delete('/:id/remove', async (req, res) => {
  const order = await own(req);
  await orders.remove(order.id);
  res.json({ ok: true, id: order.id });
});

router.delete('/', async (req, res) => {
  await orders.removeAllForUser(req.user.id);
  res.json({ ok: true });
});

export default router;
