// api/users.js — registro de usuarios (Upstash Redis por REST, sin dependencias)
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'ruedabca:users';
const S = (v, n = 120) => String(v == null ? '' : v).slice(0, n);

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Falta conectar Upstash Redis en Vercel' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const u = b.user || {};
    const type = u.type === 'driver' ? 'driver' : 'passenger';
    const name = S(u.name, 100).trim().replace(/\s+/g, ' ');
    const dni = S(u.dni, 8);
    const plate = type === 'driver' ? S(u.plate, 15).trim().toUpperCase() : '';
    if (!/^\d{8}$/.test(dni) || name.length < 6) return res.status(400).json({ error: 'Datos inválidos' });
    if (type === 'driver' && plate.length < 4) return res.status(400).json({ error: 'Falta la placa o guía' });
    // Los datos se guardan solo en el servidor; nunca se devuelven ni se comparten con otros usuarios.
    await redis(['HSET', KEY, dni, JSON.stringify({ name, dni, type, plate, uid: S(b.uid, 60), updatedAt: Date.now() })]);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
