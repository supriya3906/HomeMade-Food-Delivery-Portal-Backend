// MySQL data layer (mysql2). Creates the database and tables on first start.
import mysql from 'mysql2/promise';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql/schema.sql');

import { USER, ORDER, PAYMENT, COUPON, REVIEW, CHEF, FOOD, PARTNER, ZONE, OFFER, COLUMN_MIGRATIONS, columnSql } from './specs.js';

const toDb = (f, v) => {
  if (v === undefined || v === null) return null;
  if (f.t === 'date') return new Date(v);
  if (f.t === 'json') return JSON.stringify(v);
  if (f.t === 'bool') return v ? 1 : 0;
  return v;
};
const fromDb = (f, v) => {
  if (v === undefined || v === null) return null;
  if (f.t === 'date') return new Date(v).toISOString();
  if (f.t === 'json') return typeof v === 'string' ? JSON.parse(v) : v; // MariaDB returns text, MySQL objects
  if (f.t === 'int' || f.t === 'num') return Number(v);
  if (f.t === 'bool') return Boolean(Number(v));
  return v;
};

const makeTable = (pool, name, spec) => {
  const byKey = new Map(spec.map((f) => [f.k, f]));
  const field = (k) => {
    const f = byKey.get(k);
    if (!f) throw new Error(`Table ${name}: unknown field "${k}"`);
    return f;
  };
  const fromRow = (row) => Object.fromEntries(spec.map((f) => {
    let val = row[f.c];
    if (val === undefined || val === null) {
      if (f.c === 'orders_served' && row['orders'] != null) val = row['orders'];
      else if (f.c === 'prep_minutes' && row['prep_time'] != null) val = parseInt(row['prep_time'], 10) || 20;
      else if (f.c === 'available' && row['available'] === undefined) val = 1;
    }
    return [f.k, fromDb(f, val)];
  }));
  const t = {
    async find(where, params = [], tail = '') {
      const [rows] = await pool.query(`SELECT * FROM \`${name}\` WHERE ${where} ${tail}`, params);
      return rows.map(fromRow);
    },
    async one(where, params) { return (await t.find(where, params, 'LIMIT 1'))[0]; },
    async insert(obj) {
      const fields = Object.keys(obj).map((k) => byKey.get(k)).filter(Boolean);
      await pool.query(
        `INSERT INTO \`${name}\` (${fields.map((f) => `\`${f.c}\``).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
        fields.map((f) => toDb(f, obj[f.k]))
      );
      return obj;
    },
    async update(id, patch) {
      const fields = Object.keys(patch).map((k) => byKey.get(k)).filter(Boolean);
      if (fields.length) {
        await pool.query(
          `UPDATE \`${name}\` SET ${fields.map((f) => `\`${f.c}\` = ?`).join(', ')} WHERE id = ?`,
          [...fields.map((f) => toDb(f, patch[f.k])), id]
        );
      }
      return t.one('id = ?', [id]) || null;
    },
    all: (tail = '') => t.find('1 = 1', [], tail),
    async remove(id) { await pool.query(`DELETE FROM \`${name}\` WHERE id = ?`, [id]); }
  };
  return t;
};

const friendly = (err, cfg) => {
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
    return `Could not reach MySQL at ${cfg.host}:${cfg.port}. Is MySQL running? (Start it in XAMPP / Services, then run this again.)`;
  }
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    return `MySQL rejected the user "${cfg.user}" or its password. Check DB_USER and DB_PASSWORD in backend/.env.`;
  }
  return err.message;
};

