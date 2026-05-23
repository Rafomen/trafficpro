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

app.post('/api/submit', async (req, res) => {
  try {
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

Ниша: ${formData.niche || 'Не указано'}
Бюджет: ${formData.budget || 'Не указано'}
Опыт рекламы: ${formData.experience || 'Не указано'}`;

    const keycrmData = {
      source_id: sourceId,
      pipeline_id: 1,
      contact: {
        full_name: formData.name,
        phone: formData.telegram,
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
