const API = window.location.origin;
let services = [], sections = [], employees = [], clients = [];
let selectedService = null, selectedDate = '', selectedSlot = null;

function showLoading(v) { document.getElementById('loadingOverlay').style.display = v ? 'flex' : 'none'; }

function goStep(n) {
  document.querySelectorAll('.step-indicator .step').forEach((s,i) => { s.classList.toggle('active', i+1===n); s.classList.toggle('done', i+1<n); });
  document.querySelectorAll('.step-content').forEach((s,i) => s.classList.toggle('active', i+1===n));
}

async function loadData() {
  showLoading(true);
  try {
    const r = await fetch(API + '/sync');
    const d = await r.json();
    services = (d.services||[]).filter(s => !s._deleted);
    sections = (d.sections||[]).filter(s => !s._deleted);
    employees = (d.employees||[]).filter(e => !e._deleted);
    clients = (d.clients||[]).filter(c => !c._deleted);

    const settings = d.settings || {};
    if (settings.businessName) document.getElementById('businessName').textContent = settings.businessName;
    document.getElementById('businessSub').textContent = 'Elige tu servicio y confirma tu cita';
    document.getElementById('footerInfo').textContent = settings.businessName || 'Reserva Online';

    renderServices();

    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
    document.getElementById('bookingDate').value = tomorrow.toISOString().split('T')[0];
    document.getElementById('bookingDate').min = tomorrow.toISOString().split('T')[0];
    selectedDate = document.getElementById('bookingDate').value;
  } catch(e) { alert('Error al cargar datos: '+e.message); }
  showLoading(false);
}

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function cur(n) { return parseFloat(n||0).toFixed(2)+'\u20AC'; }

function renderServices(q) {
  const div = document.getElementById('servicesList');
  let list = services;
  if (q) list = list.filter(s => s.name.toLowerCase().includes(q));
  if (!list.length) { div.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-light);">No hay servicios disponibles</div>'; return; }
  div.innerHTML = list.map(s => {
    const sec = sections.find(x => x.id === s.sectionId);
    const sc = sec && sec.color ? sec.color : '#999';
    return `<div class="service-card" data-id="${s.id}" onclick="selectService('${s.id}')">
      <span class="s-color" style="background:${sc};"></span>
      <div class="s-info">
        <div class="s-name">${esc(s.name)}</div>
        <div class="s-meta">${sec ? esc(sec.name) : ''}${s.duration ? ' · '+s.duration+' min' : ''}</div>
      </div>
      <div class="s-price">${cur(s.price)}</div>
    </div>`;
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
  document.getElementById('selectedService').textContent = 'Servicio: '+(selectedService?selectedService.name:'')+' | '+cur(selectedService?selectedService.price:0)+(selectedService&&selectedService.duration?' · '+selectedService.duration+' min':'');
  goStep(2);
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
  if (!slots.length) { container.innerHTML = ''; noSlots.style.display = 'block'; return; }
  noSlots.style.display = 'none';
  container.innerHTML = slots.map(s => {
    const empName = s.employeeName ? ' <span class="s-employee">'+esc(s.employeeName)+'</span>' : '';
    return '<button class="slot-btn" onclick="selectSlot(this,\''+s.time+'\',\''+s.employeeId+'\',\''+escAttr(s.employeeName||'')+'\')">'+s.time+empName+'</button>';
  }).join('');
}

function escAttr(s) { return s.replace(/'/g,'\\\'').replace(/"/g,'&quot;'); }

function selectSlot(el, time, employeeId, employeeName) {
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
  selectedSlot = { time, employeeId, employeeName };
  document.getElementById('selectedSlot').textContent = 'Horario: '+time+(employeeName?' con '+employeeName:'');
  goStep(3);
  updateSummary();
}

function updateSummary() {
  const div = document.getElementById('bookingSummary');
  if (!selectedService || !selectedSlot) { div.innerHTML = ''; return; }
  div.innerHTML = '<strong>Resumen</strong><br>'+
    'Servicio: '+esc(selectedService.name)+'<br>'+
    'Fecha: '+selectedDate+'<br>'+
    'Horario: '+selectedSlot.time+(selectedSlot.employeeName?' con '+selectedSlot.employeeName:'')+'<br>'+
    '<strong>Total: '+cur(selectedService.price)+'</strong>';
}

async function confirmBooking() {
  const name = document.getElementById('clientName').value.trim();
  const phone = document.getElementById('clientPhone').value.trim();
  if (!name || !phone) { alert('Nombre y teléfono son obligatorios'); return; }
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
        clientName: name,
        clientPhone: phone,
        clientEmail: document.getElementById('clientEmail').value.trim(),
        notes: document.getElementById('bookingNotes').value.trim()
      })
    });
    const d = await r.json();
    if (d.ok) {
      goStep(4);
      document.getElementById('doneMsg').innerHTML = 'Tu cita ha sido registrada para el <strong>'+selectedDate+'</strong> a las <strong>'+selectedSlot.time+'</strong>'+(selectedSlot.employeeName?' con <strong>'+selectedSlot.employeeName+'</strong>':'')+'.<br><br>📅 Aparecerá automáticamente en la agenda del TPV en unos segundos si la sincronización está activada.';
    } else {
      alert('Error: '+(d.error||'No se pudo reservar'));
      document.getElementById('confirmBtn').disabled = false;
      document.getElementById('confirmBtn').textContent = 'Confirmar Reserva';
    }
  } catch(e) { alert('Error de conexión: '+e.message); document.getElementById('confirmBtn').disabled = false; document.getElementById('confirmBtn').textContent = 'Confirmar Reserva'; }
  showLoading(false);
}

function resetBooking() {
  selectedService = null; selectedSlot = null;
  document.getElementById('clientName').value = '';
  document.getElementById('clientPhone').value = '';
  document.getElementById('clientEmail').value = '';
  document.getElementById('bookingNotes').value = '';
  document.getElementById('confirmBtn').disabled = false;
  document.getElementById('confirmBtn').textContent = 'Confirmar Reserva';
  document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  goStep(1);
}

loadData();