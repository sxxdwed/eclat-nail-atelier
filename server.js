const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4173);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CLIENT_BOT_TOKEN = process.env.CLIENT_BOT_TOKEN || '';
const OWNER_CHAT_ID = String(process.env.OWNER_CHAT_ID || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (process.env.NODE_ENV === 'production') {
  if (!BOT_TOKEN || !OWNER_CHAT_ID) throw new Error('Production requires BOT_TOKEN and OWNER_CHAT_ID.');
  if (ADMIN_PASSWORD.length < 16) throw new Error('Production ADMIN_PASSWORD must contain at least 16 characters.');
}
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'booking-data.json');
const SEED_FILE = path.join(ROOT, 'seed-data.json');
const SLOT_TIMES = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30'];
const SERVICES = ['Маникюр без покрытия', 'Маникюр + гель-лак', 'Укрепление и покрытие', 'SPA-уход для рук'];
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'script.js', 'miniapp.html', 'miniapp.css', 'miniapp.js']);
const MAX_BODY_BYTES = 100000;
const rateBuckets = new Map();
let clientBotUsername = '';

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  const seed = fs.existsSync(SEED_FILE)
    ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'))
    : { overrides: {}, admins: [], reviewDrafts: {}, reviews: [], bookings: [] };
  fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
}

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data.overrides ||= {}; data.admins ||= []; data.bookings ||= []; data.reviews ||= []; data.reviewDrafts ||= {};
    return data;
  }
  catch { return { overrides: {}, admins: [], bookings: [], reviews: [], reviewDrafts: {} }; }
}

function isAdmin(chatId) {
  const id = String(chatId);
  const data = loadData();
  return id === OWNER_CHAT_ID || (data.admins || []).includes(id);
}

const awaitingPassword = new Set();
const botLoginAttempts = new Map();

function safeEqualText(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function isWorkday(date) {
  if (!isValidDate(date)) return false;
  const [year, month, dayOfMonth] = date.split('-').map(Number);
  const day = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
  return day >= 1 && day <= 5;
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function studioNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function slotsFor(date) {
  if (!isValidDate(date) || !isWorkday(date) || date < studioNowParts().date) return [];
  const data = loadData();
  return SLOT_TIMES.map((time) => {
    const key = `${date}_${time}`;
    const booking = data.bookings.find((item) => item.date === date && item.time === time && ['pending', 'confirmed'].includes(item.status));
    return { time, available: data.overrides[key] !== false && !booking, status: booking?.status || (data.overrides[key] === false ? 'closed' : 'free') };
  });
}

function nextAvailableSlot() {
  const studioNow = studioNowParts();
  const [year, month, day] = studioNow.date.split('-').map(Number);
  for (let offset = 0; offset < 60; offset += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day + offset));
    const date = candidate.toISOString().slice(0, 10);
    const slot = slotsFor(date).find((item) => item.available && (date !== studioNow.date || item.time > studioNow.time));
    if (slot) return { date, time: slot.time };
  }
  return null;
}

function json(res, status, body) {
  res.writeHead(status, { ...securityHeaders(true), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function securityHeaders(api = false) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
  if (!api) headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
  return headers;
}

function rateLimited(req, scope, limit, windowMs) {
  const key = `${scope}:${req.socket.remoteAddress || 'unknown'}`;
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) { rateBuckets.set(key, { count: 1, resetAt: now + windowMs }); return false; }
  current.count += 1;
  return current.count > limit;
}

function pruneRateBuckets() {
  const now = Date.now();
  for (const [key, value] of rateBuckets) {
    if (value.resetAt <= now) rateBuckets.delete(key);
  }
  while (rateBuckets.size > 10000) rateBuckets.delete(rateBuckets.keys().next().value);
}

function validBookingInput(input) {
  return typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.trim().length <= 80
    && typeof input.phone === 'string' && /^[+\d][\d\s()\-]{8,24}$/.test(input.phone.trim())
    && SERVICES.includes(input.service)
    && /^\d{4}-\d{2}-\d{2}$/.test(input.date)
    && SLOT_TIMES.includes(input.time);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      req.resume();
      reject(new Error('too large'));
      return;
    }
    let body = '';
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        body = '';
        reject(new Error('too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid json')); }
    });
  });
}

