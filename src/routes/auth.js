import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { users, resets } from '../store.js';
import { hashPassword, verifyPassword, createToken, publicUser, requireAuth } from '../auth.js';
import { getUserTier } from '../tierService.js';

const router = Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (v) => String(v ?? '').trim();

const userWithTier = async (u) => {
  if (!u) return null;
  const p = publicUser(u);
  p.tier = await getUserTier(u.id);
  return p;
};

router.post('/register', async (req, res) => {
  const name = clean(req.body.name);
  const email = clean(req.body.email).toLowerCase();
  const phone = clean(req.body.phone);
  const password = String(req.body.password ?? '');

  if (!name || !email || !password) throw fail(400, 'Please fill in your name, email and password.');
  if (password.length < 6) throw fail(400, 'Password must be at least 6 characters.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Please enter a valid email address.');
  if (await users.byEmail(email)) throw fail(409, 'An account with this email already exists. Please sign in instead.');

  const user = await users.insert({
    id: `u-${Date.now()}`,
    name, email, phone,
    username: email.split('@')[0],
    address: '', city: '', pincode: '',
    role: 'user',
    createdAt: new Date().toISOString(),
    ...hashPassword(password)
  });
  res.status(201).json({ token: createToken(user), user: await userWithTier(user) });
});

// ---- Continue with Google (OAuth 2.0) ---------------------------------------
// The browser opens Google's own account chooser (prompt=select_account) and gets back an
// access token for scopes openid/email/profile. We never trust the browser: the server asks
// Google who the token belongs to, checks it was issued to OUR client id (aud) and that the
// email is verified, then signs the person in with our own JWT.
// (An ID token in `credential` is also accepted and verified the same way.)
const googleLookup = async (url) => {
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok) throw new Error('rejected');
    return data;
  } catch {
    throw fail(401, 'Google could not verify this sign-in. Please try again.');
  }
};

const googleUser = async ({ name, email }) => {
  const existing = await users.byEmail(email);
  if (existing) return existing;
  return users.insert({
    id: `u-${Date.now()}`,
    name, email, phone: '',
    username: email.split('@')[0],
    address: '', city: '', pincode: '',
    preferences: { provider: 'google' },
    role: 'user',
    createdAt: new Date().toISOString(),
    ...hashPassword(crypto.randomBytes(24).toString('hex')) // no password login until they reset one
  });
};

router.get('/google-config', (req, res) => res.json({ clientId: config.googleClientId || null }));

router.post('/google', async (req, res) => {
  if (!config.googleClientId) throw fail(400, 'Google sign-in is not set up on this server (missing GOOGLE_CLIENT_ID).');
  const accessToken = clean(req.body.accessToken);
  const credential = clean(req.body.credential);
  if (!accessToken && !credential) throw fail(400, 'Google sign-in failed. Please try again.');

  const info = await googleLookup(`${config.googleTokenInfoUrl}?${accessToken ? 'access_token' : 'id_token'}=${encodeURIComponent(accessToken || credential)}`);
  if (info.aud !== config.googleClientId && info.azp !== config.googleClientId) throw fail(401, 'This Google sign-in was not issued for Rasoi.');
  let email = info.email;
  let name = info.name;
  let verified = String(info.email_verified) === 'true';
  if (accessToken) {
    // tokeninfo for access tokens does not carry the profile: ask the OpenID userinfo endpoint.
    let profile;
    try {
      const r = await fetch(config.googleUserInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error('rejected');
      profile = await r.json();
    } catch {
      throw fail(401, 'Google could not verify this sign-in. Please try again.');
    }
    email = profile.email;
    name = profile.name;
    verified = String(profile.email_verified) === 'true';
  } else if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) {
    throw fail(401, 'This Google account could not be verified.');
  }
  if (!verified || !email) throw fail(401, 'This Google account could not be verified.');

  const user = await googleUser({ name: name || String(email).split('@')[0], email: String(email).toLowerCase() });
  res.json({ token: createToken(user), user: await userWithTier(user) });
});

router.post('/login', async (req, res) => {
  const identifier = clean(req.body.identifier).toLowerCase();
  const password = String(req.body.password ?? '');
  if (!identifier || !password) throw fail(400, 'Please enter your email and password.');
  const user = await users.byLogin(identifier);
  if (!user || !verifyPassword(password, user)) throw fail(401, 'Incorrect email or password.');
  res.json({ token: createToken(user), user: await userWithTier(user) });
});

