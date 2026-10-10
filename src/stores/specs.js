// Field lists shared by the SQL stores: (jsKey, sqlColumn, type).
// The code uses camelCase keys, the tables snake_case columns.
export const F = (k, c, t = 'str') => ({ k, c, t });

export const USER = [
  F('id', 'id'), F('name', 'name'), F('email', 'email'), F('username', 'username'), F('phone', 'phone'),
  F('address', 'address'), F('city', 'city'), F('pincode', 'pincode'), F('preferences', 'preferences', 'json'),
  F('hash', 'password_hash'), F('salt', 'salt'), F('role', 'role'), F('createdAt', 'created_at', 'date')
];
export const ORDER = [
  F('id', 'id'), F('userId', 'user_id'), F('placedAt', 'placed_at', 'date'), F('status', 'status'), F('stage', 'stage', 'int'),
  F('paymentMethod', 'payment_method'), F('paymentLabel', 'payment_label'), F('paymentStatus', 'payment_status'),
  F('subtotal', 'subtotal', 'int'), F('deliveryFee', 'delivery_fee', 'int'), F('discount', 'discount', 'int'),
  F('couponCode', 'coupon_code'), F('paymentFee', 'payment_fee', 'int'), F('paymentFeeLabel', 'payment_fee_label'),
  F('tax', 'tax', 'int'), F('total', 'total', 'int'), F('invoiceNo', 'invoice_no'), F('transactionId', 'transaction_id'),
  F('paymentId', 'payment_id'), F('cardLast4', 'card_last4'), F('cardBrand', 'card_brand'), F('upiId', 'upi_id'),
  F('paidAt', 'paid_at', 'date'), F('nextStageAt', 'next_stage_at', 'date'), F('etaAt', 'eta_at', 'date'),
  F('cancelledAt', 'cancelled_at', 'date'), F('deliveryOtp', 'delivery_otp'),
  F('address', 'address', 'json'), F('chefs', 'chefs', 'json'), F('items', 'items', 'json'),
  F('stageTimes', 'stage_times', 'json'), F('partner', 'partner', 'json')
];
export const PAYMENT = [
  F('id', 'id'), F('userId', 'user_id'), F('status', 'status'), F('method', 'method'), F('flow', 'flow'),
  F('vpa', 'vpa'), F('cardLast4', 'card_last4'), F('cardBrand', 'card_brand'), F('amount', 'amount', 'int'),
  F('attempts', 'attempts', 'int'), F('createdAt', 'created_at', 'date'), F('expiresAt', 'expires_at', 'date'),
  F('snapshot', 'snapshot', 'json'), F('reason', 'reason'), F('transactionId', 'transaction_id'),
  F('orderId', 'order_id'), F('paidAt', 'paid_at', 'date'),
  F('events', 'events', 'json'), F('processingAt', 'processing_at', 'date')
];
export const COUPON = [
  F('code', 'code'), F('description', 'description'), F('min', 'min_order', 'int'),
  F('type', 'type'), F('value', 'value', 'int'), F('cap', 'cap', 'int')
];

export const REVIEW = [
  F('id', 'id'), F('userId', 'user_id'), F('rating', 'rating', 'int'), F('deliveryRating', 'delivery_rating', 'int'),
  F('comment', 'comment'), F('createdAt', 'created_at', 'date'), F('flagged', 'flagged', 'bool')
];

export const CHEF = [
  F('id', 'id'), F('name', 'name'), F('nameTa', 'name_ta'), F('city', 'city'), F('cityTa', 'city_ta'),
  F('cuisine', 'cuisine'), F('cuisineTa', 'cuisine_ta'), F('speciality', 'speciality'), F('specialityTa', 'speciality_ta'),
  F('bio', 'bio'), F('bioTa', 'bio_ta'), F('experience', 'experience', 'int'), F('rating', 'rating', 'num'),
  F('orders', 'orders_served', 'int'), F('color', 'color'), F('lat', 'lat', 'num'), F('lng', 'lng', 'num')
];
export const FOOD = [
  F('id', 'id'), F('name', 'name'), F('nameTa', 'name_ta'), F('category', 'category'), F('meals', 'meals', 'json'),
  F('chefId', 'chef_id'), F('icon', 'icon'), F('price', 'price', 'int'), F('rating', 'rating', 'num'), F('reviews', 'reviews', 'int'),
  F('prepMinutes', 'prep_minutes', 'int'), F('diet', 'diet'), F('spice', 'spice'), F('description', 'description'),
  F('descriptionTa', 'description_ta'), F('tags', 'tags', 'json'), F('photo', 'photo'), F('photoCredit', 'photo_credit', 'json'),
  F('photoQuery', 'photo_query', 'json'), F('available', 'available', 'bool')
];
export const PARTNER = [
  F('id', 'id'), F('name', 'name'), F('vehicle', 'vehicle'), F('phone', 'phone'), F('active', 'active', 'bool'),
  F('zoneId', 'zone_id'), F('area', 'area'), F('lat', 'lat', 'num'), F('lng', 'lng', 'num'), F('locationAt', 'location_at', 'date'),
  F('vehicleNo', 'vehicle_no'), F('maxOrders', 'max_orders', 'int'), F('online', 'online', 'bool')
];
// Delivery zones: a named service area with a centre point (used to place customers and partners).
export const ZONE = [
  F('id', 'id'), F('name', 'name'), F('lat', 'lat', 'num'), F('lng', 'lng', 'num'), F('radiusKm', 'radius_km', 'num'),
  F('keywords', 'keywords', 'json'), F('active', 'active', 'bool')
];

export const OFFER = [
  F('id', 'id'), F('name', 'name'), F('foodId', 'food_id'), F('code', 'code'), F('description', 'description'),
  F('discountType', 'discount_type'), F('discountValue', 'discount_value', 'int'),
  F('minOrder', 'min_order', 'int'), F('maxDiscount', 'max_discount', 'int'),
  F('startDate', 'start_date', 'date'), F('endDate', 'end_date', 'date'),
  F('active', 'active', 'bool'), F('createdAt', 'created_at', 'date')
];

// Columns added after the first release. Existing databases get them via ALTER TABLE at start-up.
// sql types: [sqlite, mysql]
const T = { str: ['TEXT', 'VARCHAR(120)'], int: ['INTEGER', 'INT'], num: ['REAL', 'DOUBLE'], date: ['TEXT', 'DATETIME'], json: ['TEXT', 'TEXT'], bool: ['INTEGER', 'TINYINT(1)'] };
export const COLUMN_MIGRATIONS = {
  delivery_partners: PARTNER.slice(5),
  chefs: CHEF.slice(2),
  foods: FOOD.slice(1),
  reviews: REVIEW.slice(-1),
  payments: PAYMENT.slice(-2),
  offers: [F('foodId', 'food_id')]
};
export const columnSql = (f, dialect) => {
  const [lite, my] = T[f.t] || T.str;
  const defaults = {
    max_orders: ' DEFAULT 2',
    online: ' DEFAULT 1',
    flagged: ' DEFAULT 0',
    available: ' DEFAULT 1',
    prep_minutes: ' DEFAULT 20',
    orders_served: ' DEFAULT 0'
  };
  return `${f.c} ${dialect === 'mysql' ? my : lite}${defaults[f.c] || ''}`;
};