async function telegram(method, payload) {
  if (!BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return response.json();
}

async function clientTelegram(method, payload) {
  if (!CLIENT_BOT_TOKEN) return null;
  const response = await fetch(`https://api.telegram.org/bot${CLIENT_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return response.json();
}

function miniUser(req) {
  if (!BOT_TOKEN) return null;
  const rawHeader = String(req.headers['x-telegram-init-data'] || '');
  let raw;
  try { raw = decodeURIComponent(rawHeader); } catch { return null; }
  const params = new URLSearchParams(raw);
  const receivedHash = params.get('hash');
  if (!receivedHash) return null;
  params.delete('hash');
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  const checkString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(receivedHash, 'hex');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

function requireMiniUser(req, res) {
  const user = miniUser(req);
  if (!user) json(res, 401, { error: 'Откройте приложение через Telegram.' });
  return user;
}

async function changeBookingStatus(item, status) {
  item.status = status;
  item.updatedAt = new Date().toISOString();
  if (item.clientChatId) {
    const text = status === 'confirmed'
      ? `✅ Ваша запись подтверждена!\n\n${item.service}\n📅 ${item.date}\n🕒 ${item.time}\n\nЖдём вас в студии Éclat.`
      : `❌ Заявка на ${item.date} в ${item.time} отклонена. Выберите другое время в приложении.`;
    await clientTelegram('sendMessage', { chat_id: item.clientChatId, text });
  }
}

async function notifyOwner(booking) {
  if (!BOT_TOKEN || !OWNER_CHAT_ID) return;
  const text = `Новая заявка #${booking.id}\n\n${booking.name}\n${booking.phone}\n${booking.service}\n${booking.date} в ${booking.time}`;
  await telegram('sendMessage', {
    chat_id: OWNER_CHAT_ID, text,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Подтвердить', callback_data: `confirm:${booking.id}` },
      { text: '❌ Отклонить', callback_data: `reject:${booking.id}` }
    ]] }
  });
}

async function sendReviewRequest(booking) {
  if (!CLIENT_BOT_TOKEN || !booking.clientChatId) return false;
  const buttons = [1, 2, 3, 4, 5].map((rating) => ({ text: `${rating} ★`, callback_data: `reviewrate:${booking.id}:${rating}` }));
  await clientTelegram('sendMessage', {
    chat_id: booking.clientChatId,
    text: `Спасибо, что выбрали Éclat 🌸\n\nКак вам результат? Выберите оценку от 1 до 5, а затем напишите несколько слов о визите.`,
    reply_markup: { inline_keyboard: [buttons] }
  });
  booking.reviewRequestedAt = new Date().toISOString();
  return true;
}

async function notifyOwnerAboutReview(review) {
  if (!OWNER_CHAT_ID) return;
  await telegram('sendMessage', {
    chat_id: OWNER_CHAT_ID,
    text: `Новый отзыв на модерации\n\n${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}\n${review.name}\n\n${review.text}`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Опубликовать', callback_data: `reviewpublish:${review.id}` },
      { text: '❌ Отклонить', callback_data: `reviewreject:${review.id}` }
    ]] }
  });
}

function bookingText(item) {
  const labels = { pending: '⏳', confirmed: '✅', rejected: '❌' };
  return `${labels[item.status] || ''} #${item.id} ${item.date} ${item.time}\n${item.name}, ${item.phone}\n${item.service}`;
}

