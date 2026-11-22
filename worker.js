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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
