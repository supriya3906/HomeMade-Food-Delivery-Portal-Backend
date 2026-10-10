import { app } from '../src/app.js';
import { bootstrap } from '../src/bootstrap.js';

let initialized = false;

export default async function handler(req, res) {
  if (!initialized) {
    try {
      await bootstrap();
    } catch (err) {
      console.error('[bootstrap] Initialization warning:', err.message);
    }
    initialized = true;
  }
  return app(req, res);
}
