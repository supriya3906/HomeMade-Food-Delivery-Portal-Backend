// Rasoi assistant brain (English + Tamil). It reads the live menu, the signed-in user's cart,
// orders and viewing history that the route loads from the database, and answers from that data.
// Nothing about dishes, prices or ratings is written in this file.
//
//   answer(rawText, ctx) -> { dishes: [foodId...], en: { text, nav }, ta: { text, nav } }
//
// Both languages are produced for every question so the app can switch the whole chat
// between English and Tamil instantly, including earlier messages.
export const hasTamil = (text) => /[\u0B80-\u0BFF]/.test(text || '');
export const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Latin keywords match whole words; Tamil keywords match anywhere (Tamil is heavily suffixed).
const has = (text, words) =>
  words.some((w) => {
    const k = norm(w);
    return hasTamil(k) ? text.includes(k) : new RegExp(`(^| )${k}( |$)`).test(text);
  });

const KW = {
  greet: ['hi', 'hello', 'hey', 'hai', 'good morning', 'good evening', 'good afternoon', 'vanakkam', 'வணக்கம்', 'ஹலோ', 'ஹாய்'],
  thanks: ['thanks', 'thank you', 'thx', 'நன்றி'],
  bye: ['bye', 'goodbye', 'see you', 'பை', 'போய் வருகிறேன்'],
  help: ['help', 'what can you do', 'how to use', 'உதவி', 'என்ன செய்ய'],
  cart: ['cart', 'basket', 'my bag', 'கார்ட்', 'கூடை', 'கூடையில்'],
  track: ['track', 'order status', 'where is my order', 'my orders', 'my order', 'ஆர்டர் எங்கே', 'ஆர்டர் நிலை', 'என் ஆர்டர்', 'டிராக்'],
  pay: ['payment', 'payments', 'paying', 'pay', 'fee', 'fees', 'charges', 'upi', 'cod', 'cash', 'gpay', 'google pay', 'phonepe', 'paytm', 'delivery fee', 'delivery charge', 'tax', 'gst', 'கட்டணம்', 'பணம்', 'வரி', 'யூபிஐ', 'ரொக்கம்', 'செலுத்த'],
  time: ['how long', 'delivery time', 'eta', 'how fast', 'when will', 'எவ்வளவு நேரம்', 'எப்போது வரும்', 'நேரம்'],
  cheap: ['cheap', 'cheapest', 'budget', 'low price', 'affordable', 'மலிவு', 'மலிவான', 'குறைந்த விலை'],
  best: ['best', 'top', 'popular', 'recommend', 'suggest', 'special', 'bestseller', 'சிறந்த', 'பிரபலமான', 'பரிந்துரை', 'பரிந்துரைக்க'],
  now: ['what should i eat', 'what to eat', 'hungry', 'i am hungry', 'surprise me', 'பசிக்கிறது', 'பசி', 'என்ன சாப்பிடலாம்', 'இப்போது'],
  chefs: ['chef', 'chefs', 'cook', 'சமையல்காரர்', 'செஃப்', 'சமையல்']
};
const CATEGORY_KW = {
  breakfast: ['breakfast', 'tiffin', 'morning', 'காலை', 'டிபன்', 'பிரேக்ஃபாஸ்ட்', 'பிரேக்பாஸ்ட்', 'டிஃபன்'],
  lunch: ['lunch', 'meals', 'thali', 'மதிய', 'மதியம்', 'லஞ்ச்', 'சாப்பாடு', 'தாலி'],
  dinner: ['dinner', 'night', 'supper', 'இரவு', 'டின்னர்'],
  snacks: ['snack', 'snacks', 'evening', 'சிற்றுண்டி', 'ஸ்நாக்ஸ்', 'ஸ்நாக்'],
  sweets: ['sweet', 'sweets', 'dessert', 'desserts', 'இனிப்பு', 'ஸ்வீட்', 'டெசர்ட்'],
  drinks: ['drink', 'drinks', 'beverage', 'juice', 'பானம்', 'பானங்கள்', 'குடிக்க', 'ஜூஸ்', 'டிரிங்க்ஸ்', 'காபி', 'coffee'],
  brunch: ['brunch', 'ப்ரஞ்ச்', 'பிரஞ்ச்', 'ப்ரன்ச்', 'பிரன்ச்']
};
const DIET_KW = {
  'non-veg': ['non veg', 'nonveg', 'non vegetarian', 'meat', 'mutton', 'அசைவ', 'அசைவம்'],
  vegan: ['vegan', 'வீகன்'],
  veg: ['veg', 'vegetarian', 'pure veg', 'சைவ', 'சைவம்']
};
// Spellings people use that differ from how a dish is written on the menu.
const SYNONYMS = { dosai: 'dosa', biriyani: 'biryani', laddu: 'ladoo', laddoo: 'ladoo', jilebi: 'jalebi', vadai: 'vada', poori: 'puri', pakoda: 'pakora', tea: 'chai', samosas: 'samosa', idly: 'idli', kaapi: 'coffee' };
const STOP = new Set(('show me the a an of for in on at to is are was be do does you your my i we it this that these those what which who how any some there here have has get give want need like please tell find list see about with and or but not no yes ' +
  'good best top dish dishes food foods item items menu price prices cost rating rated under below within upto up than less more cheap cheapest ' +
  'can could would should will now today tonight morning evening தயவு செய்து எனக்கு காட்டு காட்டுங்கள் விலை என்ன எவ்வளவு உள்ளது இருக்கு இருக்கா வேண்டும்').split(' '));
