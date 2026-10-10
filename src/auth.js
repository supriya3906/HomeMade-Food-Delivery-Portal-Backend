import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { users } from './store.js';

export const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt,
  hash: crypto.scryptSync(password, salt, 64).toString('hex')
});

export const verifyPassword = (password, user) => {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
};

// ---- JSON Web Tokens (HS256) ------------------------------------------------
// Every signed-in request sends "Authorization: Bearer <jwt>". The token carries the user id
// (sub) and role, but the role is always re-read from the database, so demoting or deleting
// a user takes effect immediately even if they still hold an unexpired token.
const ISSUER = 'rasoi-api';
export const createToken = (user) =>
  jwt.sign({ role: user.role || 'user' }, config.authSecret, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: ISSUER,
    expiresIn: Math.floor(config.tokenTtlMs / 1000)
  });

const readToken = (token) => {
  try {
    return jwt.verify(token, config.authSecret, { algorithms: ['HS256'], issuer: ISSUER });
  } catch {
    return null;
  }
};

export const publicUser = (u) => {
  if (!u) return null;
  const { hash, salt, ...rest } = u;
  return { ...rest, role: u.role || 'user' };
};

export const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const data = readToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  const user = data && (await users.byId(data.sub));
  if (!user) return res.status(401).json({ message: 'Please sign in to continue.' });
  req.user = user;
  next();
};

export const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const data = token ? readToken(token) : null;
  const user = data && (await users.byId(data.sub));
  if (user) req.user = user;
  next();
};

// Authorization: only the administrator. Always used after requireAuth.
export const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Administrator access is required.' });
  next();
};
