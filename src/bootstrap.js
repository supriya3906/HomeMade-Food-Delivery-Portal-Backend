import { users, zones } from './store.js';
import { DEFAULT_ZONES } from './geo.js';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { seedCatalog } from './catalog.js';

// Runs once at start-up: loads the menu into an empty database and creates the admin account.
export const bootstrap = async () => {
  const added = await seedCatalog();
  if (added) console.log(`[catalog] Loaded ${added} chefs/dishes into the database.`);

  if ((await zones.all()).length === 0) {
    for (const z of DEFAULT_ZONES) await zones.insert({ active: true, ...z });
    console.log(`[zones] Added ${DEFAULT_ZONES.length} starting delivery zones (edit them in Admin -> Delivery).`);
  }

  if (!config.adminEmail || !config.adminPassword) {
    if ((await users.countByRole('admin')) === 0) {
      console.warn('[admin] No administrator exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in backend/.env and restart.');
    }
    return;
  }
  if (config.adminPassword.length < 8) {
    console.warn('[admin] ADMIN_PASSWORD must be at least 8 characters. Admin account was not created.');
    return;
  }
  const existing = await users.byEmail(config.adminEmail);
  if (existing) {
    if (existing.role !== 'admin') {
      console.warn(`[admin] ${config.adminEmail} already belongs to a customer account, so it was NOT promoted. Use a different ADMIN_EMAIL.`);
    }
    return;
  }
  await users.insert({
    id: `u-admin-${Date.now()}`,
    name: config.adminName,
    email: config.adminEmail,
    username: config.adminEmail.split('@')[0],
    phone: '', address: '', city: '', pincode: '',
    role: 'admin',
    createdAt: new Date().toISOString(),
    ...hashPassword(config.adminPassword)
  });
  console.log(`[admin] Administrator account created for ${config.adminEmail}.`);
};
