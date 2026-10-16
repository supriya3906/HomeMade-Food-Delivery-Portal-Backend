import 'express-async-errors'; // lets async route handlers throw errors normally
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import orderRoutes from './routes/orders.js';
import paymentRoutes from './routes/payments.js';
import adminRoutes from './routes/admin.js';
import adminOpsRoutes from './routes/adminOps.js';
import recentRoutes from './routes/recent.js';
import assistantRoutes from './routes/assistant.js';
import offersRoutes from './routes/offers.js';
import { storeStatus } from './store.js';

export const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '100kb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Rasoi Food Delivery Backend API is running successfully!',
    database: storeStatus.kind,
    endpoints: {
      health: '/api/health',
      foods: '/api/foods',
      chefs: '/api/chefs',
      offers: '/api/offers'
    }
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, database: storeStatus.kind }));
app.use('/api/auth', authRoutes);
app.use('/api/offers', offersRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminOpsRoutes); // dashboard, revenue, dispatch, payments, analytics (admin only)
app.use('/api/admin', adminRoutes);
app.use('/api/recent', recentRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api', catalogRoutes);

app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.originalUrl || req.url} not found. API endpoints start with /api.` });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ message: status === 500 ? 'Something went wrong on our side.' : err.message });
});
