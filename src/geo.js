// Location helpers. There is no geocoding service connected, so a customer's position is
// resolved in this order: (1) exact GPS sent by the browser at checkout, (2) the delivery zone
// matched from the address text / PIN code (area-level: the zone centre). The result says which one it was.
export const haversineKm = (a, b) => {
  if (!a || !b) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};
export const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

export const validPoint = (lat, lng) => {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0) ? { lat: a, lng: b } : null;
};

// Starting zones (approximate town centres in Virudhunagar district, Tamil Nadu). Editable in the admin.
export const DEFAULT_ZONES = [
  { id: 'z01', name: 'Srivilliputhur', lat: 9.5127, lng: 77.6337, radiusKm: 8, keywords: ['srivilliputhur', 'srivilliputtur', '626125'] },
  { id: 'z02', name: 'Rajapalayam', lat: 9.4528, lng: 77.5539, radiusKm: 8, keywords: ['rajapalayam', '626117'] },
  { id: 'z03', name: 'Sivakasi', lat: 9.4533, lng: 77.8024, radiusKm: 9, keywords: ['sivakasi', '626123'] },
  { id: 'z04', name: 'Virudhunagar', lat: 9.568, lng: 77.9624, radiusKm: 9, keywords: ['virudhunagar', '626001'] },
  { id: 'z05', name: 'Aruppukottai', lat: 9.5084, lng: 78.0961, radiusKm: 9, keywords: ['aruppukottai', 'aruppukkottai', '626101'] },
  { id: 'z06', name: 'Nearby Areas', lat: 9.6296, lng: 77.628, radiusKm: 10, keywords: ['watrap', 'vatrap', 'nearby'] }
];

const norm = (s) => String(s || '').toLowerCase();

export const zoneByText = (zones, ...texts) => {
  const hay = texts.map(norm).join(' | ');
  return zones.filter((z) => z.active !== false).find((z) => [z.name, ...(z.keywords || [])].some((k) => k && hay.includes(norm(k)))) || null;
};
export const zoneAt = (zones, point) => {
  if (!point) return null;
  const list = zones.filter((z) => z.active !== false).map((z) => ({ z, d: haversineKm(point, z) })).sort((a, b) => a.d - b.d);
  return list.length && list[0].d <= list[0].z.radiusKm * 1.5 ? list[0].z : null;
};

// -> { zone, point, source: 'gps' | 'zone' | 'unknown' }
export const resolveCustomer = (address = {}, zones = []) => {
  const gps = validPoint(address.lat, address.lng);
  if (gps) return { zone: zoneAt(zones, gps) || zoneByText(zones, address.city, address.address, address.pincode), point: gps, source: 'gps' };
  const zone = zoneByText(zones, address.pincode, address.city, address.address);
  return zone ? { zone, point: { lat: zone.lat, lng: zone.lng }, source: 'zone' } : { zone: null, point: null, source: 'unknown' };
};

// Where the kitchen is: (1) coordinates saved on the chef, (2) the chef's town if it is a delivery zone,
// (3) otherwise ASSUMED to be about 1-2.5 km from the customer's zone centre (clearly labelled 'assumed').
const hash = (str) => [...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const resolveKitchen = (chef, zones = [], customerZone = null) => {
  const own = validPoint(chef?.lat, chef?.lng);
  if (own) return { zone: zoneAt(zones, own), point: own, source: 'chef' };
  const zone = zoneByText(zones, chef?.city);
  if (zone) return { zone, point: { lat: zone.lat, lng: zone.lng }, source: 'zone' };
  if (customerZone) {
    const h = hash(chef?.id);
    const km = 1 + (h % 15) / 10, ang = ((h >> 4) % 360) * (Math.PI / 180);
    return { zone: customerZone, point: { lat: customerZone.lat + (Math.cos(ang) * km) / 111, lng: customerZone.lng + (Math.sin(ang) * km) / (111 * Math.cos((customerZone.lat * Math.PI) / 180)) }, source: 'assumed' };
  }
  return { zone: null, point: null, source: 'unknown' };
};
