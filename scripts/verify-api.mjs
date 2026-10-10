// End-to-end API check:  npm run verify   (from the backend folder; MySQL must be running)
// Starts a throw-away copy of the API on port 5100 against its OWN database ("<DB_NAME>_verify"),
// so your real data is never touched. It registers 5 users, and checks JWT, profile, cart pricing,
// checkout (COD + UPI), orders, recently accessed, the assistant, search, admin protection and
// the Google OAuth server check (against a local stand-in for Google, since the real one needs a browser).
import { spawn } from 'node:child_process';
import http from 'node:http';
import 'dotenv/config';

const PORT = 5100;
const BASE = `http://127.0.0.1:${PORT}/api`;
const GOOGLE_PORT = 5198;
const DB = `${process.env.DB_NAME || 'rasoi'}_verify`;
let pass = 0, failed = 0;
const ok = (cond, label, extra = '') => { cond ? pass++ : failed++; console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${!cond && extra ? '  -> ' + extra : ''}`); };
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

// stand-in for Google's token verification endpoints
const google = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/tokeninfo') {
    const t = url.searchParams.get('access_token');
    if (t === 'good-token') return res.end(JSON.stringify({ aud: 'verify-client.apps.googleusercontent.com' }));
    if (t === 'foreign-token') return res.end(JSON.stringify({ aud: 'someone-elses-app' }));
    res.statusCode = 400; return res.end('{"error":"invalid_token"}');
  }
  if (url.pathname === '/userinfo') return res.end(JSON.stringify({ email: 'google.person@example.com', email_verified: true, name: 'Google Person' }));
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => google.listen(GOOGLE_PORT, r));

// fresh verification database
const mysql = await import('mysql2/promise');
if ((process.env.DB_TYPE || 'mysql') === 'mysql') {
  const c = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  await c.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await c.end();
}
const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT, DB_NAME: DB, GOOGLE_CLIENT_ID: 'verify-client.apps.googleusercontent.com',
    GOOGLE_TOKENINFO_URL: `http://127.0.0.1:${GOOGLE_PORT}/tokeninfo`, GOOGLE_USERINFO_URL: `http://127.0.0.1:${GOOGLE_PORT}/userinfo`,
    ADMIN_EMAIL: 'verify.admin@rasoi.test', ADMIN_PASSWORD: 'Admin#Verify1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }

try {
  console.log(`\nDatabase: ${(await call('GET', '/health')).data.database}  (${DB})`);

  console.log('\n[Menu from the database]');
  const foods = (await call('GET', '/foods')).data;
  ok(foods.length >= 70, `menu has ${foods.length} dishes`);
  for (const cat of ['breakfast', 'lunch', 'dinner', 'snacks', 'sweets', 'drinks', 'brunch']) {
    const n = (await call('GET', `/foods?category=${cat}`)).data.length;
    ok(n >= 10 && n <= 15, `${cat}: ${n} dishes`);
  }
  ok(foods.every((f) => f.nameTa && f.descriptionTa && f.price > 0 && f.rating > 0), 'every dish has Tamil text, price and rating');
  ok((await call('GET', '/foods?q=தோசை')).data.some((f) => /dosa/i.test(f.name)), 'Tamil search finds dosa');
  ok((await call('GET', '/foods?category=sweets&maxPrice=150')).data.every((f) => f.price <= 150), 'price filter works');

  console.log('\n[5 user accounts: register, JWT, profile]');
  const people = [['Anitha Selvam', 'anitha'], ['Karthik Raman', 'karthik'], ['Divya Prakash', 'divya'], ['Mohammed Rafi', 'rafi'], ['Priya Nataraj', 'priya']];
  const users = [];
  for (const [name, handle] of people) {
    const email = `${handle}.verify@example.com`;
    const reg = await call('POST', '/auth/register', { body: { name, email, phone: '9876543210', password: 'Rasoi@2026' } });
    const login = await call('POST', '/auth/login', { body: { identifier: email, password: 'Rasoi@2026' } });
    const token = login.data?.token;
    ok(reg.status === 201 || reg.status === 200, `${name}: registered`, JSON.stringify(reg.data));
    ok(token?.split('.').length === 3, `${name}: login returns a 3-part JWT`);
    const me = await call('GET', '/auth/me', { token });
    ok(me.data?.user?.email === email && me.data.user.role === 'user' && !me.data.user.hash, `${name}: /auth/me returns own profile, no password hash`);
    const upd = await call('PATCH', '/auth/profile', { token, body: { name, phone: '9876543210', address: '12 Gandhi Road', city: 'Tiruppur', pincode: '641601' } });
    ok(upd.status === 200, `${name}: profile update saved`);
    users.push({ name, email, token });
  }
  const bad = await call('POST', '/auth/login', { body: { identifier: users[0].email, password: 'wrong-password' } });
  ok(bad.status === 401, 'wrong password rejected');
  ok((await call('GET', '/auth/me')).status === 401, 'no token -> 401');
  ok((await call('GET', '/auth/me', { token: users[0].token + 'x' })).status === 401, 'tampered JWT -> 401');
  ok((await call('GET', '/orders', {})).status === 401, 'orders is a protected route');

  console.log('\n[Cart -> Checkout -> Payment -> Order, per user]');
  const pick = (cat, i) => (foods.filter((f) => f.category === cat)[i]);
  const addr = { name: 'Delivery Name', phone: '9876543210', address: '12 Gandhi Road', city: 'Tiruppur', pincode: '641601' };
  for (const [i, u] of users.entries()) {
    const items = [{ id: pick('breakfast', i).id, quantity: 2 }, { id: pick('sweets', i).id, quantity: 1 }];
    const want = items.reduce((s, it) => s + foods.find((f) => f.id === it.id).price * it.quantity, 0);
    const cod = (await call('POST', '/pricing/quote', { body: { items, paymentMethod: 'cod' } })).data;
    const upi = (await call('POST', '/pricing/quote', { body: { items, paymentMethod: 'upi' } })).data;
    ok(cod.subtotal === want && cod.deliveryFee > 0 && cod.total > want, `${u.name}: server prices cart (subtotal ₹${want}, COD total ₹${cod.total})`);
    ok(upi.deliveryFee === 0 && upi.tax > 0, `${u.name}: UPI has no delivery fee, tax applied`);
    if (i % 2 === 0) {
      const o = await call('POST', '/orders', { token: u.token, body: { items, paymentMethod: 'cod', address: addr } });
      ok(o.status === 201 && o.data.total === cod.total, `${u.name}: COD order placed`, JSON.stringify(o.data));
      u.orderId = o.data?.id;
    } else {
      const p = await call('POST', '/payments', { token: u.token, body: { items, paymentMethod: 'upi', address: addr, upi: { vpa: `${u.name.split(' ')[0].toLowerCase()}@okaxis`, app: 'gpay' } } });
      let c = await call('POST', `/payments/${p.data?.id}/confirm`, { token: u.token, body: { result: 'approve' } });
      // The gateway now processes + verifies asynchronously (like a real one): wait for it, as the UI does.
      for (let i = 0; i < 40 && c.data?.status === 'processing'; i++) { await new Promise((r) => setTimeout(r, 400)); c = await call('GET', `/payments/${p.data.id}`, { token: u.token }); }
      ok(c.data?.status === 'success' && c.data.order?.id, `${u.name}: UPI payment approved -> order created`, JSON.stringify(c.data));
      u.orderId = c.data?.order?.id;
    }
    const list = (await call('GET', '/orders', { token: u.token })).data;
    ok(list.length === 1 && list[0].id === u.orderId, `${u.name}: sees exactly their own order`);
  }
  ok((await call('GET', `/orders/${users[0].orderId}`, { token: users[1].token })).status === 404, "a user cannot open another user's order");
  ok((await call('POST', '/orders', { token: users[0].token, body: { items: [{ id: 'nope', quantity: 1 }], paymentMethod: 'cod', address: addr } })).status === 400, 'unknown dish rejected');

  console.log('\n[Recently accessed]');
  const u = users[0];
  const a = foods.find((f) => f.category === 'drinks').id;
  const b = foods.find((f) => f.category === 'dinner').id;
  ok((await call('POST', '/recent', { token: u.token, body: { type: 'food', id: a } })).status === 201, 'view recorded');
  await new Promise((r) => setTimeout(r, 20));
  await call('POST', '/recent', { token: u.token, body: { type: 'food', id: b } });
  await call('POST', '/recent', { token: u.token, body: { type: 'food', id: a } });
  const rec = (await call('GET', '/recent', { token: u.token })).data;
  ok(rec[0]?.food?.id === a && rec[1]?.food?.id === b && rec.length === 2, 'most recent first, de-duplicated');
  ok((await call('GET', '/recent', { token: users[1].token })).data.length === 0, "other users do not see it");
  ok((await call('POST', '/recent', { token: u.token, body: { type: 'food', id: 'bogus' } })).status === 400, 'invalid item rejected');
  ok((await call('GET', '/recent')).status === 401, 'recently accessed needs login');

  console.log('\n[Assistant: real data, English + Tamil]');
  const chat = async (text, cart = []) => (await call('POST', '/assistant/chat', { token: u.token, body: { text, cart, hour: 8 } })).data;
  let r = await chat('What is good for breakfast?');
  ok(r.dishes?.length > 0 && r.dishes.every((d) => foods.find((f) => f.id === d.id)?.meals.includes('breakfast')), 'breakfast question returns breakfast dishes from DB');
  ok(r.texts?.en && r.texts?.ta && /[\u0B80-\u0BFF]/.test(r.texts.ta), 'reply carries English and Tamil text');
  r = await chat('Show veg dishes');
  ok(r.dishes?.length > 0 && r.dishes.every((d) => d.diet !== 'non-veg'), 'veg dishes are all vegetarian');
  r = await chat('Sweets under ₹150');
  ok(r.dishes?.length > 0 && r.dishes.every((d) => d.price <= 150 && d.meals.includes('sweets')), 'sweets under 150 respect price');
  r = await chat('What is in my cart?', [{ id: pick('lunch', 0).id, quantity: 2 }]);
  ok(r.texts.en.includes(pick('lunch', 0).name) && r.texts.en.includes(String(pick('lunch', 0).price * 2)), 'cart question reads the cart with DB prices');
  r = await chat('How do payments work?');
  ok(/UPI/.test(r.texts.en) && /GST/.test(r.texts.en), 'payments question explained');
  r = await chat('காலை உணவு என்ன நல்லது?');
  ok(r.dishes?.length > 0 && r.dishes.every((d) => d.meals.includes('breakfast')), 'Tamil question understood');
  r = await chat('masala dosa price');
  ok(r.dishes?.[0]?.name === 'Masala Dosa' && r.texts.en.includes(`₹${r.dishes[0].price}`), 'dish lookup by name');
  const rec2 = (await call('GET', '/assistant/recommendations', { token: u.token })).data;
  ok(rec2.items?.length > 0, `personalised recommendations (personalised=${rec2.personalised})`);
  ok((await call('POST', '/assistant/chat', { body: { text: 'hi' } })).status === 401, 'assistant needs login');

  console.log('\n[Admin: authentication + authorization]');
  const adminLogin = await call('POST', '/auth/admin-login', { body: { identifier: 'verify.admin@rasoi.test', password: 'Admin#Verify1' } });
  const at = adminLogin.data?.token;
  ok(adminLogin.status === 200 && adminLogin.data.user.role === 'admin', 'admin login works');
  ok((await call('POST', '/auth/admin-login', { body: { identifier: users[0].email, password: 'Rasoi@2026' } })).status === 401, 'customer cannot use admin login');
  for (const p of ['/admin/stats', '/admin/users', '/admin/orders', '/admin/foods']) {
    ok((await call('GET', p)).status === 401, `GET ${p} without token -> 401`);
    ok((await call('GET', p, { token: users[0].token })).status === 403, `GET ${p} as customer -> 403`);
  }
  ok((await call('DELETE', `/admin/users/${users[1].orderId}`, { token: users[0].token })).status === 403, 'customer cannot delete users');
  const stats = (await call('GET', '/admin/stats', { token: at })).data;
  ok(stats.users === 5 && stats.orders === 5 && stats.foods === foods.length, `dashboard stats: ${stats.users} users, ${stats.orders} orders, ₹${stats.revenue} revenue`);
  const allUsers = (await call('GET', '/admin/users', { token: at })).data;
  ok(allUsers.length === 6 && allUsers.every((x) => !x.hash && !x.salt), 'admin lists users without password data');
  ok((await call('GET', '/admin/orders', { token: at })).data.length === 5, 'admin sees all orders');
  const newFood = await call('POST', '/admin/foods', { token: at, body: { name: 'Verify Test Dish', category: 'snacks', chefId: 'c1', price: 99, diet: 'veg', spice: 'Mild', description: 'Temporary dish for the verification run.' } });
  ok(newFood.status === 201, 'admin creates a dish');
  ok((await call('GET', '/foods')).data.some((f) => f.id === newFood.data?.id), 'new dish appears on the public menu');
  ok((await call('PATCH', `/admin/foods/${newFood.data.id}`, { token: at, body: { price: 109 } })).data.price === 109, 'admin edits price');
  await call('PATCH', `/admin/foods/${newFood.data.id}`, { token: at, body: { available: false } });
  ok(!(await call('GET', '/foods')).data.some((f) => f.id === newFood.data.id), 'hidden dish leaves the menu');
  ok((await call('DELETE', `/admin/foods/${newFood.data.id}`, { token: at })).status === 200, 'admin deletes the dish');
  const stage = await call('PATCH', `/admin/orders/${users[0].orderId}`, { token: at, body: { stage: 1 } });
  ok(stage.status === 200 && stage.data.stage === 1, 'admin moves an order forward');
  ok((await call('GET', `/orders/${users[0].orderId}`, { token: users[0].token })).data.stage >= 1, 'customer sees the new status');
  ok((await call('PATCH', `/admin/users/${at ? adminLogin.data.user.id : ''}`, { token: at, body: { role: 'user' } })).status === 400, 'cannot demote the last admin');
  ok((await call('DELETE', `/admin/users/${adminLogin.data.user.id}`, { token: at })).status === 400, 'admin cannot delete themselves');
  ok((await call('DELETE', `/admin/users/${users[4].orderId ? (await call('GET', '/auth/me', { token: users[4].token })).data.user.id : ''}`, { token: at })).status === 200, 'admin deletes a user (cascade removes their orders)');
  ok((await call('GET', '/admin/orders', { token: at })).data.length === 4, 'deleted user orders are gone');

  console.log('\n[Google OAuth server-side check]');
  ok((await call('GET', '/auth/google-config')).data.clientId === 'verify-client.apps.googleusercontent.com', 'client id exposed to the sign-in page');
  const g = await call('POST', '/auth/google', { body: { accessToken: 'good-token' } });
  ok(g.status === 200 && g.data.token && g.data.user.email === 'google.person@example.com', 'valid Google token -> account created + JWT');
  ok((await call('POST', '/auth/google', { body: { accessToken: 'foreign-token' } })).status === 401, 'token issued to another app rejected');
  ok((await call('POST', '/auth/google', { body: { accessToken: 'garbage' } })).status === 401, 'invalid token rejected');
  ok((await call('GET', '/auth/me', { token: g.data.token })).status === 200, 'Google user can call protected API');
} catch (e) {
  failed++; console.log('  ERROR', e);
} finally {
  server.kill(); google.close();
  if ((process.env.DB_TYPE || 'mysql') === 'mysql') {
    const c = await mysql.createConnection({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
    await c.query(`DROP DATABASE IF EXISTS \`${DB}\``); await c.end();
  }
  console.log(`\n${pass} passed, ${failed} failed`);
  if (failed) console.log('\nServer log:\n' + log);
  process.exit(failed ? 1 : 0);
}
