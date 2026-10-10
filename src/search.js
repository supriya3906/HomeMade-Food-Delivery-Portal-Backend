// Menu search used by GET /api/foods?q=... (English and Tamil).
import { norm, hasTamil } from './assistant/engine.js';
import { CATEGORIES } from './catalog.js';

const DIET_WORDS = { veg: 'veg vegetarian சைவம்', vegan: 'vegan plantbased வீகன்', 'non-veg': 'nonveg meat அசைவம்' };
const CAT_WORDS = {
  breakfast: 'breakfast tiffin காலை', lunch: 'lunch meals மதிய', dinner: 'dinner இரவு', snacks: 'snacks snack சிற்றுண்டி',
  sweets: 'sweets sweet dessert இனிப்பு', drinks: 'drinks drink beverage பானம்', brunch: 'brunch ப்ரஞ்ச்'
};
const squash = (s) => String(s || '').toLowerCase().replace(/non[\s-]*veg(etarian)?/g, 'nonveg');

const wordsOf = (f, chef) =>
  norm(squash([f.name, f.nameTa, f.description, f.descriptionTa, ...(f.tags || []), chef?.name, chef?.nameTa, DIET_WORDS[f.diet], ...(f.meals || []).map((m) => CAT_WORDS[m])].join(' '))).split(' ');

export const searchFoods = (foods, chefs, { q = '', category = '', diet = '', maxPrice = 0, sort = 'popular' } = {}) => {
  const chefById = new Map(chefs.map((c) => [c.id, c]));
  const tokens = norm(squash(q)).split(' ').filter(Boolean);
  const TIFFIN_REGEX = /\b(idli|dosa|dosai|vada|vadai|pongal|upma|paniyaram|pesarattu|thepla|chilla|poha|appam|poori|puri|bhel|sev|chaat|samosa|pakora|bhaji|pav|roll|uttapam|tikki)\b/i;

  let list = foods.filter((f) => {
    if (category && category !== 'all') {
      const meals = f.meals?.length ? f.meals : [f.category];
      if (!meals.includes(category)) return false;
      if (category === 'lunch') {
        // Strictly show lunch items alone, explicitly exclude tiffin items
        if (f.category !== 'lunch' && !meals.includes('lunch')) return false;
        if (TIFFIN_REGEX.test(f.name) || TIFFIN_REGEX.test(f.nameTa || '')) return false;
      }
    }
    if (diet && diet !== 'all' && f.diet !== diet) return false;
    if (maxPrice && f.price > maxPrice) return false;
    if (!tokens.length) return true;
    if (tokens.length === 1 && tokens[0] === 'lunch') {
      if (f.category !== 'lunch' && !(f.meals || []).includes('lunch')) return false;
      if (TIFFIN_REGEX.test(f.name) || TIFFIN_REGEX.test(f.nameTa || '')) return false;
      return true;
    }
    const words = wordsOf(f, chefById.get(f.chefId));
    return tokens.every((t) => words.some((w) => (hasTamil(t) ? w.includes(t) : w.startsWith(t))));
  });
  const by = {
    rating: (a, b) => b.rating - a.rating || b.reviews - a.reviews,
    'price-low': (a, b) => a.price - b.price,
    'price-high': (a, b) => b.price - a.price,
    popular: (a, b) => b.reviews - a.reviews || b.rating - a.rating
  };
  list = list.sort(by[sort] || by.popular);
  return list;
};
export const isCategory = (c) => CATEGORIES.includes(c);
