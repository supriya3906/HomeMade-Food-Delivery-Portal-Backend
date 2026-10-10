import { orders, coupons } from './store.js';
import { calculate, PAYMENT_METHODS } from './pricing.js';
import { buildLines, subtotalOf, originalSubtotalOf, offerSavingsOf } from './orderItems.js';
import { initialTracking } from './tracking.js';
import { validPoint } from './geo.js';

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const clean = (v) => String(v ?? '').trim();

export const cleanAddress = (a = {}) => {
  const address = {
    name: clean(a.name), phone: clean(a.phone), address: clean(a.address),
    city: clean(a.city), pincode: clean(a.pincode), notes: clean(a.notes)
  };
  // Optional exact position from the browser (used for delivery-partner distance maths).
  const gps = validPoint(a.lat, a.lng);
  if (gps) Object.assign(address, { lat: gps.lat, lng: gps.lng });
  if (!address.name || !address.phone || !address.address || !address.city || !address.pincode) {
    throw fail(400, 'Please fill in all required delivery details.');
  }
  if (!/^\d{10}$/.test(address.phone.replace(/\D/g, ''))) throw fail(400, 'Please enter a valid 10-digit phone number.');
  if (!/^\d{4,6}$/.test(address.pincode)) throw fail(400, 'Please enter a valid PIN code.');
  return address;
};

// Prices a cart on the server. Used for quotes, payments and orders alike.
export const priceCart = async (rawItems, paymentMethod, couponCode, membershipTier = null) => {
  const lines = await buildLines(rawItems);
  const code = clean(couponCode).toUpperCase();
  let coupon = null;
  if (code) {
    coupon = await coupons.byCode(code);
    if (!coupon) throw fail(400, 'This coupon code is not valid.');
  }
  const bill = calculate(subtotalOf(lines), paymentMethod, coupon, membershipTier);
  bill.originalSubtotal = originalSubtotalOf(lines);
  bill.foodOfferSavings = offerSavingsOf(lines);
  return { lines, bill };
};

// Creates the order. `extra` carries what only the payment step knows
// (transaction id, card digits, ...). Online payments call this only after the
// payment has succeeded.
export const createOrder = async ({ userId, lines, bill, address, extra = {} }) => {
  const method = PAYMENT_METHODS[bill.paymentMethod];
  const now = new Date();
  const id = `HMF${Date.now().toString().slice(-8)}`;
  const chefs = [...new Map(lines.map((l) => [l.chefId, l.chefName])).entries()].map(([chefId, name]) => ({ id: chefId, name }));

  const cleanBill = {
    paymentMethod: bill.paymentMethod,
    paymentLabel: bill.paymentLabel,
    subtotal: bill.subtotal,
    deliveryFee: bill.deliveryFee,
    discount: bill.discount,
    couponCode: bill.couponCode || null,
    paymentFee: bill.paymentFee || 0,
    paymentFeeLabel: bill.paymentFeeLabel || null,
    tax: bill.tax,
    total: bill.total
  };

  const order = await orders.insert({
    id,
    userId,
    placedAt: now.toISOString(),
    items: lines,
    chefs,
    ...cleanBill,
    cardLast4: null,
    ...extra,
    paymentStatus: method.online ? 'paid' : 'pay_on_delivery',
    paidAt: method.online ? now.toISOString() : null,
    invoiceNo: `INV-${now.getFullYear()}-${id.slice(3)}`,
    address,
    ...initialTracking(id, now.getTime())
  });

  return order;
};
