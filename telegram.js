// api/telegram.js — webhook del bot de Telegram: aprobar/rechazar usuarios y listarlos
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TG = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = String(process.env.TELEGRAM_CHAT_ID || '');
const SECRET = process.env.TELEGRAM_SECRET;
const KEY = 'ruedabca:users';
const ICON = { APROBADO: '✅', PENDIENTE: '⏳', RECHAZADO: '❌' };

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
async function all() {
  const flat = (await redis(['HGETALL', KEY])) || [];
  const out = [];
  for (let i = 1; i < flat.length; i += 2) { try { const u = JSON.parse(flat[i]); u._f = flat[i - 1]; out.push(u); } catch (e) {} }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
async function setStatus(field, status) {
  const raw = await redis(['HGET', KEY, field]);
  if (!raw) return null;
  const u = JSON.parse(raw); u.status = status; u.updatedAt = Date.now();
  await redis(['HSET', KEY, field, JSON.stringify(u)]);
  return u;
}
const line = (u, i) => (i + 1) + '. ' + (ICON[u.status] || '⏳') + ' ' + u.name + ' · DNI ' + u.dni + (u.wa ? ' · WhatsApp ' + u.wa : '') + ' · ' + (u.type === 'driver' ? 'Mototaxista ' + u.plate : 'Pasajero');
async function sendList(list, title) {
  if (!list.length) return tg('sendMessage', { chat_id: CHAT, text: title + ': no hay registros.' });
  let text = title + ' (' + list.length + ')\n\n';
  for (let i = 0; i < list.length; i++) {
    const l = line(list[i], i) + '\n';
    if (text.length + l.length > 3800) { await tg('sendMessage', { chat_id: CHAT, text }); text = ''; }
    text += l;
  }
  return tg('sendMessage', { chat_id: CHAT, text });
}

module.exports = async (req, res) => {
  // Diagnóstico: abre /api/telegram?info=TU_CLAVE para ver si el bot está bien conectado
  if (req.method === 'GET' && req.query && req.query.info) {
    if (!SECRET || req.query.info !== SECRET) return res.status(401).send('Clave incorrecta, o TELEGRAM_SECRET no está configurada en Vercel.');
    try {
      const w = (await tg('getWebhookInfo', {})).result || {};
      const me = (await tg('getMe', {})).result || {};
      const esperado = 'https://' + req.headers.host + '/api/telegram';
      return res.status(200).type('text/plain').send([
        'Variables en Vercel: TOKEN ' + (TG ? 'OK' : 'FALTA') + ' · CHAT_ID ' + (CHAT ? 'OK' : 'FALTA') + ' · SECRET ' + (SECRET ? 'OK' : 'FALTA'),
        'Bot: ' + (me.username ? '@' + me.username : 'token inválido'),
        'Webhook conectado a: ' + (w.url || '(ninguno: falta abrir el enlace ?setup=TU_CLAVE)'),
        'Debe ser: ' + esperado + (w.url && w.url !== esperado ? '   <-- NO COINCIDE' : ''),
        'Pendientes sin entregar: ' + (w.pending_update_count || 0),
        'Último error de Telegram: ' + (w.last_error_message || 'ninguno')
      ].join('\n'));
    } catch (e) { return res.status(500).send('Error: ' + String(e.message || e)); }
  }
  // Configuración con un clic: abre /api/telegram?setup=TU_CLAVE y conecta el bot solo (el token no sale de Vercel)
  if (req.method === 'GET' && req.query && req.query.setup) {
    if (!SECRET || !TG || !CHAT) return res.status(500).send('Faltan variables en Vercel: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID y TELEGRAM_SECRET. Agrégalas y haz Redeploy.');
    if (req.query.setup !== SECRET) return res.status(401).send('Clave incorrecta.');
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(SECRET)) return res.status(400).send('TELEGRAM_SECRET solo puede tener letras, números, _ y -. Cámbiala en Vercel, haz Redeploy y abre el enlace otra vez.');
    try {
      const r = await tg('setWebhook', { url: 'https://' + req.headers.host + '/api/telegram', secret_token: SECRET, allowed_updates: ['message', 'callback_query'] });
      if (r.ok) await tg('sendMessage', { chat_id: CHAT, text: '✅ Bot conectado con Rueda Bca. Escribe /pendientes o /usuarios para ver los registros.' });
      return res.status(200).send(r.ok ? 'Listo: bot conectado. Revisa tu Telegram, debe llegarte un mensaje de confirmación.' : 'Telegram respondió: ' + (r.description || 'error'));
    } catch (e) { return res.status(500).send('Error: ' + String(e.message || e)); }
  }
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!SECRET || req.headers['x-telegram-bot-api-secret-token'] !== SECRET) return res.status(401).send('no autorizado');
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.callback_query) {
      const q = b.callback_query;
      if (String(q.from && q.from.id) !== CHAT) { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'No autorizado' }); return res.status(200).json({ ok: true }); }
      const [act, dni, uid] = String(q.data || '').split(':');
      let u = null, msg = 'Error al guardar';
      try { u = await setStatus(dni + ':' + uid, act === 'ap' ? 'APROBADO' : 'RECHAZADO'); msg = u ? (act === 'ap' ? 'Aprobado' : 'Rechazado') : 'No se encontró el registro'; }
      catch (e) { msg = 'Error: ' + String(e.message || e).slice(0, 150); }
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: msg, show_alert: !u });
      if (u && q.message) await tg('editMessageText', { chat_id: CHAT, message_id: q.message.message_id, text: (q.message.text || '') + '\n\n' + (act === 'ap' ? '✅ APROBADO' : '❌ RECHAZADO') });
    } else if (b.message && String(b.message.chat && b.message.chat.id) === CHAT) {
      const t = String(b.message.text || '').trim(), [cmd, arg] = t.split(/\s+/);
      if (cmd === '/usuarios') await sendList(await all(), 'Usuarios registrados');
      else if (cmd === '/pendientes') await sendList((await all()).filter(u => u.status === 'PENDIENTE'), 'Pendientes de aprobación');
      else if ((cmd === '/aprobar' || cmd === '/rechazar') && /^\d{8}$/.test(arg || '')) {
        const ms = (await all()).filter(u => u.dni === arg);
        for (const u of ms) await setStatus(u._f, cmd === '/aprobar' ? 'APROBADO' : 'RECHAZADO');
        await tg('sendMessage', { chat_id: CHAT, text: ms.length ? (cmd === '/aprobar' ? '✅ Aprobado: ' : '❌ Rechazado: ') + ms[0].name + ' (DNI ' + arg + ')' : 'No encontré ese DNI.' });
      } else await tg('sendMessage', { chat_id: CHAT, text: 'Comandos:\n/pendientes — registros por aprobar\n/usuarios — todos los registrados\n/aprobar 12345678 — aprobar un DNI\n/rechazar 12345678 — rechazar o bloquear un DNI' });
    }
  } catch (e) { /* respondemos 200 para que Telegram no reintente en bucle */ }
  return res.status(200).json({ ok: true });
};