const ALL_KW = new Set([...Object.values(KW), ...Object.values(CATEGORY_KW), ...Object.values(DIET_KW)].flat().flatMap((w) => norm(w).split(' ')));

const pick = (lang, en, ta) => (lang === 'ta' ? ta : en);
const money = (n) => `₹${n}`;
const stars = (n) => `${Number(n).toFixed(1)}★`;
export const dishName = (f, lang) => (lang === 'ta' ? f.nameTa || f.name : f.name);
const chefName = (c, lang) => (c ? (lang === 'ta' ? c.nameTa || c.name : c.name) : '');
const list = (items, lang) => items.map((f) => `${dishName(f, lang)} (${money(f.price)}, ${stars(f.rating)})`).join(', ');
const inMeal = (f, id) => (f.meals?.length ? f.meals : [f.category]).includes(id);

const CAT_LABEL = {
  breakfast: ['Breakfast / Tiffin', 'காலை உணவு / டிபன்'], lunch: ['Lunch', 'மதிய உணவு'], dinner: ['Dinner', 'இரவு உணவு'],
  snacks: ['Snacks', 'சிற்றுண்டிகள்'], sweets: ['Sweets', 'இனிப்புகள்'], drinks: ['Drinks', 'பானங்கள்'], brunch: ['Brunch', 'ப்ரஞ்ச்']
};
const catLabel = (id, lang) => (CAT_LABEL[id] ? CAT_LABEL[id][lang === 'ta' ? 1 : 0] : id);
const dietLabel = (d, lang) => (d === 'non-veg' ? pick(lang, 'non-veg', 'அசைவம்') : d === 'vegan' ? pick(lang, 'vegan', 'வீகன்') : pick(lang, 'veg', 'சைவம்'));

const budgetOf = (raw) => {
  const en = raw.match(/(?:under|below|less than|within|upto|up to)\s*(?:rs\.?|₹|rupees)?\s*(\d{2,4})/i);
  if (en) return Number(en[1]);
  const ta = raw.match(/(\d{2,4})\s*(?:ரூபாய்|ரூ|₹)?\s*(?:க்குள்|குள்|கீழ்|க்கு கீழ்)/);
  return ta ? Number(ta[1]) : null;
};

// ---- finding dishes by name (works on whatever the menu currently contains) ----
const contentTokens = (text) =>
  text.split(' ')
    .map((w) => SYNONYMS[w] || w)
    .filter((w) => w && !/^\d+$/.test(w) && !STOP.has(w) && !ALL_KW.has(w) && (hasTamil(w) ? w.length >= 3 : w.length >= 3));

