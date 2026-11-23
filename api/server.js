require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- Visitor notifications (Telegram) ----------
const VISIT_WINDOW = 30 * 60 * 1000; // одно уведомление на IP за 30 минут
const visitorSeen = new Map();

const escapeHtml = (s) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BOT_UA_RE = /bot|crawl|spider|slurp|curl|wget|python|java\/|httpclient|http-client|headless|lighthouse|monitor|uptime|pingdom|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|facebookexternalhit|twitterbot|linkedinbot|telegrambot|whatsapp|preview|metatag|go-http|okhttp|axios|node-fetch|postman|insomnia|archive|validator|scanner|fuzz|nmap|masscan|zgrab/i;
const REAL_BROWSER_RE = /mozilla|chrome|safari|firefox|edg|opera|gecko/i;

function isSpider(req) {
  if (req.method !== 'GET') return true;
  const ua = req.headers['user-agent'] || '';
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

app.use((req, res, next) => {
  try {
    if (!isTrackablePath(req.path)) return next();
    if (isSpider(req)) return next();

    const ip = getClientIp(req);
    const now = Date.now();
    const last = visitorSeen.get(ip);
    if (last && now - last < VISIT_WINDOW) return next();

    visitorSeen.set(ip, now);
    for (const [k, ts] of visitorSeen) {
      if (now - ts > VISIT_WINDOW) visitorSeen.delete(k);
    }

    notifyVisit(req, ip).catch((e) => console.error('notifyVisit error:', e.message));
  } catch (e) {
    console.error('visit tracker error:', e.message);
  }
  next();
});

function fmtTime() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

async function notifyVisit(req, ip) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  let ipClean = String(ip || '').replace(/^::ffff:/, '');
  const isPrivate = !ipClean || ipClean === '::1' || ipClean.startsWith('127.') ||
    ipClean.startsWith('10.') || ipClean.startsWith('192.168.') || ipClean.startsWith('172.');

  let geo = null;
  if (!isPrivate) {
    try {
      const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ipClean)}?fields=status,country,regionName,city,isp,proxy,hosting&lang=ru`);
      const d = await r.json();
      if (d && d.status === 'success') geo = d;
    } catch (e) { /* гео не критично, уведомление всё равно уйдёт */ }
  }

  let loc = '📍 Гео не определено';
  if (geo) {
    const parts = [geo.city, geo.regionName, geo.country].filter(Boolean);
    loc = `📍 ${parts.join(', ') || 'неизвестно'}`;
    if (geo.isp) loc += `\n🏢 ${geo.isp}`;
    const flags = [];
    if (geo.proxy) flags.push('прокси/VPN');
    if (geo.hosting) flags.push('дата-центр (бот/сервер)');
    if (flags.length) loc += `\n⚠️ ${flags.join(', ')}`;
  }

  const ua = req.headers['user-agent'] || '';
  const message =
    `👣 <b>Заход на сайт</b>\n` +
    `🕐 ${fmtTime()} (МСК)\n` +
    `🌐 <code>${escapeHtml(ipClean)}</code>\n` +
    `${loc}\n` +
    `📄 ${escapeHtml(req.path)}\n` +
    `💻 <code>${escapeHtml(ua.slice(0, 120))}</code>`;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  });
}
// ---------- конец visitor notifications ----------

app.use(express.static(path.join(__dirname, '..')));

// IP rate limiter: 1 submission per IP per 10 minutes
const submissions = new Map();
const RATE_WINDOW = 10 * 60 * 1000;

function cleanupExpired() {
  const now = Date.now();
  for (const [ip, ts] of submissions) {
    if (now - ts > RATE_WINDOW) submissions.delete(ip);
  }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.connection.remoteAddress;
}

app.post('/api/submit', async (req, res) => {
  try {
    // Rate limit check
    cleanupExpired();
    const ip = getClientIp(req);
    const lastTs = submissions.get(ip);
    if (lastTs) {
      const minutesLeft = Math.max(1, Math.ceil((RATE_WINDOW - (Date.now() - lastTs)) / 60000));
      return res.status(429).json({
        success: false,
        message: `Заявка с этого IP уже отправлена. Повторите через ${minutesLeft} мин. Или напишите нам напрямую в Telegram: t.me/metagoogle_ads`
      });
    }

    const formData = req.body;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(500).json({
        success: false,
        message: 'Telegram не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)'
      });
    }

    const message =
      `🔔 <b>Новая заявка с сайта TrafficPro</b>\n\n` +
      `👤 Имя: ${escapeHtml(formData.name) || 'Не указано'}\n` +
      `✈️ Telegram: ${escapeHtml(formData.telegram) || 'Не указано'}\n` +
      `📧 Email: ${escapeHtml(formData.email) || 'Не указано'}`;

    const tgResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });

    const tgData = await tgResponse.json();

    if (!tgResponse.ok || !tgData.ok) {
      throw new Error(`Telegram API Error: ${tgData.description || tgResponse.status}`);
    }

    // Mark IP as submitted only after successful KeyCRM response
    submissions.set(ip, Date.now());

    res.status(200).json({
      success: true,
      message: 'Заявка успешно отправлена'
    });

  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Внутренняя ошибка сервера'
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
