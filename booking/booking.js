const API = window.location.origin;
let services = [], sections = [], employees = [], allClients = [];
let selectedService = null, selectedDate = '', selectedSlot = null;
let currentClient = null, currentAppointments = [];
let modifyingApptId = null;
let calMonth = new Date();
let calData = {};

function showLoading(v) { document.getElementById('loadingOverlay').style.display = v ? 'flex' : 'none'; }

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function escAttr(s) { return s.replace(/'/g,"\\'").replace(/"/g,'&quot;'); }
function cur(n) { return parseFloat(n||0).toFixed(2)+'\u20AC'; }
function fmtDate(d) { if (!d || typeof d !== 'string') return d; const p = d.split('-'); return p.length===3 ? p[2]+'-'+p[1]+'-'+p[0] : d; }
function miniCalendar(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const p = dateStr.split('-');
  if (p.length !== 3) return '';
  const year = parseInt(p[0]), month = parseInt(p[1])-1, day = parseInt(p[2]);
  const first = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const weekDays = ['D','L','M','X','J','V','S'];
  let html = '<table class="mini-cal"><tr>'+weekDays.map(d=>'<th>'+d+'</th>').join('')+'</tr><tr>';
  for (let i=0; i<first; i++) html += '<td></td>';
  for (let d=1; d<=daysInMonth; d++) {
    html += '<td'+(d===day?' class="mc-highlight"':'')+'>'+d+'</td>';
    if ((first+d)%7===0 && d<daysInMonth) html += '</tr><tr>';
  }
  let total = first + daysInMonth;
  while (total%7!==0) { html += '<td></td>'; total++; }
  html += '</tr></table>';
  return html;
}

function goStep(n) {
  document.querySelectorAll('.step-indicator .step').forEach((s,i) => { s.classList.toggle('active', i===n); s.classList.toggle('done', i<n); });
  document.querySelectorAll('.step-content').forEach((s,i) => s.classList.toggle('active', i===n));
}

function fetchAvailability() {
  if (!selectedService) return;
  const month = calMonth.getFullYear() + '-' + String(calMonth.getMonth() + 1).padStart(2, '0');
  showLoading(true);
  fetch(API + '/api/availability?month=' + month + '&serviceId=' + selectedService.id)
    .then(r => r.json())
    .then(d => {
      calData = d.dates || {};
      renderCalendar();
      showLoading(false);
    })
    .catch(() => showLoading(false));
}

function renderCalendar() {
  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  const monthStr = String(month + 1).padStart(2, '0');
  const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  document.getElementById('calMonthLabel').textContent = monthNames[month] + ' ' + year;

  const weekDays = ['L','M','X','J','V','S','D'];
  document.getElementById('calWeekdays').innerHTML = weekDays.map(d => '<span>' + d + '</span>').join('');

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;

  let html = '';
  for (let i = 0; i < startOffset; i++) html += '<div class="cal-day cal-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + monthStr + '-' + String(d).padStart(2, '0');
    const status = calData[dateStr] || 'disabled';
    const isSelected = dateStr === selectedDate;
    html += '<div class="cal-day cal-day-' + status + (isSelected ? ' cal-selected' : '') + '" data-date="' + dateStr + '" onclick="selectCalDate(\'' + dateStr + '\')">' + d + '</div>';
  }

  document.getElementById('calGrid').innerHTML = html;
}

function selectCalDate(dateStr) {
  selectedDate = dateStr;
  selectedSlot = null;
  document.getElementById('selectedSlot').textContent = '';
  document.querySelectorAll('.cal-day').forEach(d => d.classList.remove('cal-selected'));
  const el = document.querySelector('.cal-day[data-date="' + dateStr + '"]');
  if (el) el.classList.add('cal-selected');
  fetchSlots();
}

function prevMonth() {
  calMonth.setMonth(calMonth.getMonth() - 1);
  fetchAvailability();
}

function nextMonth() {
  calMonth.setMonth(calMonth.getMonth() + 1);
  fetchAvailability();
}