async function handleCallback(query, source = 'owner') {
  const [action, value, extra] = String(query.data || '').split(':');
  const data = loadData();

  if (action === 'reviewrate') {
    if (source !== 'client') return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Отзывы доступны в клиентском боте.', show_alert: true });
    const booking = data.bookings.find((item) => item.id === value && String(item.clientChatId) === String(query.from.id));
    const rating = Number(extra);
    if (!booking || rating < 1 || rating > 5) return clientTelegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Запись не найдена', show_alert: true });
    data.reviewDrafts[String(query.from.id)] = { bookingId: booking.id, rating };
    saveData(data);
    await clientTelegram('answerCallbackQuery', { callback_query_id: query.id, text: `Оценка: ${rating} из 5` });
    return clientTelegram('sendMessage', { chat_id: query.from.id, text: 'Теперь напишите текст отзыва одним сообщением. После этого он отправится мастеру на модерацию.' });
  }

  if (source === 'client') return clientTelegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Эта команда недоступна.', show_alert: true });

  if (!isAdmin(query.from.id)) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Доступ разрешён только администратору', show_alert: true });

  if (action === 'reviewpublish' || action === 'reviewreject') {
    const review = data.reviews.find((item) => item.id === value);
    if (!review) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Отзыв не найден' });
    review.status = action === 'reviewpublish' ? 'published' : 'rejected';
    review.moderatedAt = new Date().toISOString();
    saveData(data);
    await telegram('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `${action === 'reviewpublish' ? '✅ Опубликован' : '❌ Отклонён'}\n\n${'★'.repeat(review.rating)}\n${review.name}\n\n${review.text}` });
    if (review.clientChatId) await clientTelegram('sendMessage', { chat_id: review.clientChatId, text: action === 'reviewpublish' ? 'Спасибо! Ваш отзыв опубликован на сайте Éclat 🌸' : 'Спасибо за обратную связь. Отзыв передан команде Éclat.' });
    return telegram('answerCallbackQuery', { callback_query_id: query.id, text: action === 'reviewpublish' ? 'Отзыв опубликован' : 'Отзыв отклонён' });
  }

  if (action === 'complete') {
    const booking = data.bookings.find((item) => item.id === value);
    if (!booking) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Запись не найдена' });
    booking.status = 'completed'; booking.completedAt = new Date().toISOString();
    const sent = await sendReviewRequest(booking); saveData(data);
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: sent ? 'Запрос отзыва отправлен' : 'Клиент не подключил Telegram', show_alert: !sent });
    return telegram('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `${bookingText(booking)}\n\nЗапись завершена${sent ? ', запрос отзыва отправлен.' : '. Telegram клиента не подключён.'}` });
  }

  if (action === 'confirm' || action === 'reject') {
    const item = data.bookings.find((booking) => booking.id === value);
    if (!item) return telegram('answerCallbackQuery', { callback_query_id: query.id, text: 'Заявка не найдена' });
    item.status = action === 'confirm' ? 'confirmed' : 'rejected';
    item.updatedAt = new Date().toISOString();
    saveData(data);
    await telegram('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id, text: bookingText(item) });
    if (item.clientChatId) {
      const clientText = action === 'confirm'
        ? `✅ Ваша запись подтверждена!\n\n${item.service}\n📅 ${item.date}\n🕒 ${item.time}\n\nЖдём вас в студии Éclat.`
        : `❌ К сожалению, заявка на ${item.date} в ${item.time} отклонена.\n\nПожалуйста, выберите другое свободное время на сайте.`;
      await clientTelegram('sendMessage', { chat_id: item.clientChatId, text: clientText });
    }
    if (action === 'confirm') await telegram('sendMessage', { chat_id: query.message.chat.id, text: `Когда визит завершится, запросите отзыв у клиента:`, reply_markup: { inline_keyboard: [[{ text: '✨ Завершить и запросить отзыв', callback_data: `complete:${item.id}` }]] } });
    return telegram('answerCallbackQuery', { callback_query_id: query.id, text: action === 'confirm' ? 'Запись подтверждена' : 'Заявка отклонена' });
  }

  if (action === 'slot') {
    const [date, timeCode] = value.split('|');
    const time = timeCode.replace('-', ':');
    const key = `${date}_${time}`;
    data.overrides[key] = data.overrides[key] === false;
    saveData(data);
    await telegram('answerCallbackQuery', { callback_query_id: query.id, text: data.overrides[key] === false ? 'Время закрыто' : 'Время открыто' });
    return sendSlots(query.message.chat.id, date, query.message.message_id);
  }
}

async function sendSlots(chatId, date, editMessageId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return telegram('sendMessage', { chat_id: chatId, text: 'Формат: /slots ГГГГ-ММ-ДД' });
  const slots = slotsFor(date);
  const keyboard = SLOT_TIMES.map((time) => {
    const slot = slots.find((item) => item.time === time);
    const icon = !slot ? '—' : slot.status === 'free' ? '🟢' : slot.status === 'closed' ? '⚫' : slot.status === 'confirmed' ? '✅' : '⏳';
    return [{ text: `${icon} ${time}`, callback_data: `slot:${date}|${time.replace(':', '-')}` }];
  });
  const payload = { chat_id: chatId, text: `Слоты на ${date}\n🟢 свободно · ⚫ закрыто · ⏳ заявка · ✅ подтверждено`, reply_markup: { inline_keyboard: keyboard } };
  if (editMessageId) return telegram('editMessageText', { ...payload, message_id: editMessageId });
  return telegram('sendMessage', payload);
}

async function processClientUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query, 'client');
  const message = update.message;
  if (!message) return;
  const text = String(message.text || '').trim();
  const [command, arg] = text.split(/\s+/);
  const chatId = String(message.chat.id);

  if (command === '/start' && arg?.startsWith('booking_')) {
    const [bookingIdRaw, linkToken = ''] = arg.slice('booking_'.length).split('_');
    const bookingId = bookingIdRaw.toUpperCase();
    const data = loadData();
    const booking = data.bookings.find((item) => item.id === bookingId);
    if (!booking || !booking.clientLinkToken || !safeEqualText(linkToken, booking.clientLinkToken)) return clientTelegram('sendMessage', { chat_id: chatId, text: 'Ссылка заявки недействительна. Оформите запись на сайте заново.' });
    booking.clientChatId = chatId;
    booking.updatedAt = new Date().toISOString();
    saveData(data);
    const state = booking.status === 'confirmed' ? 'уже подтверждена ✅' : booking.status === 'rejected' ? 'отклонена ❌' : 'ожидает подтверждения мастера ⏳';
    return clientTelegram('sendMessage', { chat_id: chatId, text: `Заявка #${booking.id} подключена к уведомлениям Éclat.\n\n${booking.service}\n📅 ${booking.date}\n🕒 ${booking.time}\n\nСейчас она ${state}. Сюда придут решение мастера и напоминание за 24 часа.` });
  }

  if (command === '/start' && arg === 'review') {
    const data = loadData();
    const booking = [...data.bookings].reverse().find((item) => String(item.clientChatId) === chatId && item.status === 'completed' && !data.reviews.some((review) => review.bookingId === item.id));
    if (!booking) return clientTelegram('sendMessage', { chat_id: chatId, text: 'Не нашли завершённую запись, доступную для отзыва. Сначала подключите уведомления по ссылке после записи на сайте.' });
    await sendReviewRequest(booking); saveData(data); return;
  }

  const reviewDraft = loadData().reviewDrafts[chatId];
  if (reviewDraft && !text.startsWith('/')) {
    if (text.length < 10) return clientTelegram('sendMessage', { chat_id: chatId, text: 'Расскажите чуть подробнее — минимум 10 символов.' });
    if (text.length > 1200) return clientTelegram('sendMessage', { chat_id: chatId, text: 'Отзыв слишком длинный. Пожалуйста, уложитесь в 1200 символов.' });
    const data = loadData();
    const draft = data.reviewDrafts[chatId];
    const booking = data.bookings.find((item) => item.id === draft.bookingId);
    if (!booking) { delete data.reviewDrafts[chatId]; saveData(data); return clientTelegram('sendMessage', { chat_id: chatId, text: 'Запись не найдена.' }); }
    const review = { id: `REV${crypto.randomBytes(8).toString('hex').toUpperCase()}`, bookingId: booking.id, clientChatId: chatId, name: booking.name, rating: draft.rating, date: new Date().toISOString().slice(0, 10), text, status: 'pending', createdAt: new Date().toISOString() };
    data.reviews.push(review); delete data.reviewDrafts[chatId]; saveData(data);
    await clientTelegram('sendMessage', { chat_id: chatId, text: 'Спасибо за отзыв! Он отправлен мастеру на модерацию 🌸' });
    return notifyOwnerAboutReview(review);
  }

  return clientTelegram('sendMessage', { chat_id: chatId, text: 'Добро пожаловать в клиентский бот Éclat 🌸\n\nПосле записи на сайте нажмите кнопку подключения Telegram — здесь появятся подтверждение мастера, напоминание за 24 часа и возможность оставить отзыв.' });
}

