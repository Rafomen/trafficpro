// Cloudflare Worker для trafficpro.net
// Раздаёт статику (index.html и др.) + принимает заявки с формы и шлёт их в Telegram.

const REQUIRED_FIELDS = ['name', 'telegram', 'email'];

// Rate limit: 1 заявка с IP в 10 минут
const submissions = new Map();
const RATE_WINDOW = 10 * 60 * 1000;

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleSubmit(request, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return jsonResponse({ success: false, message: 'Telegram не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)' }, 500);
  }

  let data;
  try {
    data = await request.json();
  } catch (_) {
    return jsonResponse({ success: false, message: 'Некорректный запрос' }, 400);
  }

  for (const field of REQUIRED_FIELDS) {
    if (!data[field]) {
      return jsonResponse({ success: false, message: 'Пожалуйста, заполните все поля' }, 400);
    }
  }

  // Rate limit
  const now = Date.now();
  for (const [ip, ts] of submissions) {
    if (now - ts > RATE_WINDOW) submissions.delete(ip);
  }
  const ip = getClientIp(request);
  const lastTs = submissions.get(ip);
  if (lastTs) {
    const minutesLeft = Math.max(1, Math.ceil((RATE_WINDOW - (now - lastTs)) / 60000));
    return jsonResponse({
      success: false,
      message: `Заявка с этого IP уже отправлена. Повторите через ${minutesLeft} мин. Или напишите нам напрямую в Telegram: t.me/metagoogle_ads`
    }, 429);
  }

  const message =
    `🔔 <b>Новая заявка с сайта TrafficPro</b>\n\n` +
    `👤 Имя: ${escapeHtml(data.name)}\n` +
    `✈️ Telegram: ${escapeHtml(data.telegram)}\n` +
    `📧 Email: ${escapeHtml(data.email)}`;

  try {
    const tgResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    const tgData = await tgResponse.json();

    if (!tgResponse.ok || !tgData.ok) {
      throw new Error(`Telegram API Error: ${tgData.description || tgResponse.status}`);
    }
  } catch (error) {
    console.error('Server error:', error);
    return jsonResponse({ success: false, message: error.message || 'Внутренняя ошибка сервера' }, 500);
  }

  submissions.set(ip, now);
  return jsonResponse({ success: true, message: 'Заявка успешно отправлена' });
}

// ---------- Visitor notifications (Telegram) ----------
// Одно уведомление на IP за 30 минут; пауки и сканеры отфильтровываются.
const VISIT_WINDOW = 30 * 60 * 1000;
const visitorSeen = new Map();

const BOT_UA_RE = /bot|crawl|spider|slurp|curl|wget|python|java\/|httpclient|http-client|headless|lighthouse|monitor|uptime|pingdom|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|facebookexternalhit|twitterbot|linkedinbot|telegrambot|whatsapp|preview|metatag|go-http|okhttp|axios|node-fetch|postman|insomnia|archive|validator|scanner|fuzz|nmap|masscan|zgrab/i;
const REAL_BROWSER_RE = /mozilla|chrome|safari|firefox|edg|opera|gecko/i;

function isSpider(request) {
  if (request.method !== 'GET') return true;
  const ua = request.headers.get('user-agent') || '';
  if (!ua) return true;                       // скрипты часто шлют пустой UA
  if (!REAL_BROWSER_RE.test(ua)) return true; // нет признаков браузера
  if (BOT_UA_RE.test(ua)) return true;
  return false;
}

function isTrackablePath(p) {
  if (p.startsWith('/api/')) return false;
  if (p.startsWith('/favicon')) return false;
  return p === '/' || p.endsWith('.html');
}

function fmtTime() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Brussels',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

async function notifyVisit(request, env, ip) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  // Гео из объекта request.cf (Cloudflare отдаёт его бесплатно на каждом запросе)
  const cf = request.cf || {};
  let loc = '📍 Гео не определено';
  try {
    const names = new Intl.DisplayNames(['ru'], { type: 'region' });
    const all = [cf.city, cf.region, cf.country ? names.of(cf.country) : null].filter(Boolean);
    if (all.length) loc = `📍 ${all.join(', ')}`;
  } catch (e) {
    if (cf.country) loc = `📍 ${[cf.city, cf.region, cf.country].filter(Boolean).join(', ')}`;
  }

  // Провайдер + флаги прокси/датацентра (не критично, если не ответит)
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,isp,proxy,hosting&lang=ru`);
    const d = await r.json();
    if (d && d.status === 'success') {
      if (d.isp) loc += `\n🏢 ${d.isp}`;
      const flags = [];
      if (d.proxy) flags.push('прокси/VPN');
      if (d.hosting) flags.push('дата-центр (бот/сервер)');
      if (flags.length) loc += `\n⚠️ ${flags.join(', ')}`;
    }
  } catch (e) { /* необязательно */ }

  const ua = request.headers.get('user-agent') || '';
  const path = new URL(request.url).pathname;
  const message =
    `👣 <b>Заход на сайт</b>\n` +
    `🕐 ${fmtTime()} (ЦЕТ)\n` +
    `🌐 <code>${escapeHtml(ip)}</code>\n` +
    `${loc}\n` +
    `📄 ${escapeHtml(path)}\n` +
    `💻 <code>${escapeHtml(ua.slice(0, 120))}</code>`;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  });
}

function trackVisit(request, env, ctx) {
  try {
    const path = new URL(request.url).pathname;
    if (!isTrackablePath(path)) return;
    if (isSpider(request)) return;

    const ip = getClientIp(request);
    if (ip === 'unknown') return;
    const now = Date.now();
    const last = visitorSeen.get(ip);
    if (last && now - last < VISIT_WINDOW) return;

    visitorSeen.set(ip, now);
    for (const [k, ts] of visitorSeen) {
      if (now - ts > VISIT_WINDOW) visitorSeen.delete(k);
    }

    console.log('visit tracked:', ip, path);
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(notifyVisit(request, env, ip).catch(() => {}));
    }
  } catch (e) { /* трекер не должен ломать сайт */ }
}
// ---------- конец visitor notifications ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    trackVisit(request, env, ctx);

    if (url.pathname === '/api/health') {
      return jsonResponse({
        status: 'OK',
        telegramConfigured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
      });
    }

    if (url.pathname === '/api/geo') {
      return jsonResponse({ country: (request.cf && request.cf.country) || null });
    }

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      return handleSubmit(request, env);
    }

    // Статика: index.html, privacy.html, thank-you.html и ассеты
    return env.ASSETS.fetch(request);
  }
};