// Administrator sign-in. Same credentials check, but it refuses anybody who is not an admin,
// so the admin page can never be reached by a customer account.
router.post('/admin-login', async (req, res) => {
  const identifier = clean(req.body.identifier).toLowerCase();
  const password = String(req.body.password ?? '');
  if (!identifier || !password) throw fail(400, 'Please enter the admin email and password.');
  const user = await users.byLogin(identifier);
  if (!user || user.role !== 'admin' || !verifyPassword(password, user)) throw fail(401, 'Incorrect admin email or password.');
  res.json({ token: createToken(user), user: await userWithTier(user) });
});

// ---- Forgot password -------------------------------------------------------
// 1) /forgot-password sends a 6-digit code (valid 10 min, one request / 30 s)
// 2) /reset-password checks it (5 tries) and sets the new password.
// There is no email service connected, so in development the code is returned
// in the response (and logged) instead of being emailed. Codes live in memory.
const RESET_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 30 * 1000;
const MAX_RESET_TRIES = 5;
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

router.post('/forgot-password', async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Please enter a valid email address.');

  const previous = await resets.get(email);
  if (previous && Date.now() - previous.sentAt < RESEND_MS) {
    const wait = Math.ceil((RESEND_MS - (Date.now() - previous.sentAt)) / 1000);
    throw fail(429, `Please wait ${wait}s before asking for another code.`);
  }

  const user = await users.byEmail(email);
  const reply = { ok: true, message: 'If an account exists for this email, a 6-digit code has been sent.', resendIn: RESEND_MS / 1000, demo: config.exposeResetCode };
  if (!user) return res.json(reply);

  const code = String(crypto.randomInt(100000, 1000000));
  await resets.set(email, { hash: hashCode(code), expiresAt: Date.now() + RESET_TTL_MS, tries: 0, sentAt: Date.now() });
  if (config.exposeResetCode) {
    console.log(`[password reset] code for ${email}: ${code}`);
    reply.devCode = code;
  }
  res.json(reply);
});

router.post('/reset-password', async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const code = clean(req.body.code);
  const newPassword = String(req.body.newPassword ?? '');
  if (newPassword.length < 6) throw fail(400, 'New password must be at least 6 characters.');

  const entry = await resets.get(email);
  const user = await users.byEmail(email);
  if (!entry || !user || Date.now() > entry.expiresAt) {
    await resets.delete(email);
    throw fail(400, 'This code has expired. Please request a new one.');
  }
  entry.tries += 1;
  if (entry.tries > MAX_RESET_TRIES) {
    await resets.delete(email);
    throw fail(400, 'Too many attempts. Please request a new code.');
  }
  const a = Buffer.from(hashCode(code), 'hex');
  const b = Buffer.from(entry.hash, 'hex');
  if (!crypto.timingSafeEqual(a, b)) {
    await resets.set(email, entry); // remember the failed try
    throw fail(400, `That code is not correct. ${MAX_RESET_TRIES - entry.tries} tries left.`);
  }

  await users.update(user.id, hashPassword(newPassword));
  await resets.delete(email);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => res.json({ user: await userWithTier(req.user) }));

router.patch('/profile', requireAuth, async (req, res) => {
  const allowed = ['name', 'phone', 'address', 'city', 'pincode'];
  const patch = {};
  for (const key of allowed) if (key in req.body) patch[key] = clean(req.body[key]);
  if ('name' in patch && !patch.name) throw fail(400, 'Name cannot be empty.');
  const updated = await users.update(req.user.id, patch);
  res.json({ user: await userWithTier(updated) });
});

// Language, font size, theme ... saved on the account so they follow the user to any device.
const PREF_CHOICES = {
  theme: ['light', 'dark'],
  language: ['en', 'ta'],
  fontSize: ['sm', 'md', 'lg', 'xl'],
  fontStyle: ['default', 'rounded', 'classic', 'clean']
};
router.patch('/preferences', requireAuth, async (req, res) => {
  const body = req.body || {};
  const prefs = { ...(req.user.preferences || {}) };
  for (const [key, allowed] of Object.entries(PREF_CHOICES)) {
    if (body[key] === undefined) continue;
    if (!allowed.includes(body[key])) throw fail(400, `Invalid ${key}.`);
    prefs[key] = body[key];
  }
  for (const key of ['notifications']) {
    if (body[key] !== undefined) prefs[key] = !!body[key];
  }
  const updated = await users.update(req.user.id, { preferences: prefs });
  res.json({ user: await userWithTier(updated) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!verifyPassword(String(currentPassword ?? ''), req.user)) throw fail(400, 'Current password is incorrect.');
  if (!newPassword || String(newPassword).length < 6) throw fail(400, 'New password must be at least 6 characters.');
  await users.update(req.user.id, hashPassword(String(newPassword)));
  res.json({ ok: true });
});

router.delete('/account', requireAuth, async (req, res) => {
  await users.remove(req.user.id);
  res.json({ ok: true });
});

export default router;
