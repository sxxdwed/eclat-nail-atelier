const form = document.getElementById('bookingForm');
const status = document.getElementById('formStatus');
const dateInput = form.elements.date;
const timeInput = form.elements.time;
const slotHint = document.getElementById('slotHint');

function localDateKey(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

dateInput.min = localDateKey();
dateInput.addEventListener('change', async () => {
  timeInput.disabled = true;
  timeInput.innerHTML = '<option value="">Загружаем свободное время…</option>';
  slotHint.textContent = '';
  try {
    const response = await fetch(`/api/slots?date=${encodeURIComponent(dateInput.value)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось загрузить расписание.');
    const { slots } = result;
    const free = slots.filter((slot) => slot.available);
    timeInput.innerHTML = free.length
      ? '<option value="">Выберите время</option>' + free.map((slot) => `<option value="${slot.time}">${slot.time}</option>`).join('')
      : '<option value="">Свободных окон нет</option>';
    timeInput.disabled = !free.length;
    slotHint.textContent = free.length ? `Свободно окон: ${free.length}` : 'Выберите другой рабочий день.';
  } catch {
    timeInput.innerHTML = '<option value="">Запустите сайт через server.js</option>';
    slotHint.textContent = 'Расписание доступно только при запуске локального сервера.';
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  status.textContent = 'Отправляем заявку владельцу…';
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    status.textContent = `Спасибо! ${result.message} Номер заявки: ${result.id}.`;
    if (result.telegramUrl) {
      const telegramLink = document.createElement('a');
      telegramLink.href = result.telegramUrl;
      telegramLink.target = '_blank';
      telegramLink.rel = 'noopener';
      telegramLink.className = 'telegram-status-link';
      telegramLink.textContent = 'Получать подтверждение и напоминания ↗';
      status.append(document.createElement('br'), telegramLink);
    }
    form.reset();
    timeInput.disabled = true;
    timeInput.innerHTML = '<option value="">Сначала выберите дату</option>';
  } catch (error) {
    status.textContent = error.message || 'Не удалось отправить заявку.';
  } finally {
    submit.disabled = false;
  }
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: .12 });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

async function loadNextSlot() {
  const target = document.getElementById('nextSlot');
  try {
    const response = await fetch('/api/next-slot');
    const { slot } = await response.json();
    if (!response.ok || !slot) {
      target.textContent = 'Уточните у мастера';
      return;
    }
    const today = localDateKey();
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = localDateKey(tomorrowDate);
    const dateLabel = slot.date === today
      ? 'Сегодня'
      : slot.date === tomorrow
        ? 'Завтра'
        : new Date(`${slot.date}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    target.textContent = `${dateLabel}, ${slot.time}`;
  } catch {
    target.textContent = 'Уточните у мастера';
  }
}

loadNextSlot();

const works = {
  lines: { category: 'МИНИМАЛИЗМ', title: 'Тонкие линии', description: 'Полупрозрачная розовая база и невесомые золотые линии. Спокойный дизайн, который выглядит уместно и с деловым костюмом, и с вечерним образом.', duration: '100 минут', price: '2 800 ₽', image: 'assets/work-lines-v2.png', position: 'center' },
  milky: { category: 'КЛАССИКА', title: 'Молочный', description: 'Чистое плотное покрытие с мягким молочным оттенком. Визуально удлиняет пальцы и подчёркивает аккуратную форму ногтей.', duration: '90 минут', price: '2 500 ₽', image: 'assets/work-milky-v2.png', position: 'center' },
  wine: { category: 'АКЦЕНТНЫЕ', title: 'Глубокий винный', description: 'Насыщенный винный оттенок и зеркальный глянец. Выразительный монохром для тех, кто любит лаконичные, но заметные детали.', duration: '90 минут', price: '2 500 ₽', image: 'assets/work-wine-v2.png', position: 'center' },
  french: { category: 'КЛАССИКА', title: 'Нежный French', description: 'Воздушная розовая база и тонкая белая линия улыбки. Современная версия французского маникюра — лёгкая и безупречно аккуратная.', duration: '110 минут', price: '2 900 ₽', image: 'assets/work-french-v2.png', position: 'center' }
};

const dialog = document.getElementById('workDialog');
const photo = document.getElementById('workPhoto');
const filterButtons = document.querySelectorAll('.filter-chip');
const workCards = document.querySelectorAll('.work-card');

filterButtons.forEach((button) => button.addEventListener('click', () => {
  filterButtons.forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  const filter = button.dataset.filter;
  workCards.forEach((card) => card.classList.toggle('hidden', filter !== 'all' && card.dataset.category !== filter));
}));

workCards.forEach((card) => card.addEventListener('click', () => {
  const work = works[card.dataset.work];
  document.getElementById('workCategory').textContent = work.category;
  document.getElementById('workTitle').textContent = work.title;
  document.getElementById('workDescription').textContent = work.description;
  document.getElementById('workDuration').textContent = work.duration;
  document.getElementById('workPrice').textContent = work.price;
  photo.style.backgroundImage = work.image ? `url("${work.image}")` : 'url("assets/manicure-collection.png")';
  photo.style.backgroundPosition = work.position;
  photo.setAttribute('aria-label', `Маникюр «${work.title}»`);
  dialog.showModal();
}));

document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
document.querySelector('.dialog-book').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

const viewButtons = document.querySelectorAll('.view-switch button');
const savedView = localStorage.getItem('eclat-view');

function setView(view) {
  document.body.classList.toggle('mobile-preview', view === 'mobile');
  document.body.classList.toggle('desktop-preview', view === 'desktop');
  viewButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  localStorage.setItem('eclat-view', view);
}

viewButtons.forEach((button) => button.addEventListener('click', () => {
  const isActive = button.getAttribute('aria-pressed') === 'true';
  setView(isActive ? 'auto' : button.dataset.view);
}));

if (savedView === 'mobile' || savedView === 'desktop') setView(savedView);

const reviewsGrid = document.getElementById('reviewsGrid');
const reviewDialog = document.getElementById('reviewDialog');
const reviewTelegramLink = document.getElementById('reviewTelegramLink');

function renderReviews(reviews) {
  reviewsGrid.replaceChildren();
  if (!reviews.length) {
    const empty = document.createElement('article');
    empty.className = 'review-card review-loading';
    empty.textContent = 'Первый опубликованный отзыв скоро появится здесь.';
    reviewsGrid.append(empty);
    return;
  }
  reviews.forEach((review) => {
    const card = document.createElement('article');
    card.className = 'review-card reveal visible';
    const stars = document.createElement('div');
    stars.className = 'review-card-stars';
    stars.textContent = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
    const text = document.createElement('p');
    text.className = 'review-card-text';
    text.textContent = review.text;
    const footer = document.createElement('div');
    footer.className = 'review-card-footer';
    const name = document.createElement('strong');
    name.textContent = review.name;
    const date = document.createElement('time');
    date.dateTime = review.date;
    date.textContent = new Date(`${review.date}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    footer.append(name, date);
    card.append(stars, text, footer);
    reviewsGrid.append(card);
  });
}

async function loadReviews() {
  try {
    const response = await fetch('/api/reviews');
    const data = await response.json();
    renderReviews(data.reviews || []);
    if (data.reviewUrl) reviewTelegramLink.href = data.reviewUrl;
  } catch {
    reviewsGrid.textContent = 'Не удалось загрузить отзывы.';
  }
}

document.getElementById('openReviewDialog').addEventListener('click', () => reviewDialog.showModal());
document.getElementById('closeReviewDialog').addEventListener('click', () => reviewDialog.close());
reviewDialog.addEventListener('click', (event) => { if (event.target === reviewDialog) reviewDialog.close(); });
loadReviews();