async function loadData() {
  showLoading(true);
  try {
    const r = await fetch(API + '/sync');
    const d = await r.json();
    services = (d.services||[]).filter(s => !s._deleted);
    sections = (d.sections||[]).filter(s => !s._deleted);
    employees = (d.employees||[]).filter(e => !e._deleted);
    allClients = (d.clients||[]).filter(c => !c._deleted);
    const settings = d.settings || {};
    document.getElementById('footerInfo').textContent = settings.businessName || 'Nymara Estilistas';
    renderServices();
  } catch(e) { alert('Error al cargar datos: '+e.message); }
  showLoading(false);
}

// === LOGIN / REGISTER ===
async function loginClient() {
  const phone = document.getElementById('loginPhone').value.trim();
  if (!phone) { alert('Introduce tu teléfono'); return; }
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client?phone='+encodeURIComponent(phone));
    if (r.status === 404) { alert('No encontramos un cliente con ese teléfono. Regístrate abajo.'); showLoading(false); return; }
    const d = await r.json();
    currentClient = d.client;
    currentAppointments = d.appointments;
    showLoading(false);
    renderMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

async function registerClient() {
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  if (!name || !phone) { alert('Nombre y teléfono son obligatorios'); return; }
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone })
    });
    const d = await r.json();
    if (!d.ok) { alert(d.error||'Error al registrarse'); showLoading(false); return; }
    currentClient = d.client;
    currentAppointments = [];
    showLoading(false);
    renderMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

// === MY APPOINTMENTS ===
function renderMyAppts() {
  document.getElementById('clientInfo').innerHTML = '<strong>Cliente:</strong> '+esc(currentClient.name)+' &middot; 📞 '+esc(currentClient.phone);
  goStep(1);
  const div = document.getElementById('myApptsList');
  const noMsg = document.getElementById('noApptsMsg');
  if (!currentAppointments.length) {
    div.innerHTML = '';
    noMsg.style.display = 'block';
    return;
  }
  noMsg.style.display = 'none';
  const today = new Date().toISOString().split('T')[0];
  div.innerHTML = currentAppointments.map(a => {
    const isPast = a.date < today;
    return '<div class="appt-card'+(isPast?' appt-past':'')+'">'+
      '<div class="appt-card-date">'+
        '<span class="appt-card-day">'+esc(fmtDate(a.date))+'</span>'+
        '<span class="appt-card-time">'+esc(a.time)+'</span>'+
        '<div class="appt-cal-tooltip">'+miniCalendar(a.date)+'</div>'+
      '</div>'+
      '<div class="appt-card-info">'+
        '<div class="appt-card-service">'+esc(a.serviceName)+'</div>'+
        (a.notes?'<div class="appt-card-notes">'+esc(a.notes)+'</div>':'')+
        (a.status==='cancelled'?'<div style="color:#e74c3c;font-weight:600;">Cancelada</div>':'')+
      '</div>'+
      (!isPast && a.status!=='cancelled' && a.source==='online' ? '<div class="appt-card-actions">'+
        '<button class="btn btn-sm btn-secondary" onclick="modifyAppt(\''+a.id+'\')">Modificar</button>'+
        '<button class="btn btn-sm btn-danger" onclick="cancelAppt(\''+a.id+'\')">Cancelar</button>'+
      '</div>' : '')+
    '</div>';
  }).join('');
}

