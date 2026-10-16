import { app } from '../src/app.js';
import { bootstrap } from '../src/bootstrap.js';

let bootstrapped = false;
let bootstrapPromise = null;

// Middleware ensures catalog & admin bootstrap runs before requests are handled
app.use(async (req, res, next) => {
  if (!bootstrapped) {
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        try {
          await bootstrap();
        } catch (err) {
          console.warn('[bootstrap] Initialization warning:', err.message);
        } finally {
          bootstrapped = true;
        }
      })();
    }
    await bootstrapPromise;
  }
  next();
});

export default app;
