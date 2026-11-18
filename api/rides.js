// api/rides.js — solicitudes compartidas entre celulares (Upstash Redis por REST, sin dependencias)
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'ruedabca:rides';
const S = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
const N = v => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function load() {
  const raw = await redis(['GET', KEY]);
  const all = raw ? JSON.parse(raw) : {};
  const now = Date.now();
  for (const id in all) if (now - all[id].createdAt > 2 * 3600 * 1000) delete all[id];
  return all;
}
const save = all => redis(['SET', KEY, JSON.stringify(all), 'EX', '86400']);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Falta conectar Upstash Redis en Vercel' });
  try {
    const all = await load();
    if (req.method === 'GET') {
      const { id } = req.query || {};
      if (id) return res.status(200).json({ ride: all[S(id)] || null });
      const rides = Object.values(all).filter(r => ['BUSCANDO', 'NEGOCIANDO', 'CONFIRMADO'].includes(r.status));
      return res.status(200).json({ rides });
    }
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = S(b.id, 60);
    let r = all[id];
    const act = b.action;
    if (act === 'create') {
      const x = b.ride || {};
      const nid = S(x.id, 60);
      if (!nid) return res.status(400).json({ error: 'Falta id' });
      r = all[nid] = { id: nid, pickup: S(x.pickup), pickupLat: N(x.pickupLat), pickupLng: N(x.pickupLng), passenger: S(x.passenger, 80), destination: S(x.destination), destLat: N(x.destLat), destLng: N(x.destLng), status: 'BUSCANDO', responses: [], turn: 0, driverId: null, messages: [], offers: {}, fare: null, createdAt: Date.now() };
    } else if (r) {
      const dId = S(b.driverId, 60);
      if (act === 'respond' && ['BUSCANDO', 'NEGOCIANDO'].includes(r.status) && b.driver && !r.responses.some(x => x.id === S(b.driver.id, 60))) {
        const d = b.driver;
        r.responses.push({ id: S(d.id, 60), name: S(d.name, 60), vehicle: S(d.vehicle, 80), lat: N(d.lat), lng: N(d.lng), distance: N(d.distance), status: 'ESPERANDO' });
        if (r.status === 'BUSCANDO') { r.turn = r.responses.length - 1; r.status = 'NEGOCIANDO'; r.driverId = r.responses[r.turn].id; r.responses[r.turn].status = 'ACTIVO'; r.offers = {}; }
      } else if (act === 'message' && r.status === 'NEGOCIANDO' && dId === r.driverId && S(b.text).trim()) {
        r.messages.push({ driverId: dId, from: b.from === 'conductor' ? 'conductor' : 'pasajero', text: S(b.text, 500), t: Date.now() });
        r.messages = r.messages.slice(-200);
      } else if (act === 'offer' && r.status === 'NEGOCIANDO' && dId === r.driverId && N(b.fare) > 0) {
        r.offers[b.role === 'conductor' ? 'conductor' : 'pasajero'] = N(b.fare);
        if (r.offers.pasajero && r.offers.pasajero === r.offers.conductor) { r.status = 'CONFIRMADO'; r.fare = r.offers.pasajero; r.responses[r.turn].status = 'CONFIRMADO'; }
      } else if (act === 'next' && r.status === 'NEGOCIANDO' && dId === r.driverId) {
        r.responses[r.turn].status = 'FINALIZADO'; r.offers = {};
        if (r.turn + 1 < r.responses.length) { r.turn += 1; r.driverId = r.responses[r.turn].id; r.responses[r.turn].status = 'ACTIVO'; }
        else { r.status = 'BUSCANDO'; r.driverId = null; }
      } else if (act === 'finish' && r.status === 'CONFIRMADO') {
        r.status = 'FINALIZADO';
      } else if (act === 'cancel' && r.status !== 'FINALIZADO') {
        r.status = 'CANCELADO';
      }
    }
    if (r) r.updatedAt = Date.now();
    await save(all);
    return res.status(200).json({ ride: r || null });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