async function cancelAppt(id) {
  if (!confirm('¿Estás seguro de cancelar esta cita?')) return;
  showLoading(true);
  try {
    const r = await fetch(API+'/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointmentId: id, phone: currentClient.phone })
    });
    const d = await r.json();
    if (!d.ok) { alert(d.error||'Error al cancelar'); showLoading(false); return; }
    showLoading(false);
    alert('Cita cancelada correctamente');
    refreshMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

async function refreshMyAppts() {
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client?phone='+encodeURIComponent(currentClient.phone));
    const d = await r.json();
    currentAppointments = d.appointments;
    showLoading(false);
    renderMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

// === MODIFY APPOINTMENT ===
let selectedModifySlot = null;

async function loadModifySlots(dateStr) {
  if (!modifyingApptId) return;
  const appt = currentAppointments.find(a => a.id === modifyingApptId);
  if (!appt) return;
  const svcId = appt.serviceId || '';
  const r = await fetch(API+'/api/slots?date='+dateStr+'&serviceId='+svcId);
  return await r.json();
}

function renderModifySlots(slotsData, preSelectTime) {
  const container = document.getElementById('modifySlots');
  const noSlots = document.getElementById('modifyNoSlots');
  const slots = slotsData.slots || [];
  const avail = slots.filter(s => s.available);
  if (!avail.length) { container.innerHTML = ''; noSlots.style.display = 'block'; document.getElementById('modifyBtn').disabled = true; return false; }
  noSlots.style.display = 'none';

  const empMap = {}; const timeMap = {};
  slots.forEach(s => { empMap[s.employeeId||''] = s.employeeName||'Sin asignar'; timeMap[s.time] = true; });
  const empIds = Object.keys(empMap);
  const times = Object.keys(timeMap).sort();

  let found = false;
  let html = '<table class="slots-table"><thead><tr><th></th>';
  empIds.forEach(eid => { html += '<th>'+esc(empMap[eid])+'</th>'; });
  html += '</tr></thead><tbody>';
  times.forEach(t => {
    html += '<tr><td class="st-time">'+esc(t)+'</td>';
    empIds.forEach(eid => {
      const s = slots.find(x => x.time === t && x.employeeId === eid);
      if (!s) { html += '<td class="st-na"></td>'; return; }
      if (!s.available) { html += '<td class="st-occupied"></td>'; return; }
      const selected = s.time === preSelectTime && !found ? ' selected' : '';
      if (s.time === preSelectTime && !found) { found = true; selectedModifySlot = { time: s.time, employeeId: s.employeeId }; }
      html += '<td class="st-free'+selected+'" data-time="'+s.time+'" data-eid="'+s.employeeId+'" data-ename="'+escAttr(empMap[eid])+'" onclick="selectModifySlot(this)"></td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
  if (found) document.getElementById('modifyBtn').disabled = false;
  else { document.getElementById('modifyBtn').disabled = true; selectedModifySlot = null; }
  return true;
}

async function modifyAppt(id) {
  modifyingApptId = id;
  const appt = currentAppointments.find(a => a.id === id);
  if (!appt) return;
  document.getElementById('modifyTitle').textContent = 'Modificar cita: '+fmtDate(appt.date)+' '+appt.time;
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const dateInput = document.getElementById('modifyDate');
  dateInput.value = appt.date;
  dateInput.min = tomorrow.toISOString().split('T')[0];
  document.getElementById('modifyDateDisplay').textContent = '('+fmtDate(appt.date)+')';
  selectedModifySlot = null;
  document.getElementById('modifyBtn').disabled = true;
  document.getElementById('modifySlots').innerHTML = '';
  document.getElementById('modifyNoSlots').style.display = 'none';
  document.getElementById('modifyError').style.display = 'none';
  document.getElementById('modifyModal').style.display = 'flex';
  showLoading(true);
  try {
    const d = await loadModifySlots(appt.date);
    renderModifySlots(d, appt.time);
  } catch(e) { document.getElementById('modifySlots').innerHTML = ''; }
  showLoading(false);
}

function closeModify() {
  document.getElementById('modifyModal').style.display = 'none';
  modifyingApptId = null;
  selectedModifySlot = null;
}

document.getElementById('modifyDate').addEventListener('change', async function() {
  if (!modifyingApptId) return;
  document.getElementById('modifyDateDisplay').textContent = '('+fmtDate(this.value)+')';
  const appt = currentAppointments.find(a => a.id === modifyingApptId);
  if (!appt) return;
  selectedModifySlot = null;
  document.getElementById('modifyBtn').disabled = true;
  showLoading(true);
  try {
    const d = await loadModifySlots(this.value);
    renderModifySlots(d, null);
  } catch(e) { document.getElementById('modifySlots').innerHTML = ''; }
  showLoading(false);
});

function selectModifySlot(el) {
  document.querySelectorAll('#modifySlots .st-free').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  selectedModifySlot = { time: el.getAttribute('data-time'), employeeId: el.getAttribute('data-eid') };
  document.getElementById('modifyBtn').disabled = false;
}

async function confirmModify() {
  if (!selectedModifySlot) return;
  showLoading(true);
  try {
    const r = await fetch(API+'/api/modify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appointmentId: modifyingApptId,
        phone: currentClient.phone,
        newDate: document.getElementById('modifyDate').value,
        newTime: selectedModifySlot.time,
        newEmployeeId: selectedModifySlot.employeeId
      })
    });
    const d = await r.json();
    if (!d.ok) { alert(d.error||'Error al modificar'); showLoading(false); return; }
    closeModify();
    showLoading(false);
    alert('Cita modificada correctamente');
    refreshMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

// === NEW BOOKING FLOW ===
function startNewBooking() {
  selectedService = null; selectedSlot = null;
  document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('clientName').value = currentClient.name;
  document.getElementById('clientPhone').value = currentClient.phone;
  document.getElementById('clientEmail').value = currentClient.email || '';
  document.getElementById('bookingNotes').value = '';
  document.getElementById('confirmBtn').disabled = false;
  document.getElementById('confirmBtn').textContent = 'Confirmar Reserva';
  goStep(2);
}

function renderServices(q) {
  const div = document.getElementById('servicesList');
  let list = services;
  if (q) list = list.filter(s => s.name.toLowerCase().includes(q));
  if (!list.length) { div.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-light);">No hay servicios disponibles</div>'; return; }
  div.innerHTML = list.map(s => {
    const sec = sections.find(x => x.id === s.sectionId);
    const sc = sec && sec.color ? sec.color : '#999';
    return '<div class="service-card" data-id="'+s.id+'" onclick="selectService(\''+s.id+'\')">'+
      '<span class="s-color" style="background:'+sc+';"></span>'+
      '<div class="s-info">'+
        '<div class="s-name">'+esc(s.name)+'</div>'+
        '<div class="s-meta">'+(sec ? esc(sec.name) : '')+(s.duration ? ' &middot; '+s.duration+' min' : '')+'</div>'+
      '</div>'+
      '<div class="s-price">'+cur(s.price)+'</div>'+
    '</div>';
  }).join('');
}

function filterServices() {
  const q = document.getElementById('searchService').value.toLowerCase();
  renderServices(q);
}

function selectService(id) {
  document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
  const el = document.querySelector('.service-card[data-id="'+id+'"]');
  if (el) el.classList.add('selected');
  selectedService = services.find(s => s.id === id);
  selectedDate = '';
  selectedSlot = null;
  document.getElementById('selectedService').textContent = 'Servicio: '+(selectedService?selectedService.name:'')+' | '+cur(selectedService?selectedService.price:0)+(selectedService&&selectedService.duration?' &middot; '+selectedService.duration+' min':'');
  document.getElementById('selectedSlot').textContent = '';
  document.getElementById('slotsContainer').innerHTML = '';
  document.getElementById('noSlots').style.display = 'none';
  calMonth = new Date();
  goStep(3);
  fetchAvailability();
}

function onDateChange() {
  selectedDate = document.getElementById('bookingDate').value;
  if (!selectedService) return;
  selectedSlot = null;
  document.getElementById('selectedSlot').textContent = '';
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  fetchSlots();
}

async function fetchSlots() {
  if (!selectedService || !selectedDate) return;
  showLoading(true);
  try {
    const r = await fetch(API+'/api/slots?date='+selectedDate+'&serviceId='+selectedService.id);
    const d = await r.json();
    renderSlots(d.slots || []);
  } catch(e) { document.getElementById('slotsContainer').innerHTML = ''; document.getElementById('noSlots').style.display = 'block'; }
  showLoading(false);
}

function renderSlots(slots) {
  const container = document.getElementById('slotsContainer');
  const noSlots = document.getElementById('noSlots');
  selectedSlot = null;
  document.getElementById('selectedSlot').textContent = '';
  const avail = slots.filter(s => s.available);
  if (!avail.length && !slots.some(s => !s.available)) { container.innerHTML = ''; noSlots.style.display = 'block'; return; }
  noSlots.style.display = 'none';

  const empMap = {}; const timeMap = {};
  slots.forEach(s => { empMap[s.employeeId||''] = s.employeeName||'Sin asignar'; timeMap[s.time] = true; });
  const empIds = Object.keys(empMap);
  const times = Object.keys(timeMap).sort();

  let html = '<table class="slots-table"><thead><tr><th></th>';
  empIds.forEach(eid => { html += '<th>'+esc(empMap[eid])+'</th>'; });
  html += '</tr></thead><tbody>';
  times.forEach(t => {
    html += '<tr><td class="st-time">'+esc(t)+'</td>';
    empIds.forEach(eid => {
      const s = slots.find(x => x.time === t && x.employeeId === eid);
      if (!s) { html += '<td class="st-na"></td>'; return; }
      if (!s.available) { html += '<td class="st-occupied"></td>'; return; }
      html += '<td class="st-free" data-time="'+t+'" data-eid="'+eid+'" data-ename="'+escAttr(empMap[eid])+'" onclick="selectSlotFromTable(this)"></td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function selectSlotFromTable(el) {
  document.querySelectorAll('.st-free').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  const time = el.getAttribute('data-time');
  const employeeId = el.getAttribute('data-eid');
  const employeeName = el.getAttribute('data-ename') || '';
  selectedSlot = { time, employeeId, employeeName };
  document.getElementById('selectedSlot').textContent = employeeName ? esc(employeeName)+' · '+time : time;
  goStep(4);
  updateSummary();
}

function updateSummary() {
  const div = document.getElementById('bookingSummary');
  if (!selectedService || !selectedSlot) { div.innerHTML = ''; return; }
  div.innerHTML = '<strong>Resumen</strong><br>'+
    'Servicio: '+esc(selectedService.name)+'<br>'+
    'Fecha: '+fmtDate(selectedDate)+'<br>'+
    'Horario: '+selectedSlot.time+(selectedSlot.employeeName?' con '+selectedSlot.employeeName:'')+'<br>'+
    '<strong>Total: '+cur(selectedService.price)+'</strong>';
}

async function confirmBooking() {
  if (!selectedService || !selectedSlot) { alert('Selecciona servicio y horario'); return; }

  document.getElementById('confirmBtn').disabled = true;
  document.getElementById('confirmBtn').textContent = 'Reservando...';
  showLoading(true);
  try {
    const r = await fetch(API+'/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceId: selectedService.id,
        date: selectedDate,
        time: selectedSlot.time,
        employeeId: selectedSlot.employeeId,
        clientName: currentClient.name,
        clientPhone: currentClient.phone,
        clientEmail: document.getElementById('clientEmail').value.trim(),
        notes: document.getElementById('bookingNotes').value.trim()
      })
    });
    const d = await r.json();
    if (d.ok) {
      goStep(5);
      const waMsg = 'Hola!%20Tu%20cita%20en%20Nymara%20Estilistas%20ha%20sido%20confirmada%20para%20el%20' + encodeURIComponent(selectedDate) + '%20a%20las%20' + encodeURIComponent(selectedSlot.time) + '.';
      const waPhone = (currentClient.phone||'').replace(/[^0-9]/g,'');
      const waLink = 'https://wa.me/34' + waPhone + '?text=' + waMsg;
      let extra = '';
      if (d.emailSent) extra = '✅ Te hemos enviado un email de confirmación.<br><br>';
      extra += '💬 <a href="' + waLink + '" target="_blank" style="color:#25D366;font-weight:600;">Recibir confirmación por WhatsApp</a>';
      document.getElementById('doneMsg').innerHTML = 'Tu cita ha sido registrada para el <strong>'+fmtDate(selectedDate)+'</strong> a las <strong>'+selectedSlot.time+'</strong>'+(selectedSlot.employeeName?' con <strong>'+selectedSlot.employeeName+'</strong>':'')+'.<br><br>'+extra;
    } else {
      alert('Error: '+(d.error||'No se pudo reservar'));
      document.getElementById('confirmBtn').disabled = false;
      document.getElementById('confirmBtn').textContent = 'Confirmar Reserva';
    }
  } catch(e) { alert('Error de conexión: '+e.message); document.getElementById('confirmBtn').disabled = false; document.getElementById('confirmBtn').textContent = 'Confirmar Reserva'; }
  showLoading(false);
}

function goToMyAppts() {
  refreshMyAppts();
}

function logout() {
  currentClient = null;
  currentAppointments = [];
  selectedService = null; selectedSlot = null;
  document.getElementById('loginPhone').value = '';
  document.getElementById('regName').value = '';
  document.getElementById('regPhone').value = '';
  goStep(0);
}

loadData();