async function processUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query, 'owner');
  const message = update.message;
  if (!message) return;
  const text = String(message.text || '').trim();
  const [command, arg] = text.split(/\s+/);
  const chatId = String(message.chat.id);

  if (command === '/start' && (arg?.startsWith('booking_') || arg === 'review')) {
    return telegram('sendMessage', { chat_id: chatId, text: 'Клиентские уведомления и отзывы теперь находятся в отдельном боте. Используйте кнопку на сайте.' });
  }

  if (command === '/start' && arg?.startsWith('booking_')) {
    const bookingId = arg.slice('booking_'.length).toUpperCase();
    const data = loadData();
    const booking = data.bookings.find((item) => item.id === bookingId);
    if (!booking) return telegram('sendMessage', { chat_id: chatId, text: 'Заявка не найдена. Проверьте ссылку или оформите запись заново.' });
    booking.clientChatId = chatId;
    booking.updatedAt = new Date().toISOString();
    saveData(data);
    const state = booking.status === 'confirmed' ? 'уже подтверждена ✅' : booking.status === 'rejected' ? 'отклонена ❌' : 'ожидает подтверждения администратора ⏳';
    return telegram('sendMessage', { chat_id: chatId, text: `Заявка #${booking.id} привязана к Telegram.\n\n${booking.service}\n📅 ${booking.date}\n🕒 ${booking.time}\n\nСейчас она ${state}. Мы пришлём сюда уведомление при изменении статуса.` });
  }

  if (command === '/start' && arg === 'review') {
    const data = loadData();
    const booking = [...data.bookings].reverse().find((item) => String(item.clientChatId) === chatId && item.status === 'completed' && !data.reviews.some((review) => review.bookingId === item.id));
    if (!booking) return telegram('sendMessage', { chat_id: chatId, text: 'Не нашли завершённую запись, доступную для отзыва. Если вы записывались через сайт, сначала подключите Telegram по ссылке из заявки.' });
    await sendReviewRequest(booking); saveData(data); return;
  }

  const reviewDraft = null;
  if (reviewDraft && !text.startsWith('/')) {
    if (text.length < 10) return telegram('sendMessage', { chat_id: chatId, text: 'Расскажите чуть подробнее — минимум 10 символов.' });
    if (text.length > 1200) return telegram('sendMessage', { chat_id: chatId, text: 'Отзыв слишком длинный. Пожалуйста, уложитесь в 1200 символов.' });
    const data = loadData();
    const draft = data.reviewDrafts[chatId];
    const booking = data.bookings.find((item) => item.id === draft.bookingId);
    if (!booking) { delete data.reviewDrafts[chatId]; saveData(data); return telegram('sendMessage', { chat_id: chatId, text: 'Запись не найдена.' }); }
    const review = { id: `REV${crypto.randomBytes(8).toString('hex').toUpperCase()}`, bookingId: booking.id, clientChatId: chatId, name: booking.name, rating: draft.rating, date: new Date().toISOString().slice(0, 10), text, status: 'pending', createdAt: new Date().toISOString() };
    data.reviews.push(review); delete data.reviewDrafts[chatId]; saveData(data);
    await telegram('sendMessage', { chat_id: chatId, text: 'Спасибо за отзыв! Он отправлен мастеру на модерацию 🌸' });
    return notifyOwnerAboutReview(review);
  }

  if (command === '/start' && !isAdmin(chatId)) {
    awaitingPassword.add(chatId);
    return telegram('sendMessage', { chat_id: chatId, text: '🔐 Введите пароль администратора:' });
  }

  if (awaitingPassword.has(chatId)) {
    awaitingPassword.delete(chatId);
    const attempt = botLoginAttempts.get(chatId) || { count: 0, resetAt: Date.now() + 15 * 60000 };
    if (attempt.resetAt <= Date.now()) { attempt.count = 0; attempt.resetAt = Date.now() + 15 * 60000; }
    if (attempt.count >= 5) return telegram('sendMessage', { chat_id: chatId, text: 'Слишком много попыток. Повторите через 15 минут.' });
    if (!ADMIN_PASSWORD || !safeEqualText(text, ADMIN_PASSWORD)) {
      attempt.count += 1; botLoginAttempts.set(chatId, attempt);
      return telegram('sendMessage', { chat_id: chatId, text: '❌ Пароль неверный. Доступ запрещён.\n\nДля повторной попытки нажмите /start.' });
    }
    botLoginAttempts.delete(chatId);
    const data = loadData();
    data.admins = data.admins || [];
    if (!data.admins.includes(chatId) && chatId !== OWNER_CHAT_ID) data.admins.push(chatId);
    saveData(data);
    return telegram('sendMessage', { chat_id: chatId, text: '✨ Добро пожаловать в панель администратора Éclat!\n\nИспользуйте /help, чтобы посмотреть доступные команды.' });
  }
  if (command === '/logout') {
    if (chatId === OWNER_CHAT_ID) return telegram('sendMessage', { chat_id: chatId, text: 'Аккаунт владельца нельзя отключить.' });
    const data = loadData();
    data.admins = (data.admins || []).filter((id) => id !== chatId);
    saveData(data);
    return telegram('sendMessage', { chat_id: chatId, text: 'Доступ администратора закрыт.' });
  }
  if (!isAdmin(chatId)) return telegram('sendMessage', { chat_id: chatId, text: '🔒 Доступ запрещён. Нажмите /start и введите пароль администратора.' });
  if (command === '/start' || command === '/help') return telegram('sendMessage', { chat_id: chatId, text: 'Управление студией:\n/slots 2026-07-08 — открыть или закрыть время\n/bookings — последние заявки\n/today — слоты на сегодня\n/logout — выйти из админки' });
  if (command === '/slots') return sendSlots(message.chat.id, arg || '');
  if (command === '/today') return sendSlots(message.chat.id, new Date().toISOString().slice(0, 10));
  if (command === '/bookings') {
    const items = loadData().bookings.slice(-10).reverse();
    return telegram('sendMessage', { chat_id: message.chat.id, text: items.length ? items.map(bookingText).join('\n\n') : 'Заявок пока нет.' });
  }
}

