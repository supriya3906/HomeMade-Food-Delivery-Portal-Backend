import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
dotenv.config({ path: envPath, quiet: true });

const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.AUTH_SECRET) {
  console.warn('[warning] Set AUTH_SECRET in backend environment variables for production security.');
}

export const config = {
  port: Number(process.env.PORT) || 5000,
  authSecret: process.env.AUTH_SECRET || 'dev-only-secret-change-me',
  corsOrigin: process.env.CORS_ORIGIN || true, // true = reflect request origin (dev)
  // Password-reset codes are shown on screen (and logged) because no email service
  // is connected. Turn off in production: set NODE_ENV=production.
  exposeResetCode: process.env.NODE_ENV !== 'production',
  // "Continue with Google" (real OAuth 2.0): set GOOGLE_CLIENT_ID (Google Cloud Console ->
  // Credentials -> OAuth client ID, type Web). Without it the Google button explains what is missing.
  googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  // Google endpoints used to verify a sign-in. Only override these in automated tests.
  googleTokenInfoUrl: process.env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo',
  googleUserInfoUrl: process.env.GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
  // The one administrator account, created on first start (see README). Admin pages and
  // /api/admin/* only work for users whose role is "admin".
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminName: (process.env.ADMIN_NAME || 'Rasoi Admin').trim(),
  tokenTtlMs: 7 * 24 * 60 * 60 * 1000,
  // DB_TYPE = sqlite | mysql | file. Old setups that only set DB_HOST keep using MySQL.
  db: {
    type: process.env.DB_TYPE || (process.env.DB_HOST ? 'mysql' : 'file'),
    sqliteFile: process.env.SQLITE_FILE || 'data/rasoi.sqlite',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ?? '',
    name: process.env.DB_NAME || 'rasoi',
    ssl: process.env.DB_SSL === 'true' || process.env.DB_SSL === '1'
  }
};
