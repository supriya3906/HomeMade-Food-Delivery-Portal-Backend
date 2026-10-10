import { settings, orders } from './store.js';

export const DEFAULT_TIERS = {
  silver: {
    id: 'silver',
    name: 'Silver Card',
    minOrders: 0,
    discountPct: 5,
    color: '#94a3b8',
    badge: '🥈 Silver',
    freeDelivery: false,
    perk: '5% instant discount on all homemade meals'
  },
  gold: {
    id: 'gold',
    name: 'Gold Card',
    minOrders: 5,
    discountPct: 10,
    color: '#eab308',
    badge: '🥇 Gold',
    freeDelivery: false,
    perk: '10% instant discount & priority kitchen slot'
  },
  vip: {
    id: 'vip',
    name: 'VIP Member Card',
    minOrders: 10,
    discountPct: 15,
    color: '#a855f7',
    badge: '👑 VIP',
    freeDelivery: true,
    perk: '15% instant discount + Unlimited zero-fee deliveries'
  }
};

export const getTierSettings = async () => {
  try {
    const custom = await settings.get('membership_tiers');
    if (custom && typeof custom === 'object') {
      return {
        silver: { ...DEFAULT_TIERS.silver, ...custom.silver, minOrders: Number(custom.silver?.minOrders ?? DEFAULT_TIERS.silver.minOrders), discountPct: Number(custom.silver?.discountPct ?? DEFAULT_TIERS.silver.discountPct) },
        gold: { ...DEFAULT_TIERS.gold, ...custom.gold, minOrders: Number(custom.gold?.minOrders ?? DEFAULT_TIERS.gold.minOrders), discountPct: Number(custom.gold?.discountPct ?? DEFAULT_TIERS.gold.discountPct) },
        vip: { ...DEFAULT_TIERS.vip, ...custom.vip, minOrders: Number(custom.vip?.minOrders ?? DEFAULT_TIERS.vip.minOrders), discountPct: Number(custom.vip?.discountPct ?? DEFAULT_TIERS.vip.discountPct) }
      };
    }
  } catch (err) {
    console.warn('Failed to load tier settings from database, using defaults:', err.message);
  }
  return DEFAULT_TIERS;
};

export const setTierSettings = async (patch) => {
  const current = await getTierSettings();
  const updated = {
    silver: {
      ...current.silver,
      minOrders: Math.max(0, Number(patch.silver?.minOrders ?? current.silver.minOrders)),
      discountPct: Math.min(100, Math.max(0, Number(patch.silver?.discountPct ?? current.silver.discountPct)))
    },
    gold: {
      ...current.gold,
      minOrders: Math.max(1, Number(patch.gold?.minOrders ?? current.gold.minOrders)),
      discountPct: Math.min(100, Math.max(0, Number(patch.gold?.discountPct ?? current.gold.discountPct)))
    },
    vip: {
      ...current.vip,
      minOrders: Math.max(2, Number(patch.vip?.minOrders ?? current.vip.minOrders)),
      discountPct: Math.min(100, Math.max(0, Number(patch.vip?.discountPct ?? current.vip.discountPct)))
    }
  };
  await settings.set('membership_tiers', updated);
  return updated;
};

export const getCompletedOrdersCount = async (userId) => {
  if (!userId) return 0;
  const userOrders = await orders.forUser(userId);
  return userOrders.filter(
    (o) => o.status !== 'cancelled' && (o.stage === 3 || o.paymentStatus === 'paid')
  ).length;
};

export const calculateUserTier = (completedCount, tierSettings = DEFAULT_TIERS) => {
  const count = Number(completedCount) || 0;
  const silver = tierSettings.silver || DEFAULT_TIERS.silver;
  const gold = tierSettings.gold || DEFAULT_TIERS.gold;
  const vip = tierSettings.vip || DEFAULT_TIERS.vip;

  if (count >= vip.minOrders) {
    return {
      tier: 'vip',
      id: 'vip',
      name: vip.name,
      badge: vip.badge,
      color: vip.color,
      discountPct: vip.discountPct,
      freeDelivery: !!vip.freeDelivery,
      perk: vip.perk,
      completedOrders: count,
      nextTier: null,
      ordersNeeded: 0,
      targetOrders: vip.minOrders,
      progressPct: 100
    };
  }

  if (count >= gold.minOrders) {
    const span = Math.max(1, vip.minOrders - gold.minOrders);
    const progress = Math.min(100, Math.round(((count - gold.minOrders) / span) * 100));
    return {
      tier: 'gold',
      id: 'gold',
      name: gold.name,
      badge: gold.badge,
      color: gold.color,
      discountPct: gold.discountPct,
      freeDelivery: !!gold.freeDelivery,
      perk: gold.perk,
      completedOrders: count,
      nextTier: 'vip',
      ordersNeeded: vip.minOrders - count,
      targetOrders: vip.minOrders,
      progressPct: progress
    };
  }

  const span = Math.max(1, gold.minOrders);
  const progress = Math.min(100, Math.round((count / span) * 100));
  return {
    tier: 'silver',
    id: 'silver',
    name: silver.name,
    badge: silver.badge,
    color: silver.color,
    discountPct: silver.discountPct,
    freeDelivery: !!silver.freeDelivery,
    perk: silver.perk,
    completedOrders: count,
    nextTier: 'gold',
    ordersNeeded: Math.max(0, gold.minOrders - count),
    targetOrders: gold.minOrders,
    progressPct: progress
  };
};

export const getUserTier = async (userId) => {
  const [completedCount, settings] = await Promise.all([
    getCompletedOrdersCount(userId),
    getTierSettings()
  ]);
  return calculateUserTier(completedCount, settings);
};
