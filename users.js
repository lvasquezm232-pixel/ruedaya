// api/users.js — registro de usuarios con aprobación por Telegram (Upstash Redis por REST, sin dependencias)
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TG = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const KEY = 'ruedabca:users';
const S = (v, n = 120) => String(v == null ? '' : v).slice(0, n);

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
async function tg(method, body) {
  const r = await fetch('https://api.telegram.org/bot' + TG + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
const needsApproval = () => !!(TG && CHAT);
const save = u => redis(['HSET', KEY, u.dni + ':' + u.uid, JSON.stringify(u)]);

// Busca el registro de este DNI + celular (migra el formato anterior si hace falta)
async function lookup(dni, uid) {
  const raw = await redis(['HGET', KEY, dni + ':' + uid]);
  if (raw) return JSON.parse(raw);
  const old = await redis(['HGET', KEY, dni]);
  if (old) {
    const u = JSON.parse(old);
    if (u.uid === uid) {
      u.status = u.status || (needsApproval() ? 'PENDIENTE' : 'APROBADO');
      await save(u); await redis(['HDEL', KEY, dni]);
      if (u.status === 'PENDIENTE') await notify(u, '');
      return u;
    }
  }
  return null;
}
async function notify(u, note) {
  if (!needsApproval()) return;
  const text = '🆕 Nuevo registro — ' + (u.type === 'driver' ? 'MOTOTAXISTA' : 'PASAJERO') + '\n\nNombre: ' + u.name + '\nDNI: ' + u.dni + '\nWhatsApp: ' + (u.wa ? '+51 ' + u.wa + '\nhttps://wa.me/51' + u.wa : 'no indicado') + (u.type === 'driver' ? '\nPlaca/guía: ' + u.plate : '') + (note ? '\n\n' + note : '');
  const cb = u.dni + ':' + u.uid;
  try { await tg('sendMessage', { chat_id: CHAT, text, disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '✅ Aprobar', callback_data: 'ap:' + cb }, { text: '❌ Rechazar', callback_data: 'rj:' + cb }]] } }); } catch (e) { /* si falla Telegram, el registro queda pendiente */ }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Falta conectar Upstash Redis en Vercel' });
  try {
    // Consulta de estado: solo responde si el DNI y el celular coinciden con el registro
    if (req.method === 'GET') {
      const q = req.query || {};
      const u = await lookup(S(q.dni, 8), S(q.uid, 60));
      return res.status(200).json({ status: u ? u.status : 'NO_ENCONTRADO' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const x = b.user || {}, uid = S(b.uid, 60);
    const type = x.type === 'driver' ? 'driver' : 'passenger';
    const name = S(x.name, 100).trim().replace(/\s+/g, ' ');
    const dni = S(x.dni, 8);
    const plate = type === 'driver' ? S(x.plate, 15).trim().toUpperCase() : '';
    let wa = S(x.wa, 20).replace(/\D/g, ''); if (wa.length === 11 && wa.startsWith('51')) wa = wa.slice(2);
    const waOk = /^9\d{8}$/.test(wa);
    if (!uid || !/^\d{8}$/.test(dni) || name.length < 6) return res.status(400).json({ error: 'Datos inválidos' });
    if (type === 'driver' && plate.length < 4) return res.status(400).json({ error: 'Falta la placa o guía' });

    const prev = await lookup(dni, uid);
    if (!waOk && (!prev || x.wa)) return res.status(400).json({ error: 'Falta el número de WhatsApp (9 dígitos, empieza con 9)' });
    if (prev && prev.name === name && prev.type === type && prev.plate === plate) {
      if (waOk && prev.wa !== wa) { prev.wa = wa; prev.updatedAt = Date.now(); await save(prev); if (needsApproval()) { try { await tg('sendMessage', { chat_id: CHAT, text: '📱 WhatsApp registrado — ' + prev.name + ' (DNI ' + prev.dni + ')\n+51 ' + wa + '\nhttps://wa.me/51' + wa, disable_web_page_preview: true }); } catch (e) { /* no bloquea el registro */ } } } // solo cambió el WhatsApp: no pide nueva aprobación
      return res.status(200).json({ ok: true, status: prev.status });
    }

    const u = { name, dni, wa: waOk ? wa : ((prev && prev.wa) || ''), type, plate, uid, status: needsApproval() ? 'PENDIENTE' : 'APROBADO', createdAt: prev ? prev.createdAt : Date.now(), updatedAt: Date.now() };
    await save(u);
    let note = prev ? '✏️ Este usuario cambió sus datos (antes: ' + prev.name + (prev.plate ? ' · ' + prev.plate : '') + ').' : '';
    const fields = await redis(['HKEYS', KEY]);
    if ((fields || []).some(f => f.startsWith(dni + ':') && f !== dni + ':' + uid)) note += (note ? '\n' : '') + '⚠️ Este DNI ya fue registrado desde otro celular. Revisa que sea la misma persona.';
    await notify(u, note);
    return res.status(200).json({ ok: true, status: u.status });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
