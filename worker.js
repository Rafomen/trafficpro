// Cloudflare Worker для trafficpro.net
// Раздаёт статику (index.html и др.) + принимает заявки с формы и шлёт их в Telegram.

const REQUIRED_FIELDS = ['name', 'telegram', 'email', 'niche', 'budget', 'experience'];

// Best-effort rate limit: 1 заявка с IP в сутки (живёт в рамках одного изолята воркера)
const submissions = new Map();
const ONE_DAY = 24 * 60 * 60 * 1000;

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
    if (now - ts > ONE_DAY) submissions.delete(ip);
  }
  const ip = getClientIp(request);
  if (submissions.has(ip)) {
    return jsonResponse({ success: false, message: 'Вы уже отправляли заявку сегодня. Попробуйте завтра.' }, 429);
  }

  const message =
    `🔔 <b>Новая заявка с сайта TrafficPro</b>\n\n` +
    `👤 Имя: ${escapeHtml(data.name)}\n` +
    `✈️ Telegram: ${escapeHtml(data.telegram)}\n` +
    `📧 Email: ${escapeHtml(data.email)}\n` +
    `💼 Ниша: ${escapeHtml(data.niche)}\n` +
    `💰 Бюджет: ${escapeHtml(data.budget)}\n` +
    `📊 Опыт рекламы: ${escapeHtml(data.experience)}`;

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

    if (url.pathname === '/api/submit' && request.method === 'POST') {
      return handleSubmit(request, env);
    }

    // Статика: index.html, privacy.html, thank-you.html и ассеты
    return env.ASSETS.fetch(request);
  }
};