async function pollTelegram() {
  if (!BOT_TOKEN) return console.log('Telegram отключён: добавьте BOT_TOKEN и OWNER_CHAT_ID.');
  try {
    await telegram('getMe', {});
  } catch (error) { console.error('Owner Telegram getMe:', error.message); }
  let offset = 0;
  while (true) {
    try {
      const result = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of result?.result || []) { offset = update.update_id + 1; await processUpdate(update); }
    } catch (error) { console.error('Owner Telegram:', error.message); await new Promise((resolve) => setTimeout(resolve, 3000)); }
  }
}

async function pollClientTelegram() {
  if (!CLIENT_BOT_TOKEN) return console.log('Клиентский Telegram отключён: добавьте CLIENT_BOT_TOKEN.');
  try {
    const profile = await clientTelegram('getMe', {});
    clientBotUsername = profile?.result?.username || '';
  } catch (error) { console.error('Client Telegram getMe:', error.message); }
  let offset = 0;
  while (true) {
    try {
      const result = await clientTelegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      for (const update of result?.result || []) { offset = update.update_id + 1; await processClientUpdate(update); }
    } catch (error) { console.error('Client Telegram:', error.message); await new Promise((resolve) => setTimeout(resolve, 3000)); }
  }
}

async function sendReminders() {
  if (!CLIENT_BOT_TOKEN) return;
  const data = loadData();
  let changed = false;
  for (const item of data.bookings) {
    if (item.status !== 'confirmed' || !item.clientChatId) continue;
    const appointment = new Date(`${item.date}T${item.time}:00+05:00`).getTime();
    const hours = (appointment - Date.now()) / 3600000;
    if (hours > 2 && hours <= 24 && !item.reminder24h) {
      await clientTelegram('sendMessage', { chat_id: item.clientChatId, text: `🌸 Напоминаем: завтра в ${item.time} вы записаны в Éclat.\n\n${item.service}` });
      item.reminder24h = true; changed = true;
    }
    if (hours > 1 && hours <= 2 && !item.reminder2h) {
      await clientTelegram('sendMessage', { chat_id: item.clientChatId, text: `⏰ Ждём вас сегодня через 2 часа — в ${item.time}.\n\nÉclat Nail Atelier` });
      item.reminder2h = true; changed = true;
    }
  }
  if (changed) saveData(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && rateLimited(req, 'post', 60, 60000)) return json(res, 429, { error: 'Слишком много запросов. Попробуйте позже.' });
  if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (url.pathname === '/api/reviews' && req.method === 'GET') {
    const reviews = loadData().reviews.filter((item) => item.status === 'published').sort((a, b) => String(b.date).localeCompare(String(a.date))).map(({ id, name, rating, date, text }) => ({ id, name, rating, date, text }));
    return json(res, 200, { reviews, reviewUrl: clientBotUsername ? `https://t.me/${clientBotUsername}?start=review` : '' });
  }
  if (url.pathname === '/api/mini/me' && req.method === 'GET') {
    const user = requireMiniUser(req, res); if (!user) return;
    return json(res, 200, { user: { id: user.id, first_name: user.first_name }, role: isAdmin(user.id) ? 'admin' : 'client' });
  }
  if (url.pathname === '/api/mini/admin-login' && req.method === 'POST') {
    const user = requireMiniUser(req, res); if (!user) return;
    if (rateLimited(req, 'admin-login', 5, 15 * 60000)) return json(res, 429, { error: 'Слишком много попыток. Повторите через 15 минут.' });
    const input = await readBody(req).catch(() => ({}));
    if (!ADMIN_PASSWORD || !safeEqualText(input.password, ADMIN_PASSWORD)) return json(res, 403, { error: 'Неверный пароль.' });
    const data = loadData(); data.admins = data.admins || [];
    if (!data.admins.includes(String(user.id)) && String(user.id) !== OWNER_CHAT_ID) data.admins.push(String(user.id));
    saveData(data); return json(res, 200, { user: { id: user.id, first_name: user.first_name }, role: 'admin' });
  }
  if (url.pathname === '/api/mini/dashboard' && req.method === 'GET') {
    const user = requireMiniUser(req, res); if (!user) return;
    const data = loadData();
    if (isAdmin(user.id) && url.searchParams.get('date')) {
      const date = url.searchParams.get('date');
      return json(res, 200, { slots: slotsFor(date), bookings: data.bookings.filter((item) => item.date === date) });
    }
    return json(res, 200, { bookings: data.bookings.filter((item) => String(item.clientChatId) === String(user.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  if (url.pathname === '/api/mini/booking' && req.method === 'POST') {
    const user = requireMiniUser(req, res); if (!user) return;
    if (rateLimited(req, 'booking', 8, 60 * 60000)) return json(res, 429, { error: 'Слишком много заявок. Попробуйте позже.' });
    const input = await readBody(req).catch(() => ({}));
    const required = ['name', 'phone', 'service', 'date', 'time'];
    if (!validBookingInput(input)) return json(res, 400, { error: 'Проверьте имя, телефон, услугу, дату и время.' });
    const slot = slotsFor(input.date).find((item) => item.time === input.time && item.available);
    if (!slot) return json(res, 409, { error: 'Это время уже занято.' });
    const data = loadData();
    const booking = { id: crypto.randomBytes(8).toString('hex').toUpperCase(), ...Object.fromEntries(required.map((key) => [key, String(input[key]).trim()])), clientChatId: String(user.id), status: 'pending', createdAt: new Date().toISOString() };
    data.bookings.push(booking); saveData(data); await notifyOwner(booking);
    return json(res, 201, { ok: true, id: booking.id });
  }
  if (url.pathname === '/api/mini/action' && req.method === 'POST') {
    const user = requireMiniUser(req, res); if (!user) return;
    if (!isAdmin(user.id)) return json(res, 403, { error: 'Нет доступа.' });
    const input = await readBody(req).catch(() => ({}));
    const data = loadData();
    if (input.action === 'toggle') {
      const key = `${input.date}_${input.time}`; data.overrides[key] = data.overrides[key] === false; saveData(data); return json(res, 200, { ok: true });
    }
    const item = data.bookings.find((booking) => booking.id === input.id);
    if (!item || !['confirm', 'reject', 'complete'].includes(input.action)) return json(res, 404, { error: 'Заявка не найдена.' });
    if (input.action === 'complete') {
      item.status = 'completed'; item.completedAt = new Date().toISOString();
      const sent = await sendReviewRequest(item); saveData(data);
      return json(res, 200, { ok: true, reviewRequested: sent });
    }
    await changeBookingStatus(item, input.action === 'confirm' ? 'confirmed' : 'rejected'); saveData(data);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/next-slot' && req.method === 'GET') return json(res, 200, { slot: nextAvailableSlot() });
  if (url.pathname === '/api/slots' && req.method === 'GET') {
    const date = url.searchParams.get('date') || '';
    if (!isValidDate(date)) return json(res, 400, { error: 'Укажите корректную дату в формате ГГГГ-ММ-ДД.' });
    return json(res, 200, { date, slots: slotsFor(date) });
  }
  if (url.pathname === '/api/bookings' && req.method === 'POST') {
    try {
      if (rateLimited(req, 'booking', 8, 60 * 60000)) return json(res, 429, { error: 'Слишком много заявок. Попробуйте позже.' });
      const input = await readBody(req);
      const required = ['name', 'phone', 'service', 'date', 'time'];
      if (!validBookingInput(input)) return json(res, 400, { error: 'Проверьте имя, телефон, услугу, дату и время.' });
      const slot = slotsFor(input.date).find((item) => item.time === input.time && item.available);
      if (!slot) return json(res, 409, { error: 'Это время уже занято. Выберите другое.' });
      const data = loadData();
      const booking = { id: crypto.randomBytes(8).toString('hex').toUpperCase(), clientLinkToken: crypto.randomBytes(12).toString('hex'), ...Object.fromEntries(required.map((key) => [key, String(input[key]).trim()])), status: 'pending', createdAt: new Date().toISOString() };
      data.bookings.push(booking); saveData(data); await notifyOwner(booking);
      const telegramUrl = clientBotUsername ? `https://t.me/${clientBotUsername}?start=booking_${booking.id}_${booking.clientLinkToken}` : '';
      return json(res, 201, { ok: true, id: booking.id, message: 'Заявка отправлена владельцу на подтверждение.', telegramUrl });
    } catch { return json(res, 400, { error: 'Некорректные данные.' }); }
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { ...securityHeaders(), Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  let relative;
  try { relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)).replace(/\\/g, '/'); }
  catch { res.writeHead(400, securityHeaders()); return res.end('Bad request'); }
  const isPublicAsset = relative.startsWith('assets/') && /\.(png|jpe?g|webp|svg)$/i.test(relative);
  if (!PUBLIC_FILES.has(relative) && !isPublicAsset) { res.writeHead(404, securityHeaders()); return res.end('Not found'); }
  const filePath = path.resolve(ROOT, relative);
  const pathWithinRoot = path.relative(ROOT, filePath);
  if (pathWithinRoot.startsWith('..') || path.isAbsolute(pathWithinRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404, securityHeaders()); return res.end('Not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
  res.writeHead(200, { ...securityHeaders(), 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': relative.endsWith('.html') ? 'no-cache' : 'public, max-age=86400' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
server.listen(PORT, () => console.log(`Éclat: http://localhost:${PORT}`));
pollTelegram();
pollClientTelegram();
setInterval(() => sendReminders().catch((error) => console.error('Reminders:', error.message)), 60000);
setInterval(pruneRateBuckets, 5 * 60000).unref();
