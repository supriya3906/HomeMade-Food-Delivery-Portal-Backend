-- Rasoi database schema for SQLite (same tables as MySQL). Runs automatically at start.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, username TEXT,
  phone TEXT, address TEXT, city TEXT, pincode TEXT, preferences TEXT,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  placed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT, payment_label TEXT, payment_status TEXT,
  subtotal INTEGER, delivery_fee INTEGER, discount INTEGER, coupon_code TEXT,
  payment_fee INTEGER, payment_fee_label TEXT, tax INTEGER, total INTEGER,
  invoice_no TEXT, transaction_id TEXT, payment_id TEXT, card_last4 TEXT, card_brand TEXT, upi_id TEXT,
  paid_at TEXT, next_stage_at TEXT, eta_at TEXT, cancelled_at TEXT, delivery_otp TEXT,
  address TEXT, chefs TEXT, items TEXT, stage_times TEXT, partner TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, placed_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status TEXT NOT NULL, method TEXT NOT NULL, flow TEXT NOT NULL, vpa TEXT, card_last4 TEXT, card_brand TEXT,
  amount INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  snapshot TEXT, reason TEXT, transaction_id TEXT, order_id TEXT, paid_at TEXT, events TEXT, processing_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL
);

-- Coupons start empty. type: flat (value = rupees) | percent (value = %, cap = max rupees) | delivery
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY, description TEXT, min_order INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, cap INTEGER, active INTEGER NOT NULL DEFAULT 1
);

-- One review per delivered order (id = the order id).
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating INTEGER NOT NULL, delivery_rating INTEGER, comment TEXT, created_at TEXT NOT NULL, flagged INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews (user_id);

CREATE TABLE IF NOT EXISTS chefs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_ta TEXT, city TEXT, city_ta TEXT, cuisine TEXT, cuisine_ta TEXT,
  speciality TEXT, speciality_ta TEXT, bio TEXT, bio_ta TEXT, experience INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0, orders_served INTEGER NOT NULL DEFAULT 0, color TEXT
);

CREATE TABLE IF NOT EXISTS foods (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_ta TEXT, category TEXT NOT NULL, meals TEXT,
  chef_id TEXT NOT NULL REFERENCES chefs (id), icon TEXT, price INTEGER NOT NULL,
  rating REAL NOT NULL DEFAULT 0, reviews INTEGER NOT NULL DEFAULT 0, prep_minutes INTEGER NOT NULL DEFAULT 20,
  diet TEXT NOT NULL, spice TEXT, description TEXT, description_ta TEXT, tags TEXT,
  photo TEXT, photo_credit TEXT, photo_query TEXT, available INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_foods_category ON foods (category);
CREATE INDEX IF NOT EXISTS idx_foods_chef ON foods (chef_id);

-- "Recently accessed": the dishes, chefs and menu sections each user opened last.
CREATE TABLE IF NOT EXISTS recent_views (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_type TEXT NOT NULL, item_id TEXT NOT NULL, viewed_at TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_user ON recent_views (user_id, viewed_at);

CREATE TABLE IF NOT EXISTS delivery_partners (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, vehicle TEXT, phone TEXT, active INTEGER NOT NULL DEFAULT 1,
  zone_id TEXT, area TEXT, lat REAL, lng REAL, location_at TEXT, vehicle_no TEXT, max_orders INTEGER DEFAULT 2, online INTEGER DEFAULT 1
);

-- Delivery zones (service areas). The centre point places customers and partners for distance maths.
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, radius_km REAL NOT NULL DEFAULT 8,
  keywords TEXT, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, food_id TEXT, description TEXT, code TEXT,
  discount_type TEXT NOT NULL DEFAULT 'percent', discount_value INTEGER NOT NULL DEFAULT 10,
  min_order INTEGER NOT NULL DEFAULT 0, max_discount INTEGER,
  start_date TEXT, end_date TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL
);
