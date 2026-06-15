const API = window.location.origin;
let services = [], sections = [], employees = [], allClients = [];
let selectedService = null, selectedDate = '', selectedSlot = null;
let currentClient = null, currentAppointments = [];
let modifyingApptId = null;
let countdownTimer = null;
let onlineStatusPoller = null;

function showLoading(v) { document.getElementById('loadingOverlay').style.display = v ? 'flex' : 'none'; }

function getOpeningHoursForDay(dateStr, settings) {
  if (!settings || !settings.openingHours) return { open: 9, close: 19, closed: false };
  const d = new Date(dateStr + 'T12:00:00').getDay();
  const day = settings.openingHours[d] || { open: '09:00', close: '19:00', closed: false };
  const openH = parseInt(day.open) || 9;
  const closeH = parseInt(day.close) || 19;
  const openMin = parseInt((day.open || '09:00').split(':')[1]) || 0;
  const closeMin = parseInt((day.close || '19:00').split(':')[1]) || 0;
  return {
    open: openH + openMin / 60,
    close: closeH + closeMin / 60,
    closed: day.closed === true
  };
}

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
    const today = new Date().toISOString().split('T')[0];
    const dayCfg = (settings.onlineOpening || {})[today] || {};
    const openingTime = dayCfg.time || '18:00';
    const enabled = dayCfg.enabled !== false;
    if (dayCfg.time === undefined && dayCfg.enabled === undefined) {
      const oh = getOpeningHoursForDay(today, settings);
      if (oh.closed) { showClosedTemporarily(); return; }
      checkOpeningTime(openingTime, true);
    } else {
      checkOpeningTime(openingTime, enabled);
    }
  } catch(e) { alert('Error al cargar datos: '+e.message); }
  showLoading(false);
}

function checkOpeningTime(openingTime, enabled) {
  if (!enabled) {
    showClosedTemporarily();
    return;
  }
  const now = new Date();
  const [h, m] = openingTime.split(':').map(Number);
  const opening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (now < opening) {
    document.getElementById('countdownTargetTime').textContent = openingTime;
    showCountdown(opening);
  }
}

function startOnlineStatusPoller() {
  if (onlineStatusPoller) clearInterval(onlineStatusPoller);
  onlineStatusPoller = setInterval(async () => {
    try {
      const r = await fetch(API + '/api/online-status');
      const d = await r.json();
      if (!d.enabled) {
        const today = new Date().toISOString().split('T')[0];
        const oh = getOpeningHoursForDay(today, d.settings || {});
        if (!oh.closed) return; else { location.reload(); return; }
      }
      const now = new Date();
      const [h, m] = (d.openingTime || '18:00').split(':').map(Number);
      const opening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      if (now >= opening) location.reload();
    } catch(e) {}
  }, 15000);
}

function showClosedTemporarily() {
  const overlay = document.getElementById('openingCountdown');
  overlay.style.display = 'flex';
  document.querySelector('.container').style.display = 'none';
  document.getElementById('countdownIcon').textContent = '🔒';
  document.getElementById('countdownTitle').textContent = 'Reservas Online cerradas temporalmente';
  document.getElementById('countdownSub').textContent = 'Estar pendientes de su apertura';
  document.getElementById('countdownDisplay').style.display = 'none';
  document.getElementById('countdownLabel').style.display = 'none';
  startOnlineStatusPoller();
}

