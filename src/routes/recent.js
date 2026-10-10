// "Recently accessed": remembers which dishes, chefs and menu sections the signed-in user opened.
import { Router } from 'express';
import { recent } from '../store.js';
import { requireAuth } from '../auth.js';
import { getFood, getChef, CATEGORIES } from '../catalog.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 12, 30);
  const rows = await recent.list(req.user.id, 60);
  const out = [];
  for (const r of rows) {
    if (r.type === 'food') {
      const food = await getFood(r.id);
      if (food) out.push({ ...r, food });
    } else if (r.type === 'chef') {
      const chef = await getChef(r.id);
      if (chef) out.push({ ...r, chef });
    } else if (r.type === 'category' && CATEGORIES.includes(r.id)) out.push(r);
    if (out.length >= limit) break;
  }
  res.json(out);
});

router.post('/', async (req, res) => {
  const type = String(req.body.type || '');
  const id = String(req.body.id || '');
  const valid =
    (type === 'food' && (await getFood(id))) ||
    (type === 'chef' && (await getChef(id))) ||
    (type === 'category' && CATEGORIES.includes(id));
  if (!valid) return res.status(400).json({ message: 'Unknown item.' });
  await recent.touch(req.user.id, type, id);
  res.status(201).json({ ok: true });
});

router.delete('/', async (req, res) => {
  await recent.clear(req.user.id);
  res.json({ ok: true });
});

export default router;
