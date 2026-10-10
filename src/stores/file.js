// No-database fallback: everything lives in memory and is saved to data/store.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const file = path.join(dir, 'store.json');

export const createFileStore = () => {
  let state = { users: [], orders: [], payments: [], reviews: [], chefs: [], foods: [], partners: [], zones: [], recent: [], offers: [], settings: {} };
  try {
    if (existsSync(file)) state = { users: [], orders: [], payments: [], reviews: [], chefs: [], foods: [], partners: [], zones: [], recent: [], offers: [], settings: {}, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    console.warn('Could not read data/store.json — starting empty.');
  }

  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify(state, null, 2));
      } catch (err) {
        console.warn('Could not save data/store.json:', err.message);
      }
    }, 150);
  };

  const patchIn = (list, id, patch) => {
    const item = list.find((x) => x.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    persist();
    return item;
  };

  // Optional: data/coupons.json = [{ "code": "SAVE50", "min": 199, "type": "flat", "value": 50 }]
  let couponList = [];
  try {
    const f = path.join(dir, 'coupons.json');
    if (existsSync(f)) couponList = JSON.parse(readFileSync(f, 'utf8'));
  } catch { /* no coupons */ }

  const resetMap = new Map();

  const listApi = (key) => ({
    all: async () => [...state[key]].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    byId: async (id) => state[key].find((x) => x.id === id),
    async insert(item) { state[key].push(item); persist(); return item; },
    update: async (id, patch) => patchIn(state[key], id, patch),
    async remove(id) { state[key] = state[key].filter((x) => x.id !== id); persist(); }
  });

  return {
    kind: 'file',
    info: 'JSON file (backend/data/store.json) — no database',
    users: {
      byId: async (id) => state.users.find((u) => u.id === id),
      byEmail: async (email) => state.users.find((u) => u.email === email),
      byLogin: async (value) => state.users.find((u) => u.email === value || u.username === value),
      async insert(user) { state.users.push({ role: 'user', ...user }); persist(); return state.users.at(-1); },
      all: async () => [...state.users].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      countByRole: async (role) => state.users.filter((u) => (u.role || 'user') === role).length,
      update: async (id, patch) => patchIn(state.users, id, patch),
      async remove(id) {
        state.users = state.users.filter((u) => u.id !== id);
        state.orders = state.orders.filter((o) => o.userId !== id);
        state.payments = state.payments.filter((p) => p.userId !== id);
        state.reviews = state.reviews.filter((r) => r.userId !== id);
        state.recent = state.recent.filter((r) => r.userId !== id);
        persist();
      }
    },
    orders: {
      all: async () => [...state.orders].sort((a, b) => b.placedAt.localeCompare(a.placedAt)),
      forUser: async (userId) => state.orders.filter((o) => o.userId === userId).sort((a, b) => b.placedAt.localeCompare(a.placedAt)),
      byId: async (id) => state.orders.find((o) => o.id === id),
      async insert(order) { state.orders.push(order); persist(); return order; },
      update: async (id, patch) => patchIn(state.orders, id, patch),
      async removeAllForUser(userId) {
        state.orders = state.orders.filter((o) => o.userId !== userId);
        state.reviews = state.reviews.filter((r) => r.userId !== userId);
        persist();
      },
      async remove(id) {
        state.orders = state.orders.filter((o) => o.id !== id);
        state.reviews = state.reviews.filter((r) => r.id !== id);
        persist();
      }
    },
    payments: {
      byId: async (id) => state.payments.find((p) => p.id === id),
      async insert(payment) { state.payments.push(payment); persist(); return payment; },
      update: async (id, patch) => patchIn(state.payments, id, patch),
      all: async () => [...state.payments].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    },
    resets: {
      get: async (email) => resetMap.get(email),
      async set(email, entry) { resetMap.set(email, entry); },
      async delete(email) { resetMap.delete(email); }
    },
    coupons: {
      byCode: async (code) => couponList.find((c) => c.code === code && c.active !== false) || null
    },
    reviews: {
      byId: async (orderId) => state.reviews.find((r) => r.id === orderId) || null,
      forUser: async (userId) => state.reviews.filter((r) => r.userId === userId),
      async insert(review) { state.reviews.push(review); persist(); return review; },
      update: async (id, patch) => patchIn(state.reviews, id, patch),
      all: async () => [...state.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    },
    chefs: listApi('chefs'),
    foods: listApi('foods'),
    partners: listApi('partners'),
    zones: listApi('zones'),
    recent: {
      async touch(userId, type, itemId) {
        const now = new Date().toISOString();
        const row = state.recent.find((r) => r.userId === userId && r.type === type && r.id === itemId);
        if (row) { row.viewedAt = now; row.views += 1; } else state.recent.push({ userId, type, id: itemId, viewedAt: now, views: 1 });
        const mine = state.recent.filter((r) => r.userId === userId).sort((a, b) => b.viewedAt.localeCompare(a.viewedAt));
        const drop = new Set(mine.slice(60));
        state.recent = state.recent.filter((r) => !drop.has(r));
        persist();
      },
      async list(userId, limit = 30) {
        return state.recent.filter((r) => r.userId === userId).sort((a, b) => b.viewedAt.localeCompare(a.viewedAt)).slice(0, limit)
          .map(({ type, id, viewedAt, views }) => ({ type, id, viewedAt, views }));
      },
      async clear(userId) { state.recent = state.recent.filter((r) => r.userId !== userId); persist(); }
    },
    offers: {
      ...listApi('offers'),
      active: async () => (state.offers || []).filter((o) => o.active !== false).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    },
    settings: {
      async get(key) { return state.settings?.[key] || null; },
      async set(key, val) {
        state.settings = state.settings || {};
        state.settings[key] = val;
        persist();
      }
    }
  };
};
