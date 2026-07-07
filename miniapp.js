const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand(); tg?.setHeaderColor('#fffdfb');
const initData = tg?.initData || '';
const authHeaders = { 'x-telegram-init-data': encodeURIComponent(initData) };
const $ = (id) => document.getElementById(id);
let me = null, selectedTime = '';

function toast(text){$('toast').textContent=text;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2600)}
async function api(url, options={}){const response=await fetch(url,{...options,headers:{...authHeaders,'Content-Type':'application/json',...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||'Ошибка');return data}
function statusLabel(status){return {pending:'Ожидает',confirmed:'Подтверждена',rejected:'Отклонена'}[status]||status}
function esc(value){return String(value??'').replace(/[&<>'"]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]))}

async function boot(){
  if(!initData){$('loading').textContent='Откройте приложение через Telegram-бота. Для работы требуется авторизация Telegram.';return}
  try{me=await api('/api/mini/me');$('loading').hidden=true;$('clientView').hidden=false;const today=new Date().toISOString().slice(0,10);$('clientDate').min=today;$('clientDate').value=today;$('adminDate').value=today;await loadSlots();await loadMine();if(me.role==='admin')$('roleButton').textContent='Панель владельца'}catch(error){$('loading').textContent=error.message}
}
async function loadSlots(){selectedTime='';$('miniBookingForm').hidden=true;const data=await api(`/api/slots?date=${$('clientDate').value}`);$('miniSlots').innerHTML=data.slots.length?data.slots.map(s=>`<button ${s.available?'':'disabled'} data-time="${s.time}">${s.time}</button>`).join(''):'<p>В этот день студия не работает.</p>'}
async function loadMine(){const data=await api('/api/mini/dashboard');$('myBookings').innerHTML=data.bookings.length?data.bookings.map(b=>`<article class="booking-card"><header><strong>${esc(b.date)} · ${esc(b.time)}</strong><span class="status ${esc(b.status)}">${esc(statusLabel(b.status))}</span></header><p>${esc(b.service)}</p></article>`).join(''):'<article class="booking-card">У вас пока нет записей.</article>'}
async function loadAdmin(){const date=$('adminDate').value;const data=await api(`/api/mini/dashboard?date=${date}`);$('adminSchedule').innerHTML=data.slots.map(slot=>{const b=data.bookings.find(x=>x.time===slot.time&&x.status!=='rejected');const bookingActions=b?.status==='confirmed'?`<button data-action="complete" data-id="${esc(b.id)}">Завершить и запросить отзыв</button><button data-action="reject" data-id="${esc(b.id)}">Отменить</button>`:`<button data-action="confirm" data-id="${esc(b?.id)}">Подтвердить</button><button data-action="reject" data-id="${esc(b?.id)}">Отклонить</button>`;return `<article class="timeline-item"><span class="time">${esc(slot.time)}</span><div class="info">${b?`<strong>${esc(b.name)}</strong><p>${esc(b.service)}<br>${esc(b.phone)}</p><div class="actions">${bookingActions}</div>`:`<strong>${slot.status==='closed'?'Закрыто':'Свободно'}</strong><div class="actions"><button data-action="toggle" data-time="${esc(slot.time)}">${slot.status==='closed'?'Открыть':'Закрыть'}</button></div>`}</div></article>`}).join('')}

$('clientDate').addEventListener('change',loadSlots);$('miniSlots').addEventListener('click',e=>{const b=e.target.closest('button[data-time]');if(!b)return;document.querySelectorAll('#miniSlots button').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');selectedTime=b.dataset.time;$('miniBookingForm').hidden=false});
$('miniSubmit').addEventListener('click',async()=>{try{await api('/api/mini/booking',{method:'POST',body:JSON.stringify({name:$('miniName').value,phone:$('miniPhone').value,service:$('miniService').value,date:$('clientDate').value,time:selectedTime})});toast('Заявка отправлена');await loadSlots();await loadMine();tg?.HapticFeedback?.notificationOccurred('success')}catch(e){toast(e.message)}});
$('roleButton').addEventListener('click',async()=>{if(me?.role==='admin'){showAdmin();return}$('adminLogin').showModal()});
$('adminLoginButton').addEventListener('click',async()=>{try{me=await api('/api/mini/admin-login',{method:'POST',body:JSON.stringify({password:$('adminPassword').value})});$('adminLogin').close();$('roleButton').textContent='Панель владельца';showAdmin()}catch(e){$('loginStatus').textContent=e.message}});
function showAdmin(){$('clientView').hidden=true;$('adminView').hidden=false;document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.screen==='admin'));loadAdmin()}
function showClient(){$('adminView').hidden=true;$('clientView').hidden=false;document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.screen==='client'))}
document.querySelector('.bottom-nav').addEventListener('click',e=>{const b=e.target.closest('button[data-screen]');if(!b)return;if(b.dataset.screen==='admin'){if(me?.role==='admin')showAdmin();else $('adminLogin').showModal()}else showClient()});
$('adminDate').addEventListener('change',loadAdmin);$('adminSchedule').addEventListener('click',async e=>{const b=e.target.closest('button[data-action]');if(!b)return;try{await api('/api/mini/action',{method:'POST',body:JSON.stringify({action:b.dataset.action,id:b.dataset.id,date:$('adminDate').value,time:b.dataset.time})});toast('Готово');loadAdmin()}catch(err){toast(err.message)}});
boot();