const dishScore = (f, tokens) => {
  const en = norm([f.name, ...(f.tags || [])].join(' ')).split(' ');
  const ta = norm(f.nameTa || '').split(' ');
  let score = 0;
  for (const t of tokens) {
    if (hasTamil(t)) {
      if (ta.some((w) => w.length >= 3 && (t.startsWith(w) || w.startsWith(t)))) score += 1;
    } else if (en.some((w) => w === t || (t.length >= 4 && w.startsWith(t)))) score += 1;
  }
  return score;
};
export const findDishes = (text, foods) => {
  const tokens = contentTokens(text);
  if (!tokens.length) return [];
  const scored = foods.map((f) => ({ f, s: dishScore(f, tokens) })).filter((x) => x.s > 0);
  const top = Math.max(0, ...scored.map((x) => x.s));
  return scored.filter((x) => x.s === top).sort((a, b) => b.f.rating - a.f.rating || b.f.reviews - a.f.reviews).map((x) => x.f);
};
const findChef = (text, chefs) => {
  const tokens = contentTokens(text);
  return tokens.length ? chefs.find((c) => tokens.some((t) => norm(`${c.name} ${c.nameTa || ''}`).split(' ').some((w) => w.length >= 4 && (w === t || (hasTamil(t) && t.startsWith(w)))))) : null;
};