export const createMysqlStore = async (cfg) => {
  if (!/^\w+$/.test(cfg.name)) throw new Error('DB_NAME may only contain letters, numbers and underscores.');
  if (process.env.VERCEL && (cfg.host === 'localhost' || cfg.host === '127.0.0.1')) {
    throw new Error('Running on Vercel with DB_HOST="localhost". Localhost is not reachable from Vercel. Set your cloud MySQL host in Vercel settings.');
  }
  const ssl = (cfg.ssl || process.env.DB_SSL === 'true' || process.env.DB_SSL === '1') ? { rejectUnauthorized: false } : undefined;
  const base = { host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, timezone: 'Z', connectTimeout: 4000, ...(ssl ? { ssl } : {}) };
  let pool;
  try {
    try {
      const admin = await mysql.createConnection(base);
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await admin.end();
    } catch (adminErr) {
      // Cloud databases like TiDB/Aiven might not allow CREATE DATABASE or connecting without a database name.
      console.warn(`[database] Notice: ${adminErr.message}`);
    }

    pool = mysql.createPool({ ...base, database: cfg.name, connectionLimit: 10 });
    let ddl = '';
    const candidatePaths = [
      schemaFile,
      path.resolve(process.cwd(), 'sql/schema.sql'),
      path.resolve(process.cwd(), 'backend/sql/schema.sql')
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        ddl = readFileSync(p, 'utf8').replace(/^\s*--.*$/gm, '');
        break;
      }
    }
    if (ddl) {
      for (const statement of ddl.split(';').map((s) => s.trim()).filter(Boolean)) await pool.query(statement);
    }
    // Databases created by an older version: add columns that were introduced later.
    const [cols] = await pool.query(
      "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'preferences'",
      [cfg.name]
    );
    if (!Number(cols[0].c)) await pool.query('ALTER TABLE users ADD COLUMN preferences JSON NULL');
    const [roleCol] = await pool.query(
      "SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'",
      [cfg.name]
    );
    if (!Number(roleCol[0].c)) await pool.query("ALTER TABLE users ADD COLUMN role VARCHAR(12) NOT NULL DEFAULT 'user'");
    // Columns added by later versions (partners, payments, reviews).
    for (const [table, fields] of Object.entries(COLUMN_MIGRATIONS)) {
      const [have] = await pool.query('SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [cfg.name, table]);
      const names = new Set(have.map((r) => r.n));
      for (const f of fields) if (!names.has(f.c)) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${columnSql(f, 'mysql')}`);
    }
  } catch (err) {
    if (pool) await pool.end().catch(() => {});
    throw new Error(friendly(err, cfg));
  }

  const users = makeTable(pool, 'users', USER);
  const orders = makeTable(pool, 'orders', ORDER);
  const payments = makeTable(pool, 'payments', PAYMENT);
  const coupons = makeTable(pool, 'coupons', COUPON);
  const reviews = makeTable(pool, 'reviews', REVIEW);
  const chefs = makeTable(pool, 'chefs', CHEF);
  const foods = makeTable(pool, 'foods', FOOD);
  const partners = makeTable(pool, 'delivery_partners', PARTNER);
  const zones = makeTable(pool, 'zones', ZONE);
  const offers = makeTable(pool, 'offers', OFFER);

  return {
    kind: 'mysql',
    info: `MySQL database "${cfg.name}" on ${cfg.host}:${cfg.port}`,
    users: {
      byId: (id) => users.one('id = ?', [id]),
      byEmail: (email) => users.one('email = ?', [email]),
      byLogin: (value) => users.one('email = ? OR username = ?', [value, value]),
      insert: (u) => users.insert(u),
      update: (id, patch) => users.update(id, patch),
      async remove(id) { await pool.query('DELETE FROM users WHERE id = ?', [id]); }, // orders/payments cascade
      all: () => users.all('ORDER BY created_at DESC'),
      async countByRole(role) { const [r] = await pool.query('SELECT COUNT(*) AS c FROM users WHERE role = ?', [role]); return Number(r[0].c); }
    },
    orders: {
      forUser: (userId) => orders.find('user_id = ?', [userId], 'ORDER BY placed_at DESC'),
      byId: (id) => orders.one('id = ?', [id]),
      insert: (o) => orders.insert(o),
      update: (id, patch) => orders.update(id, patch),
      async removeAllForUser(userId) { await pool.query('DELETE FROM orders WHERE user_id = ?', [userId]); },
      async remove(id) { await pool.query('DELETE FROM orders WHERE id = ?', [id]); }, // reviews cascade
      all: () => orders.all('ORDER BY placed_at DESC')
    },
    payments: {
      byId: (id) => payments.one('id = ?', [id]),
      insert: (p) => payments.insert(p),
      update: (id, patch) => payments.update(id, patch),
      all: () => payments.all('ORDER BY created_at DESC')
    },
    resets: {
      async get(email) {
        const [rows] = await pool.query('SELECT * FROM password_resets WHERE email = ?', [email]);
        const r = rows[0];
        return r && { hash: r.code_hash, expiresAt: new Date(r.expires_at).getTime(), tries: Number(r.tries), sentAt: new Date(r.sent_at).getTime() };
      },
      async set(email, e) {
        await pool.query(
          'REPLACE INTO password_resets (email, code_hash, expires_at, tries, sent_at) VALUES (?, ?, ?, ?, ?)',
          [email, e.hash, new Date(e.expiresAt), e.tries, new Date(e.sentAt)]
        );
      },
      async delete(email) { await pool.query('DELETE FROM password_resets WHERE email = ?', [email]); }
    },
    coupons: {
      byCode: async (code) => (await coupons.one('code = ? AND active = 1', [code])) || null
    },
    reviews: {
      byId: async (orderId) => (await reviews.one('id = ?', [orderId])) || null,
      forUser: (userId) => reviews.find('user_id = ?', [userId]),
      insert: (r) => reviews.insert(r),
      update: (id, patch) => reviews.update(id, patch),
      all: () => reviews.all('ORDER BY created_at DESC')
    },
    chefs: { all: () => chefs.all('ORDER BY id'), byId: (id) => chefs.one('id = ?', [id]), insert: (c) => chefs.insert(c), update: (id, p) => chefs.update(id, p), remove: (id) => chefs.remove(id) },
    foods: { all: () => foods.all('ORDER BY id'), byId: (id) => foods.one('id = ?', [id]), insert: (f) => foods.insert(f), update: (id, p) => foods.update(id, p), remove: (id) => foods.remove(id) },
    partners: { all: () => partners.all('ORDER BY name'), byId: (id) => partners.one('id = ?', [id]), insert: (x) => partners.insert(x), update: (id, p) => partners.update(id, p), remove: (id) => partners.remove(id) },
    zones: { all: () => zones.all('ORDER BY name'), byId: (id) => zones.one('id = ?', [id]), insert: (x) => zones.insert(x), update: (id, p) => zones.update(id, p), remove: (id) => zones.remove(id) },
    recent: {
      async touch(userId, type, itemId) {
        await pool.query(
          'INSERT INTO recent_views (user_id, item_type, item_id, viewed_at, views) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE viewed_at = VALUES(viewed_at), views = views + 1',
          [userId, type, itemId, new Date()]
        );
        // keep only the latest 60 per user
        await pool.query(
          'DELETE FROM recent_views WHERE user_id = ? AND (item_type, item_id) NOT IN (SELECT item_type, item_id FROM (SELECT item_type, item_id FROM recent_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT 60) keep)',
          [userId, userId]
        );
      },
      async list(userId, limit = 30) {
        const [rows] = await pool.query('SELECT item_type, item_id, viewed_at, views FROM recent_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT ?', [userId, Number(limit)]);
        return rows.map((r) => ({ type: r.item_type, id: r.item_id, viewedAt: new Date(r.viewed_at).toISOString(), views: Number(r.views) }));
      },
      async clear(userId) { await pool.query('DELETE FROM recent_views WHERE user_id = ?', [userId]); }
    },
    offers: {
      all: () => offers.all('ORDER BY created_at DESC'),
      byId: (id) => offers.one('id = ?', [id]),
      insert: (o) => offers.insert(o),
      update: (id, p) => offers.update(id, p),
      remove: (id) => offers.remove(id),
      active: () => offers.find('active = 1', [], 'ORDER BY created_at DESC')
    },
    settings: {
      async get(key) {
        const [rows] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
        const r = rows[0];
        if (!r) return null;
        return typeof r.setting_value === 'string' ? JSON.parse(r.setting_value) : r.setting_value;
      },
      async set(key, val) {
        await pool.query(
          'REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)',
          [key, JSON.stringify(val), new Date()]
        );
      }
    }
  };
};
