-- Rasoi database schema. Run automatically when the backend starts
-- (every statement is IF NOT EXISTS, so it is safe to run again).

CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(40)  NOT NULL PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  username      VARCHAR(190) NULL,
  phone         VARCHAR(20)  NULL,
  address       VARCHAR(255) NULL,
  city          VARCHAR(80)  NULL,
  pincode       VARCHAR(10)  NULL,
  preferences   JSON         NULL,   -- language, font size, theme ... saved per user
  password_hash VARCHAR(255) NOT NULL,
  salt          VARCHAR(64)  NOT NULL,
  role          VARCHAR(12)  NOT NULL DEFAULT 'user',   -- user | admin
  created_at    DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
  id                 VARCHAR(32)  NOT NULL PRIMARY KEY,
  user_id            VARCHAR(40)  NOT NULL,
  placed_at          DATETIME(3)  NOT NULL,
  status             VARCHAR(16)  NOT NULL DEFAULT 'active',   -- active | cancelled
  stage              TINYINT      NOT NULL DEFAULT 0,          -- 0 placed, 1 preparing, 2 out for delivery, 3 delivered
  payment_method     VARCHAR(16)  NULL,                        -- cod | upi
  payment_label      VARCHAR(40)  NULL,
  payment_status     VARCHAR(24)  NULL,                        -- paid | pay_on_delivery | refund_initiated | cancelled
  subtotal           INT          NULL,
  delivery_fee       INT          NULL,
  discount           INT          NULL,
  coupon_code        VARCHAR(40)  NULL,
  payment_fee        INT          NULL,
  payment_fee_label  VARCHAR(80)  NULL,
  tax                INT          NULL,
  total              INT          NULL,
  invoice_no         VARCHAR(40)  NULL,
  transaction_id     VARCHAR(40)  NULL,
  payment_id         VARCHAR(40)  NULL,
  card_last4         VARCHAR(4)   NULL,
  card_brand         VARCHAR(20)  NULL,
  upi_id             VARCHAR(80)  NULL,
  paid_at            DATETIME(3)  NULL,
  next_stage_at      DATETIME(3)  NULL,
  eta_at             DATETIME(3)  NULL,
  cancelled_at       DATETIME(3)  NULL,
  delivery_otp       VARCHAR(8)   NULL,
  address            JSON         NULL,
  chefs              JSON         NULL,
  items              JSON         NULL,
  stage_times        JSON         NULL,
  partner            JSON         NULL,
  KEY idx_orders_user (user_id, placed_at),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payments (
  id             VARCHAR(32)  NOT NULL PRIMARY KEY,
  user_id        VARCHAR(40)  NOT NULL,
  status         VARCHAR(16)  NOT NULL,                        -- pending | success | failed | cancelled
  method         VARCHAR(16)  NOT NULL,
  flow           VARCHAR(16)  NOT NULL,                        -- upi_id | card
  vpa            VARCHAR(80)  NULL,
  card_last4     VARCHAR(4)   NULL,
  card_brand     VARCHAR(20)  NULL,
  amount         INT          NOT NULL,
  attempts       INT          NOT NULL DEFAULT 0,
  created_at     DATETIME(3)  NOT NULL,
  expires_at     DATETIME(3)  NOT NULL,
  snapshot       JSON         NULL,
  reason         VARCHAR(255) NULL,
  transaction_id VARCHAR(40)  NULL,
  order_id       VARCHAR(32)  NULL,
  paid_at        DATETIME(3)  NULL,
  KEY idx_payments_user (user_id),
  CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_resets (
  email      VARCHAR(190) NOT NULL PRIMARY KEY,
  code_hash  VARCHAR(64)  NOT NULL,
  expires_at DATETIME(3)  NOT NULL,
  tries      INT          NOT NULL DEFAULT 0,
  sent_at    DATETIME(3)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Coupons start EMPTY. Add one with, for example:
--   INSERT INTO coupons (code, description, min_order, type, value, cap)
--   VALUES ('SAVE50', 'Flat Rs 50 off above Rs 199', 199, 'flat', 50, NULL);
-- type: flat (value = rupees) | percent (value = %, cap = max rupees) | delivery (free delivery)
CREATE TABLE IF NOT EXISTS coupons (
  code        VARCHAR(40)  NOT NULL PRIMARY KEY,
  description VARCHAR(160) NULL,
  min_order   INT          NOT NULL DEFAULT 0,
  type        VARCHAR(12)  NOT NULL,
  value       INT          NOT NULL DEFAULT 0,
  cap         INT          NULL,
  active      TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One review per delivered order (id = the order id).
CREATE TABLE IF NOT EXISTS reviews (
  id              VARCHAR(32)  NOT NULL PRIMARY KEY,
  user_id         VARCHAR(40)  NOT NULL,
  rating          TINYINT      NOT NULL,
  delivery_rating TINYINT      NULL,
  comment         VARCHAR(600) NULL,
  created_at      DATETIME(3)  NOT NULL,
  KEY idx_reviews_user (user_id),
  CONSTRAINT fk_reviews_order FOREIGN KEY (id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The menu. Chefs and dishes live in the database (managed by the admin dashboard) and are
-- loaded from backend/src/data/catalog.json the first time the server starts with empty tables.
CREATE TABLE IF NOT EXISTS chefs (
  id            VARCHAR(20)  NOT NULL PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  name_ta       VARCHAR(160) NULL,
  city          VARCHAR(80)  NULL,
  city_ta       VARCHAR(80)  NULL,
  cuisine       VARCHAR(120) NULL,
  cuisine_ta    VARCHAR(160) NULL,
  speciality    VARCHAR(255) NULL,
  speciality_ta VARCHAR(400) NULL,
  bio           TEXT         NULL,
  bio_ta        TEXT         NULL,
  experience    INT          NOT NULL DEFAULT 0,
  rating        DOUBLE       NOT NULL DEFAULT 0,
  orders_served INT          NOT NULL DEFAULT 0,
  color         VARCHAR(9)   NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS foods (
  id             VARCHAR(20)  NOT NULL PRIMARY KEY,
  name           VARCHAR(160) NOT NULL,
  name_ta        VARCHAR(220) NULL,
  category       VARCHAR(20)  NOT NULL,                       -- breakfast | lunch | dinner | snacks | sweets | drinks | brunch
  meals          JSON         NULL,                           -- every menu tab the dish appears in
  chef_id        VARCHAR(20)  NOT NULL,
  icon           VARCHAR(16)  NULL,
  price          INT          NOT NULL,
  rating         DOUBLE       NOT NULL DEFAULT 0,
  reviews        INT          NOT NULL DEFAULT 0,
  prep_minutes   INT          NOT NULL DEFAULT 20,
  diet           VARCHAR(12)  NOT NULL,                       -- veg | vegan | non-veg
  spice          VARCHAR(12)  NULL,                           -- None | Mild | Medium | Hot
  description    TEXT         NULL,
  description_ta TEXT         NULL,
  tags           JSON         NULL,
  photo          VARCHAR(500) NULL,
  photo_credit   JSON         NULL,
  photo_query    JSON         NULL,
  available      TINYINT(1)   NOT NULL DEFAULT 1,
  KEY idx_foods_category (category),
  KEY idx_foods_chef (chef_id),
  CONSTRAINT fk_foods_chef FOREIGN KEY (chef_id) REFERENCES chefs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Recently accessed": the dishes, chefs and menu sections each user opened last.
CREATE TABLE IF NOT EXISTS recent_views (
  user_id   VARCHAR(40)  NOT NULL,
  item_type VARCHAR(12)  NOT NULL,                            -- food | chef | category
  item_id   VARCHAR(40)  NOT NULL,
  viewed_at DATETIME(3)  NOT NULL,
  views     INT          NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, item_type, item_id),
  KEY idx_recent_user (user_id, viewed_at),
  CONSTRAINT fk_recent_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Delivery partners are added by the admin. Orders are assigned to an active partner when cooking starts.
CREATE TABLE IF NOT EXISTS delivery_partners (
  id      VARCHAR(20)  NOT NULL PRIMARY KEY,
  name    VARCHAR(120) NOT NULL,
  vehicle VARCHAR(40)  NULL,
  phone   VARCHAR(20)  NULL,
  active  TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Delivery zones (service areas). The centre point places customers and partners for distance maths.
CREATE TABLE IF NOT EXISTS zones (
  id        VARCHAR(20)  NOT NULL PRIMARY KEY,
  name      VARCHAR(80)  NOT NULL,
  lat       DOUBLE       NOT NULL,
  lng       DOUBLE       NOT NULL,
  radius_km DOUBLE       NOT NULL DEFAULT 8,
  keywords  TEXT         NULL,
  active    TINYINT(1)   NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS offers (
  id            VARCHAR(40)  NOT NULL PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  food_id       VARCHAR(40)  NULL,
  code          VARCHAR(40)  NULL,
  description   TEXT         NULL,
  discount_type VARCHAR(16)  NOT NULL DEFAULT 'percent',
  discount_value INT         NOT NULL DEFAULT 10,
  min_order     INT          NOT NULL DEFAULT 0,
  max_discount  INT          NULL,
  start_date    DATETIME(3)  NULL,
  end_date      DATETIME(3)  NULL,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL,
  KEY idx_offers_food (food_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS system_settings (
  setting_key   VARCHAR(80)  NOT NULL PRIMARY KEY,
  setting_value JSON         NOT NULL,
  updated_at    DATETIME(3)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