// ---- personalised ranking, built from the user's own orders and views ----
export const rankForUser = (foods, profile = {}) => {
  const cat = profile.catScore || {};
  const top = Math.max(1, ...Object.values(cat));
  return [...foods]
    .map((f) => {
      let s = f.rating * 2 + Math.log10(1 + f.reviews) * 0.6;
      s += ((cat[f.category] || 0) / top) * 2.5;
      if (profile.recentIds?.has(f.id)) s += 0.8;
      if (profile.mostlyVeg && f.diet === 'non-veg') s -= 1.5;
      if (profile.orderedIds?.has(f.id)) s += 0.3;
      return { f, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.f);
};

const mealForHour = (h) => (h >= 5 && h < 11 ? 'breakfast' : h >= 11 && h < 15 ? 'lunch' : h >= 15 && h < 19 ? 'snacks' : h >= 19 && h < 23 ? 'dinner' : null);

const seeAll = (params, lang) => {
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return { to: `/menu${qs ? `?${qs}` : ''}`, label: pick(lang, 'See all', 'அனைத்தையும் பார்') };
};

// Works out WHAT was asked once (language free) ...
const analyze = (raw, ctx) => {
  const text = norm(raw);
  const { foods = [], chefs = [], cartItems = [], lastOrder = null, profile = {}, hour = null } = ctx;
  if (!text) return { kind: 'empty' };

  const category = Object.keys(CATEGORY_KW).find((id) => has(text, CATEGORY_KW[id]));
  const dietKey = ['non-veg', 'vegan', 'veg'].find((d) => has(text, DIET_KW[d]));
  const budget = budgetOf(raw);
  const named = findDishes(text, foods);
  const wantsBest = has(text, KW.best);
  const wantsCheap = has(text, KW.cheap) || !!budget;
  const wantsNow = has(text, KW.now);

  if (has(text, KW.thanks)) return { kind: 'thanks' };
  if (has(text, KW.bye)) return { kind: 'bye' };
  if (has(text, KW.help)) return { kind: 'help' };
  if (has(text, KW.cart) && !named.length) return { kind: 'cart', cartItems };
  if (has(text, KW.track)) return { kind: 'orders', lastOrder };
  if (has(text, KW.pay) && !named.length && !category) return { kind: 'pay' };
  if (has(text, KW.time)) return { kind: 'time' };
  if (has(text, KW.chefs) && !named.length) {
    const chef = findChef(text, chefs);
    if (chef) return { kind: 'chefDishes', chef, items: foods.filter((f) => f.chefId === chef.id).sort((a, b) => b.rating - a.rating).slice(0, 4) };
    return { kind: 'chefs' };
  }
  const chefHit = findChef(text, chefs);
  if (chefHit && !category && !dietKey) return { kind: 'chefDishes', chef: chefHit, items: foods.filter((f) => f.chefId === chefHit.id).sort((a, b) => b.rating - a.rating).slice(0, 4) };

  // a specific dish (optionally inside a meal / diet / budget)
  if (named.length && !(wantsBest && !named.length)) {
    let items = named;
    if (category) items = items.filter((f) => inMeal(f, category));
    if (dietKey === 'veg') items = items.filter((f) => f.diet !== 'non-veg'); else if (dietKey) items = items.filter((f) => f.diet === dietKey);
    if (budget) items = items.filter((f) => f.price <= budget);
    if (items.length) {
      const top = items.slice(0, 3);
      return { kind: 'dish', items: top, q: contentTokens(text).join(' '), category, chefs };
    }
  }

  // browsing: meal / diet / budget / best / cheapest / "what should I eat"
  if (category || dietKey || wantsBest || wantsCheap || wantsNow) {
    let pool = [...foods];
    let mode = 'top';
    let cat = category;
    if (!cat && wantsNow) { cat = mealForHour(hour); mode = 'now'; }
    if (cat) pool = pool.filter((f) => inMeal(f, cat));
    if (dietKey === 'veg') pool = pool.filter((f) => f.diet === 'veg' || f.diet === 'vegan');
    else if (dietKey) pool = pool.filter((f) => f.diet === dietKey);
    if (budget) pool = pool.filter((f) => f.price <= budget);
    let personal = false;
    if (wantsCheap) { pool.sort((a, b) => a.price - b.price || b.rating - a.rating); mode = 'cheap'; }
    else if (wantsBest || wantsNow) { pool = rankForUser(pool, profile); personal = !!profile.hasHistory; if (mode !== 'now') mode = 'best'; }
    else pool.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);
    return { kind: 'browse', items: pool.slice(0, 4), total: pool.length, category: cat, dietKey, budget, mode, personal, hour };
  }
  if (has(text, KW.greet)) return { kind: 'greet' };
  return { kind: 'unknown' };
};

// ... then words it in one language.
const compose = (r, lang, ctx) => {
  const t = (en, ta) => pick(lang, en, ta);
  const menuNav = { to: '/menu', label: t('Browse the menu', 'மெனுவைப் பாருங்கள்') };
  switch (r.kind) {
    case 'empty': return { text: t('Please type or say something.', 'ஏதாவது தட்டச்சு செய்யுங்கள் அல்லது பேசுங்கள்.'), nav: [] };
    case 'thanks': return { text: t("You're welcome! Enjoy your meal 😊", 'நன்றி! சாப்பிட்டு மகிழுங்கள் 😊'), nav: [] };
    case 'bye': return { text: t('Bye! Come back hungry 🍽️', 'பை! மீண்டும் வாருங்கள் 🍽️'), nav: [] };
    case 'greet': return { text: t('Hello! What are you in the mood for — breakfast, lunch, dinner, snacks, sweets, drinks or brunch?', 'வணக்கம்! என்ன சாப்பிடலாம் — காலை உணவு, மதிய உணவு, இரவு உணவு, சிற்றுண்டி, இனிப்பு, பானம் அல்லது ப்ரஞ்ச்?'), nav: [] };
    case 'help': return {
      text: t(
        "I can: suggest dishes by meal (breakfast, lunch, dinner, snacks, sweets, drinks, brunch), recommend dishes based on what you ordered and viewed, filter veg / non-veg / vegan, find dishes under a budget, tell you a dish's price and rating, show your cart, explain payments and delivery fees, and help you track orders.",
        'நான் செய்யக்கூடியவை: வேளை வாரியாக உணவுகளைப் பரிந்துரைத்தல் (காலை, மதியம், இரவு, சிற்றுண்டி, இனிப்பு, பானம், ப்ரஞ்ச்), நீங்கள் ஆர்டர் செய்ததையும் பார்த்ததையும் வைத்துப் பரிந்துரைத்தல், சைவம் / அசைவம் / வீகன் வடிகட்டுதல், பட்ஜெட்டுக்குள் உணவுகள், விலை மற்றும் மதிப்பீடு, உங்கள் கூடை, பணம் செலுத்தும் முறை மற்றும் டெலிவரி கட்டணம், ஆர்டர் கண்காணிப்பு.'),
      nav: []
    };
    case 'cart': {
      if (!r.cartItems.length) return { text: t('Your cart is empty. Want some ideas?', 'உங்கள் கூடை காலியாக உள்ளது. சில பரிந்துரைகள் வேண்டுமா?'), nav: [menuNav] };
      const lines = r.cartItems.map((i) => `${i.quantity} × ${dishName(i.food, lang)}`).join(', ');
      const sub = r.cartItems.reduce((s, i) => s + i.food.price * i.quantity, 0);
      return {
        text: t(`In your cart: ${lines}. Subtotal ${money(sub)} (delivery fee and tax are added at payment).`, `உங்கள் கூடையில்: ${lines}. துணை மொத்தம் ${money(sub)} (டெலிவரி கட்டணமும் வரியும் பணம் செலுத்தும்போது சேரும்).`),
        nav: [{ to: '/cart', label: t('Open cart', 'கூடையைத் திற') }]
      };
    }
    case 'orders': {
      const nav = [{ to: '/orders', label: t('My orders', 'என் ஆர்டர்கள்') }];
      const o = r.lastOrder;
      if (!o) return { text: t('You have no orders yet. Place one from the menu!', 'உங்களுக்கு இன்னும் ஆர்டர்கள் இல்லை. மெனுவிலிருந்து ஆர்டர் செய்யுங்கள்!'), nav };
      const status = o.status === 'cancelled'
        ? t('cancelled', 'ரத்து செய்யப்பட்டது')
        : [t('placed', 'பெறப்பட்டது'), t('being prepared', 'தயாராகிறது'), t('out for delivery', 'டெலிவரிக்கு வந்துகொண்டிருக்கிறது'), t('delivered', 'டெலிவரி ஆனது')][o.stage];
      return {
        text: t(`Your latest order #${o.id} is ${status}.`, `உங்கள் சமீபத்திய ஆர்டர் #${o.id}: ${status}.`),
        nav: [{ to: `/orders/${o.id}/track`, label: t('Track order', 'ஆர்டரைக் கண்காணி') }, ...nav]
      };
    }
    case 'pay': {
      const { deliveryFee, taxPercent } = ctx.pricing;
      return {
        text: t(
          `You can pay with UPI (PhonePe, Google Pay, Paytm or BHIM) or Cash on delivery. Cash on delivery adds a ${money(deliveryFee)} delivery fee; UPI has no delivery fee. A ${taxPercent}% GST tax is added to every order.`,
          `UPI (PhonePe, Google Pay, Paytm, BHIM) அல்லது ரொக்கமாக (Cash on delivery) செலுத்தலாம். ரொக்கத்திற்கு ${money(deliveryFee)} டெலிவரி கட்டணம் உண்டு; UPI-க்கு டெலிவரி கட்டணம் இல்லை. எல்லா ஆர்டர்களுக்கும் ${taxPercent}% GST வரி சேரும்.`),
        nav: []
      };
    }
    case 'time': return { text: t('Dishes are cooked fresh by home chefs, so it usually takes 30–45 minutes. You can watch the live status on the order tracking page.', 'உணவுகள் வீட்டுச் சமையல்காரர்களால் புதிதாகச் சமைக்கப்படுவதால் பொதுவாக 30–45 நிமிடங்கள் ஆகும். ஆர்டர் கண்காணிப்புப் பக்கத்தில் நேரடி நிலையைப் பார்க்கலாம்.'), nav: [] };
    case 'chefs': return { text: t('Meet our home chefs and see what each one cooks.', 'எங்கள் வீட்டுச் சமையல்காரர்களையும் அவர்கள் சமைப்பதையும் பாருங்கள்.'), nav: [{ to: '/chefs', label: t('See chefs', 'சமையல்காரர்களைப் பார்') }] };
    case 'chefDishes':
      return {
        text: t(`Dishes cooked by ${chefName(r.chef, lang)}: ${list(r.items, lang)}.`, `${chefName(r.chef, lang)} சமைக்கும் உணவுகள்: ${list(r.items, lang)}.`),
        nav: [{ to: `/chefs/${r.chef.id}`, label: t('See chef', 'சமையல்காரரைப் பார்') }]
      };
    case 'dish': {
      const nav = [{ to: `/menu?q=${encodeURIComponent(r.q)}`, label: t('See all', 'அனைத்தையும் பார்') }];
      if (r.items.length === 1) {
        const f = r.items[0];
        const chef = r.chefs.find((c) => c.id === f.chefId);
        const diet = f.diet === 'non-veg' ? t('Non-vegetarian.', 'அசைவம்.') : f.diet === 'vegan' ? t('Vegan.', 'வீகன்.') : t('Vegetarian.', 'சைவம்.');
        return {
          text: t(
            `${dishName(f, lang)}: ${money(f.price)}, rated ${stars(f.rating)} (${f.reviews} reviews), ${f.prepMinutes} min${chef ? `, cooked by ${chefName(chef, lang)}` : ''}. ${diet}`,
            `${dishName(f, lang)}: ${money(f.price)}, மதிப்பீடு ${stars(f.rating)} (${f.reviews} கருத்துகள்), ${f.prepMinutes} நிமிடம்${chef ? `, சமைப்பவர் ${chefName(chef, lang)}` : ''}. ${diet}`),
          nav
        };
      }
      return { text: t(`Here is what I found: ${list(r.items, lang)}.`, `இதோ கிடைத்தவை: ${list(r.items, lang)}.`), nav };
    }
    case 'browse': {
      if (!r.items.length) return { text: t('I could not find a dish for that. Try a different meal, diet or budget.', 'அதற்குப் பொருத்தமான உணவு கிடைக்கவில்லை. வேறு வேளை, உணவு வகை அல்லது பட்ஜெட்டை முயலுங்கள்.'), nav: [menuNav] };
      const bits = [];
      if (r.category) bits.push(catLabel(r.category, lang));
      if (r.dietKey) bits.push(dietLabel(r.dietKey, lang));
      if (r.budget) bits.push(t(`under ${money(r.budget)}`, `${money(r.budget)}க்குள்`));
      const label = bits.join(' · ') || t('our top picks', 'எங்கள் சிறந்த தேர்வுகள்');
      const why = r.personal
        ? t(' Picked for you from your past orders and the dishes you viewed.', ' உங்கள் முந்தைய ஆர்டர்கள் மற்றும் நீங்கள் பார்த்த உணவுகளை வைத்துத் தேர்ந்தெடுத்தது.')
        : r.mode === 'now' && r.category ? t(' That suits this time of day.', ' இந்த நேரத்திற்குப் பொருத்தமானது.') : '';
      return {
        text: t(`Here are ${label}: ${list(r.items, lang)}.${why}`, `${label}: ${list(r.items, lang)}.${why}`),
        nav: [seeAll({ category: r.category, diet: r.dietKey, maxPrice: r.budget }, lang)]
      };
    }
    default:
      return {
        text: t('Sorry, I didn\'t get that. Try "breakfast", "veg dishes under 150", "price of masala dosa", "what is in my cart" or "how do payments work".', 'மன்னிக்கவும், புரியவில்லை. "காலை உணவு", "150க்குள் சைவம்", "மசாலா தோசை விலை", "என் கூடையில் என்ன உள்ளது" என்று முயலுங்கள்.'),
        nav: []
      };
  }
};

export const answer = (rawText, ctx) => {
  const raw = String(rawText || '').trim();
  const result = analyze(raw, ctx);
  const en = compose(result, 'en', ctx);
  const ta = compose(result, 'ta', ctx);
  const dishes = (result.items || []).map((f) => f.id);
  // nav links are the same in both languages, only their labels differ
  const nav = en.nav.map((n, i) => ({ to: n.to, label: { en: n.label, ta: ta.nav[i]?.label || n.label } }));
  return { intent: result.kind, dishes, texts: { en: en.text, ta: ta.text }, nav };
};
