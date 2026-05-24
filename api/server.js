require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// IP rate limiter: 1 submission per IP per 24 hours
const submissions = new Map();
const ONE_DAY = 24 * 60 * 60 * 1000;

function cleanupExpired() {
  const now = Date.now();
  for (const [ip, ts] of submissions) {
    if (now - ts > ONE_DAY) submissions.delete(ip);
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
    if (submissions.has(ip)) {
      return res.status(429).json({
        success: false,
        message: 'Вы уже отправляли заявку сегодня. Попробуйте завтра.'
      });
    }

    const formData = req.body;
    const apiKey = process.env.KEYCRM_API_KEY;
    const sourceId = parseInt(process.env.KEYCRM_SOURCE_ID, 10);

    if (!apiKey || !sourceId) {
      return res.status(500).json({
        success: false,
        message: 'API ключ или ID источника не настроены'
      });
    }

    const managerComment = `Заявка с сайта TrafficPro

Telegram: ${formData.telegram || 'Не указано'}
Ниша: ${formData.niche || 'Не указано'}
Бюджет: ${formData.budget || 'Не указано'}
Опыт рекламы: ${formData.experience || 'Не указано'}`;

    const keycrmData = {
      source_id: sourceId,
      pipeline_id: 1,
      contact: {
        full_name: formData.name,
        phone: formData.telegram || '',
        email: formData.email
      },
      manager_comment: managerComment
    };

    const response = await fetch('https://openapi.keycrm.app/v1/leads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(keycrmData),
    });

    const responseData = await response.json();

    if (!response.ok) {
      const errorMessage = responseData.message
        || responseData.error
        || JSON.stringify(responseData)
        || `KeyCRM API Error (${response.status})`;

      throw new Error(errorMessage);
    }

    // Mark IP as submitted only after successful KeyCRM response
    submissions.set(ip, Date.now());

    res.status(200).json({
      success: true,
      message: 'Заявка успешно отправлена',
      data: responseData
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
    hasApiKey: !!process.env.KEYCRM_API_KEY,
    hasSourceId: !!process.env.KEYCRM_SOURCE_ID
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
