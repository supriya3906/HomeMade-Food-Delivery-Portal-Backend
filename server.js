import { app } from './src/app.js';
import { config } from './src/config.js';
import { storeInfo, orders } from './src/store.js';
import { bootstrap } from './src/bootstrap.js';
import { isOpen, autoAssignIfPossible } from './src/dispatch.js';
import { ADMIN_ASSIGN_WINDOW_MS } from './src/tracking.js';

await bootstrap();

// Background timer: automatically assigns nearest available delivery partner if admin has not assigned one within 2 minutes
setInterval(async () => {
  try {
    const all = await orders.all();
    const now = Date.now();
    for (const o of all) {
      if (isOpen(o) && !o.partner) {
        const placedMs = new Date(o.placedAt).getTime();
        if (now - placedMs >= ADMIN_ASSIGN_WINDOW_MS) {
          await autoAssignIfPossible(o);
        }
      }
    }
  } catch {
    // ignore
  }
}, 5000);

app.listen(config.port, () => {
  console.log(`Rasoi API running on http://localhost:${config.port}\nData store: ${storeInfo}`);
});
