// The menu (dishes + chefs) lives in the database. This module keeps a small in-memory copy so
// every order/search does not hit the database, and refreshes it whenever the admin changes the menu.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { foods as foodStore, chefs as chefStore } from './store.js';

export const CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snacks', 'sweets', 'drinks', 'brunch'];
export const DIETS = ['veg', 'vegan', 'non-veg'];
export const SPICES = ['None', 'Mild', 'Medium', 'Hot'];

let cache = null;
export const refreshCatalog = async () => {
  cache = { foods: await foodStore.all(), chefs: await chefStore.all() };
  return cache;
};
const ready = async () => cache || refreshCatalog();

export const allFoods = async ({ includeHidden = false } = {}) => (await ready()).foods.filter((f) => includeHidden || f.available);
export const allChefs = async () => (await ready()).chefs;
export const getFood = async (id, { includeHidden = false } = {}) => (await allFoods({ includeHidden })).find((f) => f.id === id);
export const getChef = async (id) => (await allChefs()).find((c) => c.id === id);

// First start: copy the starting menu from data/catalog.json into empty tables.
// After that the database is the source of truth (edit it from the admin dashboard).
export const seedCatalog = async () => {
  let seed = { chefs: [], foods: [] };
  const candidates = [
    new URL('./data/catalog.json', import.meta.url),
    path.resolve(process.cwd(), 'src/data/catalog.json'),
    path.resolve(process.cwd(), 'backend/src/data/catalog.json'),
    path.resolve(process.cwd(), 'data/catalog.json')
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        seed = JSON.parse(readFileSync(c, 'utf8'));
        break;
      }
    } catch {
      // try next candidate
    }
  }
  let added = 0;
  if ((await chefStore.all()).length === 0) {
    for (const c of seed.chefs) { await chefStore.insert(c); added += 1; }
  }
  if ((await foodStore.all()).length === 0) {
    for (const f of seed.foods) { await foodStore.insert({ photo: null, photoCredit: null, available: true, ...f }); added += 1; }
  }
  await refreshCatalog();
  return added;
};
