// Single source of truth for what an order costs.
//
//   Cash on delivery : food + delivery fee            + tax
//   UPI              : food (no delivery fee)         + tax
//
// Tax (GST) is charged on the food total for every payment method.
// A coupon (optional, from the `coupons` table) is taken off the payable amount.
export const DELIVERY_FEE = 35; // charged on cash on delivery only
export const TAX_RATE = 0.05; // 5% GST on the food total, all payment methods

export const UPI_APPS = {
  phonepe: 'PhonePe',
  gpay: 'Google Pay',
  paytm: 'Paytm',
  bhim: 'BHIM UPI',
  cred: 'CRED'
};

export const PAYMENT_METHODS = {
  cod: { id: 'cod', label: 'Cash on delivery', online: false },
  upi: { id: 'upi', label: 'UPI', online: true },
  card: { id: 'card', label: 'Credit / Debit Card', online: true },
  netbanking: { id: 'netbanking', label: 'Net Banking', online: true }
};

export const MEMBERSHIP_TIERS = {
  silver: { id: 'silver', name: 'Silver Card', discountPct: 5, freeDelivery: false, label: 'Silver Award Card (5% Off)' },
  gold: { id: 'gold', name: 'Gold Card', discountPct: 10, freeDelivery: false, label: 'Gold Award Card (10% Off)' },
  premium: { id: 'premium', name: 'Premium Card', discountPct: 15, freeDelivery: true, label: 'Premium Award Card (15% Off + Free Delivery)' }
};

const fail = (message) => Object.assign(new Error(message), { status: 400 });

export const deliveryFeeFor = (paymentMethod, isPremiumMember = false) => {
  if (isPremiumMember) return 0;
  return paymentMethod === 'cod' ? DELIVERY_FEE : 0;
};

const couponDiscount = (coupon, subtotal, deliveryFee) => {
  const min = coupon.min || 0;
  if (subtotal < min) throw fail(`Add ₹${min - subtotal} more to use ${coupon.code}.`);
  if (coupon.type === 'delivery') {
    if (deliveryFee === 0) throw fail('This order already has free delivery.');
    return deliveryFee;
  }
  let value = coupon.type === 'percent' ? Math.round((subtotal * coupon.value) / 100) : coupon.value;
  if (coupon.type === 'percent' && coupon.cap) value = Math.min(value, coupon.cap);
  return Math.min(value, subtotal + deliveryFee);
};

// `coupon` is a row from the coupons table (or null).
// `membershipTier` is 'silver' | 'gold' | 'premium' (or null).
export const calculate = (subtotal, paymentMethod, coupon = null, membershipTier = null) => {
  const method = PAYMENT_METHODS[paymentMethod];
  if (!method) throw fail('Please choose a valid payment method (UPI, Card, Net Banking, or Cash on delivery).');

  const tierKey = typeof membershipTier === 'string' ? membershipTier.toLowerCase() : membershipTier?.id || membershipTier?.tier;
  const member = (typeof membershipTier === 'object' && membershipTier && membershipTier.discountPct !== undefined)
    ? membershipTier
    : (MEMBERSHIP_TIERS[tierKey] || (tierKey === 'vip' ? MEMBERSHIP_TIERS.premium : null));

  const deliveryFee = subtotal === 0 ? 0 : deliveryFeeFor(method.id, member?.freeDelivery);
  const coupDisc = coupon ? couponDiscount(coupon, subtotal, deliveryFee) : 0;
  const memberDisc = member ? Math.round((subtotal * member.discountPct) / 100) : 0;
  const totalDiscount = Math.min(coupDisc + memberDisc, subtotal + deliveryFee);

  const taxableFood = Math.max(0, subtotal - memberDisc);
  const tax = Math.round(taxableFood * TAX_RATE);

  return {
    paymentMethod: method.id,
    paymentLabel: method.label,
    subtotal,
    deliveryFee,
    discount: totalDiscount,
    couponDiscount: coupDisc,
    membershipDiscount: memberDisc,
    membershipTier: member ? member.id : null,
    membershipLabel: member ? member.label : null,
    couponCode: coupon ? coupon.code : null,
    paymentFee: 0,
    paymentFeeLabel: null,
    tax,
    total: Math.max(0, subtotal + deliveryFee - totalDiscount + tax)
  };
};