function showCountdown(target) {
  const overlay = document.getElementById('openingCountdown');
  overlay.style.display = 'flex';
  document.querySelector('.container').style.display = 'none';
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const now = new Date();
    const diff = target - now;
    if (diff <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      if (onlineStatusPoller) { clearInterval(onlineStatusPoller); onlineStatusPoller = null; }
      overlay.style.display = 'none';
      document.querySelector('.container').style.display = 'block';
      return;
    }
    const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
    document.getElementById('countdownDisplay').textContent = h + ':' + m + ':' + s;
  }, 1000);
  startOnlineStatusPoller();
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
const SALON_PHONE = '624 14 36 58';
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
    const cancelledByClient = a._deleted && a.cancelledBy === 'client';
    const cancelledBySalon = a.cancelledBy === 'salon';
    const modifiedBySalon = !!a.salonModified && !cancelledBySalon && !cancelledByClient;
    const pendingClientMod = !!a.clientModified && !cancelledBySalon && !cancelledByClient;
    let cardClass = 'appt-card';
    if (isPast) cardClass += ' appt-past';
    if (cancelledByClient) cardClass += ' appt-cancelled';
    if (cancelledBySalon) cardClass += ' appt-cancelled-by-salon';
    if (modifiedBySalon) cardClass += ' appt-modified-by-salon';
    const timeColor = modifiedBySalon ? 'color:#e74c3c;' : '';
    return '<div class="'+cardClass+'">'+
      '<div class="appt-card-date">'+
        '<span class="appt-card-day" style="'+timeColor+'">'+esc(fmtDate(a.date))+'</span>'+
        '<span class="appt-card-time" style="'+timeColor+'">'+esc(a.time)+(a.endTime ? ' - '+esc(a.endTime) : '')+'</span>'+
        '<div class="appt-cal-tooltip">'+miniCalendar(a.date)+'</div>'+
      '</div>'+
      '<div class="appt-card-info">'+
        '<div class="appt-card-service">'+esc(a.serviceName)+'</div>'+
        (a.employeeName ? '<div class="appt-card-notes">👤 '+esc(a.employeeName)+'</div>' : '')+
        (a.notes?'<div class="appt-card-notes">'+esc(a.notes)+'</div>':'')+
        (cancelledByClient ? '<div style="color:#e74c3c;font-weight:600;margin-top:4px;">Cancelada por ti</div>' : '')+
        (modifiedBySalon ? '<div style="color:#e74c3c;font-weight:700;font-size:13px;margin-top:6px;">⚠️ Cita modificada por el salón</div>' : '')+
        (pendingClientMod ? '<div style="color:#f39c12;font-weight:600;font-size:13px;margin-top:6px;">⏳ Pendiente de aprobación del salón</div>'+
          '<div style="color:#f39c12;font-size:12px;margin-top:3px;">'+esc(a.date)+' '+esc(a.time)+' → '+esc(a.pendingDate||a.date)+' '+esc(a.pendingTime||a.time)+'</div>'+
          (a.pendingEmployeeId && a.employeeId !== a.pendingEmployeeId ? '<div style="color:#f39c12;font-size:12px;">👤 '+esc(a.employeeName||'?')+' → '+esc(a.pendingEmployeeName||'?')+'</div>' : '') : '')+
        (cancelledBySalon ? '<div style="color:#e74c3c;font-weight:700;font-size:13px;margin-top:6px;padding:6px 8px;border:1px solid #e74c3c;border-radius:6px;background:#fef2f2;">🚫 Esta cita ha sido anulada por el salón.<br><span style="font-weight:400;font-size:12px;">Contacto: <strong>'+SALON_PHONE+'</strong></span></div>' : '')+
      '</div>'+
      (!isPast && a.source==='online' && !cancelledByClient ? '<div class="appt-card-actions">'+
        (!cancelledBySalon && !modifiedBySalon && !pendingClientMod ? '<button class="btn btn-sm btn-secondary" onclick="modifyAppt(\''+a.id+'\')">Modificar</button>' : '')+
        (modifiedBySalon ? '<button class="btn btn-sm btn-success" onclick="acceptModification(\''+a.id+'\')">✔ Aceptar modificación</button>' : '')+
        '<button class="btn btn-sm '+(cancelledBySalon?'btn-success':'btn-danger')+'" onclick="cancelAppt(\''+a.id+'\')">'+
          (cancelledBySalon ? 'VISTO' : 'Cancelar')+'</button>'+
      '</div>' : '')+
    '</div>';
  }).join('');
}

