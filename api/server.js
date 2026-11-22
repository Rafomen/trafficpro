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

    const escapeHtml = (s) =>
      String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
