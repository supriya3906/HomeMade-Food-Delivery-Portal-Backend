// SQLite data layer using sql.js (pure JavaScript — nothing to install or compile).
// The whole database is one file (data/rasoi.sqlite). It is kept in memory and saved
// to that file a moment after every change, and again when the server stops.
import initSqlJs from 'sql.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER, ORDER, PAYMENT, COUPON, REVIEW, CHEF, FOOD, PARTNER, ZONE, OFFER, COLUMN_MIGRATIONS, columnSql } from './specs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaFile = path.resolve(here, '../../sql/schema.sqlite.sql');

const toDb = (f, v) => {
  if (v === undefined || v === null) return null;
  if (f.t === 'date') return new Date(v).toISOString();
  if (f.t === 'json') return JSON.stringify(v);
  if (f.t === 'bool') return v ? 1 : 0;
  return v;
};
const fromDb = (f, v) => {
  if (v === undefined || v === null) return null;
  if (f.t === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
  if (f.t === 'int' || f.t === 'num') return Number(v);
  if (f.t === 'bool') return Boolean(Number(v));
  return v;
};

export const createSqliteStore = async (cfg) => {
  const file = path.resolve(here, '../..', cfg.sqliteFile);
  let db;
  let dirty = false;
  let timer = null;

  const save = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, Buffer.from(db.export()));
    renameSync(tmp, file);
    db.run('PRAGMA foreign_keys = ON'); // export() resets this setting
  };
  const flush = () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    try { save(); } catch (err) { console.warn('[database] Could not save the SQLite file:', err.message); }
  };

  try {
    const SQL = await initSqlJs();
    mkdirSync(path.dirname(file), { recursive: true });
    db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    const ddl = readFileSync(schemaFile, 'utf8').replace(/--.*$/gm, '');
    for (const statement of ddl.split(';').map((s) => s.trim()).filter(Boolean)) db.run(statement);
    // Databases created by an older version: add the role column.
    const cols = db.exec('PRAGMA table_info(users)')[0]?.values.map((r) => r[1]) || [];
    if (!cols.includes('role')) db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    // Columns added by later versions (partners, payments, reviews).
    for (const [table, fields] of Object.entries(COLUMN_MIGRATIONS)) {
      const have = db.exec(`PRAGMA table_info(${table})`)[0]?.values.map((r) => r[1]) || [];
      for (const f of fields) if (!have.includes(f.c)) db.run(`ALTER TABLE ${table} ADD COLUMN ${columnSql(f, 'sqlite')}`);
    }
    save();
  } catch (err) {
    throw new Error(`Could not open the SQLite file (${cfg.sqliteFile}): ${err.message}`);
  }

  process.on('exit', flush);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { flush(); process.exit(0); });

  const all = (sql, params = []) => {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  };
  const run = (sql, params = []) => {
    db.run(sql, params);
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
  };

  const makeTable = (name, spec) => {
    const byKey = new Map(spec.map((f) => [f.k, f]));
    const field = (k) => {
      const f = byKey.get(k);
      if (!f) throw new Error(`Table ${name}: unknown field "${k}"`);
      return f;
    };
    const fromRow = (row) => Object.fromEntries(spec.map((f) => [f.k, fromDb(f, row[f.c])]));
    const t = {
      find: (where, params = [], tail = '') => all(`SELECT * FROM ${name} WHERE ${where} ${tail}`, params).map(fromRow),
      one: (where, params) => t.find(where, params, 'LIMIT 1')[0],
      insert(obj) {
        const fields = Object.keys(obj).map(field);
        run(`INSERT INTO ${name} (${fields.map((f) => f.c).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`, fields.map((f) => toDb(f, obj[f.k])));
        return obj;
      },
      update(id, patch) {
        const fields = Object.keys(patch).map(field);
        if (fields.length) run(`UPDATE ${name} SET ${fields.map((f) => `${f.c} = ?`).join(', ')} WHERE id = ?`, [...fields.map((f) => toDb(f, patch[f.k])), id]);
        return t.one('id = ?', [id]) || null;
      },
      all: (tail = '') => t.find('1 = 1', [], tail),
      remove(id) { run(`DELETE FROM ${name} WHERE id = ?`, [id]); }
    };
    return t;
  };

  const users = makeTable('users', USER);
  const orders = makeTable('orders', ORDER);
  const payments = makeTable('payments', PAYMENT);
  const coupons = makeTable('coupons', COUPON);
  const reviews = makeTable('reviews', REVIEW);
  const chefs = makeTable('chefs', CHEF);
  const foods = makeTable('foods', FOOD);
  const partners = makeTable('delivery_partners', PARTNER);
  const zones = makeTable('zones', ZONE);
  const offers = makeTable('offers', OFFER);

  return {
    kind: 'sqlite',
    info: `SQLite database file (backend/${cfg.sqliteFile.replace(/\\/g, '/')})`,
    users: {
      byId: async (id) => users.one('id = ?', [id]),
      byEmail: async (email) => users.one('email = ?', [email]),
      byLogin: async (value) => users.one('email = ? OR username = ?', [value, value]),
      insert: async (u) => users.insert(u),
      update: async (id, patch) => users.update(id, patch),
      async remove(id) { run('DELETE FROM users WHERE id = ?', [id]); }, // orders/payments cascade
      all: async () => users.all('ORDER BY created_at DESC'),
      async countByRole(role) { return Number(all('SELECT COUNT(*) AS c FROM users WHERE role = ?', [role])[0].c); }
    },
    orders: {
      forUser: async (userId) => orders.find('user_id = ?', [userId], 'ORDER BY placed_at DESC'),
      byId: async (id) => orders.one('id = ?', [id]),
      insert: async (o) => orders.insert(o),
      update: async (id, patch) => orders.update(id, patch),
      async removeAllForUser(userId) { run('DELETE FROM orders WHERE user_id = ?', [userId]); },
      async remove(id) { run('DELETE FROM orders WHERE id = ?', [id]); }, // reviews cascade
      all: async () => orders.all('ORDER BY placed_at DESC')
    },
    payments: {
      byId: async (id) => payments.one('id = ?', [id]),
      insert: async (p) => payments.insert(p),
      update: async (id, patch) => payments.update(id, patch),
      all: async () => payments.all('ORDER BY created_at DESC')
    },
    resets: {
      async get(email) {
        const r = all('SELECT * FROM password_resets WHERE email = ?', [email])[0];
        return r && { hash: r.code_hash, expiresAt: Number(r.expires_at), tries: Number(r.tries), sentAt: Number(r.sent_at) };
      },
      async set(email, e) {
        run('INSERT OR REPLACE INTO password_resets (email, code_hash, expires_at, tries, sent_at) VALUES (?, ?, ?, ?, ?)', [email, e.hash, e.expiresAt, e.tries, e.sentAt]);
      },
      async delete(email) { run('DELETE FROM password_resets WHERE email = ?', [email]); }
    },
    coupons: {
      byCode: async (code) => coupons.one('code = ? AND active = 1', [code]) || null
    },
    reviews: {
      byId: async (orderId) => reviews.one('id = ?', [orderId]) || null,
      forUser: async (userId) => reviews.find('user_id = ?', [userId]),
      insert: async (r) => reviews.insert(r),
      update: async (id, patch) => reviews.update(id, patch),
      all: async () => reviews.all('ORDER BY created_at DESC')
    },
    chefs: { all: async () => chefs.all('ORDER BY id'), byId: async (id) => chefs.one('id = ?', [id]), insert: async (c) => chefs.insert(c), update: async (id, p) => chefs.update(id, p), remove: async (id) => chefs.remove(id) },
    foods: { all: async () => foods.all('ORDER BY id'), byId: async (id) => foods.one('id = ?', [id]), insert: async (f) => foods.insert(f), update: async (id, p) => foods.update(id, p), remove: async (id) => foods.remove(id) },
    partners: { all: async () => partners.all('ORDER BY name'), byId: async (id) => partners.one('id = ?', [id]), insert: async (x) => partners.insert(x), update: async (id, p) => partners.update(id, p), remove: async (id) => partners.remove(id) },
    zones: { all: async () => zones.all('ORDER BY name'), byId: async (id) => zones.one('id = ?', [id]), insert: async (x) => zones.insert(x), update: async (id, p) => zones.update(id, p), remove: async (id) => zones.remove(id) },
    recent: {
      async touch(userId, type, itemId) {
        run(
          'INSERT INTO recent_views (user_id, item_type, item_id, viewed_at, views) VALUES (?, ?, ?, ?, 1) ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET viewed_at = excluded.viewed_at, views = views + 1',
          [userId, type, itemId, new Date().toISOString()]
        );
        run(
          'DELETE FROM recent_views WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM recent_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT 60)',
          [userId, userId]
        );
      },
      async list(userId, limit = 30) {
        return all('SELECT item_type, item_id, viewed_at, views FROM recent_views WHERE user_id = ? ORDER BY viewed_at DESC LIMIT ?', [userId, Number(limit)])
          .map((r) => ({ type: r.item_type, id: r.item_id, viewedAt: r.viewed_at, views: Number(r.views) }));
      },
      async clear(userId) { run('DELETE FROM recent_views WHERE user_id = ?', [userId]); }
    },
    offers: {
      all: async () => offers.all('ORDER BY created_at DESC'),
      byId: async (id) => offers.one('id = ?', [id]),
      insert: async (o) => offers.insert(o),
      update: async (id, p) => offers.update(id, p),
      remove: async (id) => offers.remove(id),
      active: async () => offers.find('active = 1', [], 'ORDER BY created_at DESC')
    },
    settings: {
      async get(key) {
        const rows = all('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
        const r = rows[0];
        if (!r) return null;
        return typeof r.setting_value === 'string' ? JSON.parse(r.setting_value) : r.setting_value;
      },
      async set(key, val) {
        run('INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)',
          [key, JSON.stringify(val), new Date().toISOString()]
        );
      }
    }
  };
};
