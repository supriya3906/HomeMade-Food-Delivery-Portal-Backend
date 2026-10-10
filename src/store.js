// One data layer, two back ends (same async API):
//   • SQLite     DB_TYPE=sqlite  (one file, nothing to install)  (stores/sqlite.js)
//   • MySQL      DB_TYPE=mysql                                    (stores/mysql.js)
//   • JSON file  DB_TYPE=file, or if the chosen database cannot be opened (stores/file.js)
// Routes only ever import { users, orders, payments, resets, coupons, reviews, chefs, foods, partners, zones, recent } from here.
import { config } from './config.js';
import { createFileStore } from './stores/file.js';

let impl = null;
let dbError = null;

const type = config.db.type;
try {
  if (type === 'mysql') impl = await (await import('./stores/mysql.js')).createMysqlStore(config.db);
  else if (type === 'sqlite') impl = await (await import('./stores/sqlite.js')).createSqliteStore(config.db);
} catch (err) {
  dbError = err.message;
  console.warn(`\n[database] ${type} is NOT connected: ${dbError}`);
  console.warn('[database] Using the JSON file instead. Data is not saved in the database until this is fixed.\n');
}
impl = impl || createFileStore();

export const { users, orders, payments, resets, coupons, reviews, chefs, foods, partners, zones, recent, offers, settings } = impl;
export const storeInfo = impl.info;
export const storeStatus = { kind: impl.kind, info: impl.info, error: dbError };
