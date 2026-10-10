// Test-mode UPI payment gateway.
//
// The flow mirrors a real gateway (Razorpay, Cashfree, ...): the server creates a
// payment for an exact, server-priced amount, the customer approves it in their UPI
// app (PhonePe, Google Pay, Paytm, BHIM ...), the server confirms it, and only then is
// the order created. No real money moves.
//
// Cash on delivery does not use this route — it is placed through POST /api/orders.
//
// To go live, replace the body of `confirm` with your gateway's verify call
// (signature / webhook check) — the routes and the front end stay the same.
import crypto from 'node:crypto';
import { Router } from 'express';
import { payments, orders } from '../store.js';
import { requireAuth } from '../auth.js';
import { PAYMENT_METHODS, UPI_APPS } from '../pricing.js';
import { fail, clean, cleanAddress, priceCart, createOrder } from '../orderService.js';
import { getUserTier } from '../tierService.js';
import { forClient } from '../tracking.js';
import { gateway } from '../paymentGateway.js';

const router = Router();
router.use(requireAuth);

const EXPIRY_MS = 5 * 60 * 1000;
const digits = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');

// A pending payment that ran out of time becomes "failed / expired".
const expire = async (p) =>
  p.status === 'pending' && Date.now() > new Date(p.expiresAt).getTime()
    ? payments.update(p.id, { status: 'failed', reason: 'This payment request expired. Please try again.' })
    : p;

const addEvent = (p, status, note) => [...(p.events || []), { status, at: new Date().toISOString(), note }];

const own = async (req) => {
  const p = await payments.byId(req.params.id);
  if (!p || p.userId !== req.user.id) throw fail(404, 'Payment not found.');
  const current = await expire(p);
  // A payment the gateway is still working on completes once its processing + verification time has passed.
  if (current.status === 'processing' && gateway.phase(current) === 'captured') return succeed(req, current);
  return current;
};

const publicPayment = (p, order) => ({
  id: p.id,
  status: p.status, // pending | processing | success | failed | cancelled
  phase: p.status === 'processing' ? gateway.phase(p) : null, // processing | verifying
  gateway: { name: gateway.label, live: gateway.live },
  events: p.events || [],
  createdAt: p.createdAt,
  paidAt: p.paidAt || null,
  reason: p.reason || null,
  amount: p.amount,
  method: p.method,
  flow: p.flow || 'upi_id',
  vpa: p.vpa || null,
  cardLast4: p.cardLast4 || null,
  cardBrand: p.cardBrand || null,
  bankName: p.snapshot?.bankName || null,
  upiApp: p.snapshot?.upiApp || null,
  upiAppLabel: UPI_APPS[p.snapshot?.upiApp] || 'UPI app',
  expiresAt: p.expiresAt,
  transactionId: p.transactionId || null,
  order: order ? forClient(order) : null
});

const findOrder = (p) => (p.orderId ? orders.byId(p.orderId) : null);

router.post('/', async (req, res) => {
  const { paymentMethod, couponCode, upi, card, netbanking, membershipTier } = req.body;
  const method = PAYMENT_METHODS[paymentMethod];
  if (!method || !method.online) throw fail(400, 'Please select a valid online payment method (UPI, Card, or Net Banking).');

  const address = cleanAddress(req.body.address);
  const activeMembership = req.user?.id ? await getUserTier(req.user.id) : null;
  const { lines, bill } = await priceCart(req.body.items, method.id, couponCode, activeMembership);

  let flow = 'upi_id';
  let vpa = null;
  let cardLast4 = null;
  let cardBrand = null;
  let upiApp = null;
  let bankName = null;

  if (method.id === 'card') {
    flow = 'card';
    const cleanNum = clean(card?.number).replace(/\s+/g, '');
    cardLast4 = cleanNum.slice(-4) || '8821';
    cardBrand = clean(card?.brand) || (/^4/.test(cleanNum) ? 'Visa' : /^5[1-5]/.test(cleanNum) ? 'Mastercard' : 'RuPay');
  } else if (method.id === 'netbanking') {
    flow = 'netbanking';
    bankName = clean(netbanking?.bank) || 'HDFC Bank';
  } else {
    flow = upi?.qr ? 'upi_qr' : 'upi_id';
    vpa = clean(upi?.vpa).toLowerCase() || `${req.user.email?.split('@')[0]}@oksbi`;
    upiApp = UPI_APPS[upi?.app] ? upi.app : 'gpay';
  }

  const payment = await payments.insert({
    id: `PAY${Date.now().toString().slice(-9)}${digits(2)}`,
    userId: req.user.id,
    status: 'pending',
    method: method.id,
    flow,
    vpa,
    cardLast4,
    cardBrand,
    amount: bill.total,
    attempts: 0,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + EXPIRY_MS).toISOString(),
    events: [{ status: 'initiated', at: new Date().toISOString(), note: `Payment initiated via ${method.label}` }],
    snapshot: {
      items: lines.map(({ id, quantity }) => ({ id, quantity })),
      address,
      couponCode: bill.couponCode,
      membershipTier: bill.membershipTier,
      upiApp,
      bankName
    }
  });
  res.status(201).json(publicPayment(payment));
});