async function acceptModification(id) {
  const appt = currentAppointments.find(a => a.id === id);
  if (!appt) return;
  if (!confirm('¿Aceptas la modificación realizada por el salón?')) return;
  showLoading(true);
  try {
    const r = await fetch(API+'/api/accept-modification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointmentId: id, phone: currentClient.phone })
    });
    const d = await r.json();
    if (!d.ok) { alert(d.error||'Error al aceptar'); showLoading(false); return; }
    showLoading(false);
    appt.salonModified = false;
    renderMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

async function cancelAppt(id) {
  const appt = currentAppointments.find(a => a.id === id);
  const isSalonCancelled = appt && appt.cancelledBy === 'salon';
  if (!confirm(isSalonCancelled ? '¿Confirmas la anulación del salón? La cita se eliminará definitivamente.' : '¿Estás seguro de cancelar esta cita?')) return;
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
    alert(isSalonCancelled ? 'Cita eliminada definitivamente' : 'Cita cancelada correctamente');
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
      if (!s) { html += '<td><div class="sq-cell sq-na"></div></td>'; return; }
      if (!s.available) { html += '<td><div class="sq-cell sq-occ"></div></td>'; return; }
      const isSelected = s.time === preSelectTime && !found;
      if (isSelected) { found = true; selectedModifySlot = { time: s.time, employeeId: s.employeeId }; }
      html += '<td class="sq-clickable" data-time="'+s.time+'" data-eid="'+s.employeeId+'" onclick="selectModifySlot(this)"><div class="sq-cell sq-free'+(isSelected?' selected':'')+'"></div></td>';
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
  if (appt.salonModified) {
    alert('Cita modificada por el Salón, ya no puede modificarla, si no le conviene puede cancelarla.');
    modifyingApptId = null;
    return;
  }
  if (appt.clientModified) {
    alert('Ya has solicitado una modificación que está pendiente de aprobación. Espera a que el salón la acepte o rechace.');
    modifyingApptId = null;
    return;
  }
  if ((appt.modificationCount||0) >= 1) {
    alert('Ya has modificado esta cita anteriormente. Solo puedes modificarla una vez.');
    modifyingApptId = null;
    return;
  }
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
  document.querySelectorAll('#modifySlots .sq-clickable .sq-free').forEach(c => c.classList.remove('selected'));
  const div = el.querySelector('.sq-free');
  if (div) div.classList.add('selected');
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
    alert('Solicitud de modificación enviada. El salón debe aprobarla para que el cambio sea efectivo.');
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
    const blockBadge = s.bloque === 'bloque1' ? '<span style="background:#27ae60;color:#fff;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">B1</span>' : (s.bloque === 'bloque2' ? '<span style="background:#f39c12;color:#fff;padding:1px 6px;border-radius:8px;font-size:10px;margin-left:4px;">B2</span>' : '');
    return '<div class="service-card" data-id="'+s.id+'" onclick="selectService(\''+s.id+'\')">'+
      '<span class="s-color" style="background:'+sc+';"></span>'+
      '<div class="s-info">'+
        '<div class="s-name">'+esc(s.name)+blockBadge+'</div>'+
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
  document.getElementById('selectedService').textContent = 'Servicio: '+(selectedService?selectedService.name:'')+' (ID: '+selectedService.id+') | '+cur(selectedService?selectedService.price:0)+(selectedService&&selectedService.duration?' &middot; '+selectedService.duration+' min':'');
  goStep(3);
  fetchSlots();
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
      if (!s) { html += '<td><div class="sq-cell sq-na"></div></td>'; return; }
      if (!s.available) { html += '<td><div class="sq-cell sq-occ"></div></td>'; return; }
      html += '<td class="sq-clickable" data-time="'+t+'" data-eid="'+eid+'" data-ename="'+escAttr(empMap[eid])+'" onclick="selectSlotFromTable(this)"><div class="sq-cell sq-free"></div></td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function selectSlotFromTable(el) {
  document.querySelectorAll('.sq-clickable .sq-free').forEach(c => c.classList.remove('selected'));
  const div = el.querySelector('.sq-free');
  if (div) div.classList.add('selected');
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
      if (d.emailSent) extra = '✅ Te hemos enviado un email con los detalles.<br><br>';
      extra += '💬 <a href="' + waLink + '" target="_blank" style="color:#25D366;font-weight:600;">Recibir aviso por WhatsApp</a>';
      document.getElementById('doneMsg').innerHTML = 'Tu cita ha sido enviada al salón y está <strong>pendiente de confirmación</strong>.<br><br>📅 <strong>'+fmtDate(selectedDate)+'</strong> a las <strong>'+selectedSlot.time+'</strong>'+(selectedSlot.employeeName?' con <strong>'+selectedSlot.employeeName+'</strong>':'')+'.<br><br>'+extra;
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