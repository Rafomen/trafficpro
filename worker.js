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

// Страны, для которых слать уведомления о заходах (гео рекламных кампаний).
// Всё остальное — боты/прокси/нерелевантный трафик — молча игнорируем.
const NOTIFY_COUNTRIES = new Set(['UA']);

function isSpider(request) {
  if (request.method !== 'GET') return true;
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/html')) return true; // браузер за страницей всегда просит text/html
  const ua = request.headers.get('user-agent') || '';
  if (!ua) return true;                       // скрипты часто шлют пустой UA
  if (!REAL_BROWSER_RE.test(ua)) return true; // нет признаков браузера
  if (BOT_UA_RE.test(ua)) return true;
  // настоящий браузер всегда шлёт Accept-Language — скрипты почти никогда
  if (!request.headers.get('accept-language')) return true;
  // Chrome/Edge/Firefox всегда шлют Sec-Fetch-*: если UA заявляет современный
  // браузер, а заголовков нет — UA подделан (headless-скрипты, кликер-боты).
  // Safari Sec-Fetch не шлёт, поэтому проверяем только Chromium/Firefox.
  if (/chrome|edg\//i.test(ua) && !request.headers.has('sec-fetch-mode')) return true;
  if (/firefox/i.test(ua) && !request.headers.has('sec-fetch-mode')) return true;
  return false;
}

function isTrackablePath(p) {
  if (p.startsWith('/api/')) return false;
  if (p.startsWith('/favicon')) return false;
  return p === '/' || p.endsWith('.html');
}

// ASN известных дата-центров/облаков — Cloudflare отдаёт бесплатно в request.cf
const DC_ASNS = new Set([
  16509, 14618, // Amazon AWS
  15169, 396982, // Google / GCP
  8075,         // Microsoft Azure
  14061,        // DigitalOcean
  24940,        // Hetzner
  16276,        // OVH
  63949,        // Linode / Akamai
  20473,        // Vultr
  31898,        // Oracle Cloud
  45102, 37963, // Alibaba Cloud
  9009, 208283, // M247 / GCore (популярные VPN-серверы)
  49505,        // Selectel
  51106,        // FirstDEDIC
  44050,        // Peter-Host
]);
// Ключевые слова в имени организации (asOrganization) — страховка к списку ASN
const DC_ORG_RE = /amazon|aws|azure|microsoft|google|digitalocean|hetzner|ovh|linode|vultr|oracle|alibaba|contabo|leaseweb|hostinger|gcore|selectel|timeweb|cloudflare|hosting|host|хостинг|data\s?cent|дата[- ]?цент|сервер|server|vps|vds|dedicated|colocation|колокейшн/i;

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
  const asn = cf.asn;
  const org = String(cf.asOrganization || '');

  // Страна не из гео рекламных кампаний = нерелевантный трафик (боты/прокси,
  // кликфрод). Скипаем молча ещё до запросов к ip-api.
  const country = String(cf.country || '');
  if (country && !NOTIFY_COUNTRIES.has(country)) {
    console.log('skip visit notify (outside ad geo):', ip, country);
    return;
  }

  // Дата-центр/облако по ASN или имени организации = бот или сервер, не живой человек.
  // Бесплатно и без внешних запросов — отсекаем до ip-api.
  if ((asn && DC_ASNS.has(asn)) || DC_ORG_RE.test(org)) {
    console.log('skip visit notify (datacenter asn/org):', ip, asn, org);
    return;
  }
  let loc = '📍 Гео не определено';
  try {
    const names = new Intl.DisplayNames(['ru'], { type: 'region' });
    const all = [cf.city, cf.region, cf.country ? names.of(cf.country) : null].filter(Boolean);
    if (all.length) loc = `📍 ${all.join(', ')}`;
  } catch (e) {
    if (cf.country) loc = `📍 ${[cf.city, cf.region, cf.country].filter(Boolean).join(', ')}`;
  }

  // Провайдер + флаги прокси/датацентра. Fail-closed: если ip-api не ответил
  // (rate limit 45/мин на общих egress-IP воркеров, ошибка, timeout) — молчим,
  // чтобы в Telegram не проскакивали "заходы без инфы" (это боты с подделанным UA).
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,isp,proxy,hosting&lang=ru`, {
      signal: AbortSignal.timeout(4000)
    });
    const d = await r.json();
    if (!d || d.status !== 'success') {
      console.log('skip visit notify (ip-api fail):', ip);
      return;
    }
    // Дата-центр / прокси / VPN = бот или сервер, не живой человек — не шлём
    if (d.proxy || d.hosting) {
      console.log('skip visit notify (datacenter/proxy):', ip);
      return;
    }
    if (d.isp) loc += `\n🏢 ${d.isp}`;
  } catch (e) {
    console.log('skip visit notify (ip-api error):', ip, e && e.message);
    return;
  }

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