router.get('/:id', async (req, res) => {
  const p = await own(req);
  res.json(publicPayment(p, await findOrder(p)));
});

async function succeed(req, p) {
  const { lines, bill } = await priceCart(p.snapshot.items, p.method, p.snapshot.couponCode, p.snapshot.membershipTier);
  if (bill.total !== p.amount) {
    return payments.update(p.id, { status: 'failed', reason: 'Prices changed while you were paying. Nothing was charged — please try again.', events: addEvent(p, 'failed', 'Price changed during payment') });
  }
  const transactionId = `TXN${digits(12)}`;
  let label = bill.paymentLabel;
  if (p.method === 'upi') {
    const appLabel = UPI_APPS[p.snapshot.upiApp];
    label = appLabel ? `UPI (${appLabel})` : 'UPI';
  } else if (p.method === 'card') {
    label = `${p.cardBrand || 'Card'} •••• ${p.cardLast4 || 'XXXX'}`;
  } else if (p.method === 'netbanking') {
    label = `Net Banking (${p.snapshot?.bankName || 'Bank'})`;
  }

  const order = await createOrder({
    userId: req.user.id,
    lines,
    bill,
    address: p.snapshot.address,
    extra: {
      paymentId: p.id,
      transactionId,
      upiId: p.vpa,
      cardLast4: p.cardLast4,
      cardBrand: p.cardBrand,
      paymentLabel: label
    }
  });
  return payments.update(p.id, { status: 'success', transactionId, orderId: order.id, paidAt: new Date().toISOString(), events: addEvent(p, 'success', 'Payment verified, order confirmed') });
}

// Approve a payment. { result: 'approve' | 'decline' } stands in for the customer's UPI app.
router.post('/:id/confirm', async (req, res) => {
  let p = await own(req);
  if (p.status === 'success') return res.json(publicPayment(p, await findOrder(p)));
  if (p.status === 'processing') return res.json(publicPayment(p));
  if (p.status !== 'pending') return res.json(publicPayment(p));

  if (req.body.result === 'decline') {
    const methodLabel = p.method === 'card' ? 'Bank 3D-Secure authentication' : p.method === 'netbanking' ? (p.snapshot?.bankName || 'Net Banking') : (UPI_APPS[p.snapshot?.upiApp] || 'your UPI app');
    p = await payments.update(p.id, { status: 'failed', reason: `The payment was cancelled or declined in ${methodLabel}.`, events: addEvent(p, 'failed', 'Declined by the customer') });
    return res.json(publicPayment(p));
  }
  if (req.body.result !== 'approve') throw fail(400, 'Payment authorization required.');

  // Approved: hand over to the gateway, which processes and verifies asynchronously.
  if (p.status === 'pending') {
    const note = p.method === 'card' ? '3D Secure OTP verified, gateway processing' : p.method === 'netbanking' ? 'Net Banking authorized, gateway processing' : 'Approved in UPI app, gateway processing';
    p = await payments.update(p.id, { status: 'processing', processingAt: new Date().toISOString(), attempts: (p.attempts || 0) + 1, events: addEvent(p, 'processing', note) });
  }
  res.json(publicPayment(p));
});

router.post('/:id/cancel', async (req, res) => {
  let p = await own(req);
  if (p.status === 'pending') p = await payments.update(p.id, { status: 'cancelled', reason: 'You cancelled this payment.', events: addEvent(p, 'cancelled', 'Cancelled by the customer') });
  res.json(publicPayment(p, await findOrder(p)));
});

export default router;
