const API = window.location.origin;
const MAX_BOOKING_DAYS_AHEAD = 3;
let services = [], sections = [], employees = [], allClients = [];
let selectedServices = [], selectedDate = '', selectedSlot = null;
let currentClient = null, currentAppointments = [];
let modifyingApptId = null;
let countdownTimer = null;
let onlineStatusPoller = null;

function maxBookingDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + MAX_BOOKING_DAYS_AHEAD);
  return madridDateStr(d);
}

function showLoading(v) { document.getElementById('loadingOverlay').style.display = v ? 'flex' : 'none'; }

function madridDateStr(d) {
  const dt = d || new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
}

function getOpeningHoursForDay(dateStr, settings) {
  const DEFAULT_HOURS = {
    0: { open: '09:00', close: '14:00', closed: true },
    1: { open: '09:00', close: '14:00', closed: true },
    2: { open: '09:30', close: '20:30', closed: false },
    3: { open: '09:30', close: '20:30', closed: false },
    4: { open: '09:30', close: '20:30', closed: false },
    5: { open: '09:30', close: '20:30', closed: false },
    6: { open: '09:30', close: '14:00', closed: false }
  };
  if (!settings || !settings.openingHours) {
    const d = new Date(dateStr + 'T12:00:00').getDay();
    const def = DEFAULT_HOURS[d] || { open: '09:00', close: '19:00', closed: false };
    return { open: parseInt(def.open) + (parseInt(def.open.split(':')[1])||0)/60, close: parseInt(def.close) + (parseInt(def.close.split(':')[1])||0)/60, closed: def.closed };
  }
  const d = new Date(dateStr + 'T12:00:00').getDay();
  const day = settings.openingHours[d] || DEFAULT_HOURS[d] || { open: '09:00', close: '19:00', closed: false };
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
    const r = await fetch(API + '/api/booking-info');
    const d = await r.json();
    services = (d.services||[]).filter(s => !s._deleted);
    sections = (d.sections||[]).filter(s => !s._deleted);
    employees = (d.employees||[]).filter(e => !e._deleted);
    allClients = (d.clients||[]).filter(c => !c._deleted);
    const settings = d.settings || {};
    document.getElementById('footerInfo').textContent = settings.businessName || 'Nymara Estilistas';
    const today = madridDateStr();
    const dayCfg = (settings.onlineOpening || {})[today] || {};
    const openingTime = dayCfg.time || '18:00';
    checkOpeningTime(openingTime, dayCfg.enabled === true);
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
      const overlay = document.getElementById('openingCountdown');
      const isClosedView = overlay && overlay.style.display === 'flex';
      if (!d.enabled) {
        if (!isClosedView) location.reload();
        return;
      }
      const now = new Date();
      const [h, m] = (d.openingTime || '18:00').split(':').map(Number);
      const opening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      if (isClosedView && now >= opening) location.reload();
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
function togglePW(inputId, el) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  if (inp.type === 'password') { inp.type = 'text'; el.textContent = '🙈'; }
  else { inp.type = 'password'; el.textContent = '👁'; }
}

async function loginClient() {
  const phone = document.getElementById('loginPhone').value.trim();
  const pw = document.getElementById('loginPassword').value;
  if (!phone || !pw) { alert('Teléfono y contraseña son obligatorios'); return; }
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password: pw })
    });
    if (r.status === 404) { alert('Teléfono o contraseña incorrectos'); showLoading(false); return; }
    const d = await r.json();
    if (!d.ok) { alert(d.error||'Error al iniciar sesión'); showLoading(false); return; }
    if (d.needsProfileCompletion) {
      currentClient = d.client;
      showLoading(false);
      const hint = document.getElementById('completeEmailHint');
      if (d.client.email) {
        document.getElementById('completeEmail').value = d.client.email;
        hint.textContent = 'Tu email ya está registrado: '+d.client.email+'. Solo tienes que crear una contraseña.';
        hint.style.display = 'block';
      } else {
        document.getElementById('completeEmail').value = '';
        hint.style.display = 'none';
      }
      document.getElementById('completePassword').value = '';
      document.getElementById('completePassword2').value = '';
      document.getElementById('completeError').style.display = 'none';
      document.getElementById('completeProfileModal').style.display = 'flex';
      return;
    }
    currentClient = d.client;
    currentAppointments = d.appointments;
    showLoading(false);
    renderMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

async function registerClient() {
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const pw = document.getElementById('regPassword').value;
  if (!name || !phone || !email || !pw) { alert('Todos los campos son obligatorios'); return; }
  if (pw.length < 8) { alert('La contraseña debe tener al menos 8 caracteres'); return; }
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, email, password: pw })
    });
    const d = await r.json();
    if (!d.ok) { alert(d.error||'Error al registrarse'); showLoading(false); return; }
    currentClient = d.client;
    currentAppointments = [];
    showLoading(false);
    renderMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

// === PASSWORD RECOVERY ===
async function showRecovery() {
  const phone = document.getElementById('loginPhone').value.trim();
  const err = document.getElementById('recoveryError');
  err.style.display = 'none';
  if (!phone) {
    // Sin teléfono: NO abrir el modal, pedir que lo introduzca primero
    document.getElementById('loginPhone').focus();
    document.getElementById('loginPhone').style.border = '2px solid #e74c3c';
    setTimeout(() => { document.getElementById('loginPhone').style.border = ''; }, 3000);
    alert('Introduce primero tu teléfono en el formulario de acceso para recuperar la contraseña');
    return;
  }
  // Preparar modal antes de buscar
  const emailInput = document.getElementById('recoveryEmail');
  emailInput.value = '';
  emailInput.readOnly = false;
  emailInput.style.background = '';
  document.getElementById('recoveryStep1').style.display = 'block';
  document.getElementById('recoveryStep2').style.display = 'none';
  document.getElementById('recoveryError').style.display = 'none';
  document.getElementById('recoveryError2').style.display = 'none';
  document.getElementById('recoverySuccess').style.display = 'none';
  const sendBtn = document.getElementById('recoverySendBtn');
  if (sendBtn) sendBtn.style.display = 'block';
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client?phone='+encodeURIComponent(phone));
    showLoading(false);
    if (r.status === 404) {
      err.textContent = 'No existe ninguna cuenta con ese teléfono';
      err.style.display = 'block';
      if (sendBtn) sendBtn.style.display = 'none';
      document.getElementById('recoveryModal').style.display = 'flex';
      return;
    }
    const d = await r.json();
    if (!d.ok) {
      err.textContent = d.error||'Error';
      err.style.display = 'block';
      if (sendBtn) sendBtn.style.display = 'none';
      document.getElementById('recoveryModal').style.display = 'flex';
      return;
    }
    const email = (d.client && d.client.email) || '';
    if (email) {
      // Pre-rellenar el email del cliente
      emailInput.value = email;
      emailInput.readOnly = true;
      emailInput.style.background = '#f0f0f0';
      if (sendBtn) sendBtn.style.display = 'block';
    } else {
      // Sin email: mostrar mensaje y ocultar botón de envío
      emailInput.value = '';
      emailInput.readOnly = true;
      emailInput.style.background = '#f0f0f0';
      err.textContent = 'Tu cuenta no tiene email asociado. Contacta con la peluquería en el teléfono 624 14 36 58 para recuperar tu contraseña.';
      err.style.display = 'block';
      if (sendBtn) sendBtn.style.display = 'none';
    }
    document.getElementById('recoveryModal').style.display = 'flex';
  } catch(e) {
    showLoading(false);
    err.textContent = 'Error de conexión';
    err.style.display = 'block';
    if (sendBtn) sendBtn.style.display = 'none';
    document.getElementById('recoveryModal').style.display = 'flex';
  }
}
function closeRecovery() {
  document.getElementById('recoveryModal').style.display = 'none';
  document.getElementById('recoveryStep1').style.display = 'block';
  document.getElementById('recoveryStep2').style.display = 'none';
  document.getElementById('recoveryError').style.display = 'none';
  document.getElementById('recoveryError2').style.display = 'none';
  document.getElementById('recoverySuccess').style.display = 'none';
  const emailInput = document.getElementById('recoveryEmail');
  emailInput.value = '';
  emailInput.readOnly = false;
  emailInput.style.background = '';
  const sendBtn = document.getElementById('recoverySendBtn');
  if (sendBtn) sendBtn.style.display = 'block';
}

async function sendRecoveryCode() {
  const email = document.getElementById('recoveryEmail').value.trim();
  if (!email) { alert('Introduce tu email'); return; }
  const err = document.getElementById('recoveryError');
  err.style.display = 'none';
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client/recover-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const d = await r.json();
    if (!d.ok) { err.textContent = d.error||'Error'; err.style.display = 'block'; showLoading(false); return; }
    if (d.emailSent === false) { err.textContent = d.detail ? ('No se pudo enviar el email: '+d.detail) : 'No se pudo enviar el email. Inténtalo de nuevo en unos minutos.'; err.style.display = 'block'; showLoading(false); return; }
    showLoading(false);
    document.getElementById('recoveryStep1').style.display = 'none';
    document.getElementById('recoveryStep2').style.display = 'block';
  } catch(e) { err.textContent = 'Error de conexión'; err.style.display = 'block'; showLoading(false); }
}

async function resetPassword() {
  const email = document.getElementById('recoveryEmail').value.trim();
  const code = document.getElementById('recoveryCode').value.trim();
  const newPw = document.getElementById('recoveryNewPW').value;
  const err = document.getElementById('recoveryError2');
  const success = document.getElementById('recoverySuccess');
  err.style.display = 'none'; success.style.display = 'none';
  if (!code || !newPw) { alert('Código y nueva contraseña son obligatorios'); return; }
  if (newPw.length < 8) { alert('La contraseña debe tener al menos 8 caracteres'); return; }
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, newPassword: newPw })
    });
    const d = await r.json();
    if (!d.ok) { err.textContent = d.error||'Error'; err.style.display = 'block'; showLoading(false); return; }
    showLoading(false);
    success.textContent = 'Contraseña cambiada correctamente. Ya puedes iniciar sesión.';
    success.style.display = 'block';
    document.getElementById('recoveryCode').value = '';
    document.getElementById('recoveryNewPW').value = '';
    setTimeout(() => { closeRecovery(); }, 2000);
  } catch(e) { err.textContent = 'Error de conexión'; err.style.display = 'block'; showLoading(false); }
}

// === COMPLETE PROFILE (for legacy clients) ===
function closeCompleteProfile() { document.getElementById('completeProfileModal').style.display = 'none'; }

async function completeClientProfile() {
  const phone = currentClient ? currentClient.phone : '';
  const email = document.getElementById('completeEmail').value.trim();
  const pw = document.getElementById('completePassword').value;
  const pw2 = document.getElementById('completePassword2').value;
  if (!pw || !pw2) { alert('La contraseña es obligatoria'); return; }
  if (pw.length < 8) { alert('La contraseña debe tener al menos 8 caracteres'); return; }
  if (pw !== pw2) { alert('Las contraseñas no coinciden'); return; }
  if (!phone) { alert('Error: número de teléfono no disponible'); return; }
  showLoading(true);
  try {
    const r = await fetch(API+'/api/client/complete-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, email, password: pw })
    });
    const d = await r.json();
    if (!d.ok) {
      document.getElementById('completeError').textContent = d.error||'Error al guardar';
      document.getElementById('completeError').style.display = 'block';
      showLoading(false); return;
    }
    currentClient = d.client;
    closeCompleteProfile();
    showLoading(false);
    alert('Perfil completado correctamente. Ya puedes usar email y contraseña para acceder.');
  } catch(e) { document.getElementById('completeError').textContent = 'Error de conexión'; document.getElementById('completeError').style.display = 'block'; showLoading(false); }
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
  const today = madridDateStr();
  div.innerHTML = currentAppointments.map(a => {
    const isPast = a.date < today;
    const cancelledByClient = a._deleted && a.cancelledBy === 'client';
    const cancelledBySalon = a.cancelledBy === 'salon';
    const modifiedBySalon = !!a.salonModified && !cancelledBySalon && !cancelledByClient;
    const pendingClientMod = !!a.clientModified && !cancelledBySalon && !cancelledByClient;
    const pendingSalonConfirm = !!a.pendingSalonConfirm && !cancelledBySalon && !cancelledByClient && !modifiedBySalon;
    let cardClass = 'appt-card';
    if (isPast) cardClass += ' appt-past';
    if (cancelledByClient) cardClass += ' appt-cancelled';
    if (cancelledBySalon) cardClass += ' appt-cancelled-by-salon';
    if (modifiedBySalon) cardClass += ' appt-modified-by-salon';
    if (pendingSalonConfirm) cardClass += ' appt-pending-salon';
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
        (a.notes ? '<div class="appt-card-notes">'+esc(a.notes)+'</div>' : '')+ 
        (cancelledByClient ? '<div style="color:#e74c3c;font-weight:600;margin-top:4px;">Cancelada por ti</div>' : '')+ 
        (modifiedBySalon ? '<div style="color:#e74c3c;font-weight:700;font-size:13px;margin-top:6px;">⚠️ Cita modificada por el salón</div>' : '')+ 
        (pendingClientMod ? '<div style="color:#f39c12;font-weight:600;font-size:13px;margin-top:6px;">⏳ Pendiente de aprobación del salón</div>'+
          '<div style="color:#f39c12;font-size:12px;margin-top:3px;">'+esc(a.date)+' '+esc(a.time)+' → '+esc(a.pendingDate||a.date)+' '+esc(a.pendingTime||a.time)+'</div>'+
          (a.pendingEmployeeId && a.employeeId !== a.pendingEmployeeId ? '<div style="color:#f39c12;font-size:12px;">👤 '+esc(a.employeeName||'?')+' → '+esc(a.pendingEmployeeName||'?')+'</div>' : '') : '')+ 
        (pendingSalonConfirm ? '<div style="color:#e74c3c;font-weight:700;font-size:13px;margin-top:6px;padding:6px 8px;border:1px solid #e74c3c;border-radius:6px;background:#fef2f2;">⏳ Cita pendiente de confirmar por el Salon</div>' : '')+ 
        (cancelledBySalon ? '<div style="color:#e74c3c;font-weight:700;font-size:13px;margin-top:6px;padding:6px 8px;border:1px solid #e74c3c;border-radius:6px;background:#fef2f2;">🚫 Esta cita ha sido anulada por el salón.<br><span style="font-weight:400;font-size:12px;">Contacto: <strong>'+SALON_PHONE+'</strong></span></div>' : '')+ 
      '</div>'+ 
      ((cancelledByClient || cancelledBySalon || (!isPast && a.source==='online' && !pendingSalonConfirm)) ? '<div class="appt-card-actions">'+ 
        (!cancelledBySalon && !cancelledByClient && !modifiedBySalon && !pendingClientMod && !isPast ? '<button class="btn btn-sm btn-secondary" onclick="modifyAppt(\''+a.id+'\')">Modificar</button>' : '')+ 
        (modifiedBySalon ? '<button class="btn btn-sm btn-success" onclick="acceptModification(\''+a.id+'\')">✔ Aceptar modificación</button>' : '')+
        ((cancelledByClient || cancelledBySalon) ? '<button class="btn btn-sm btn-success" onclick="dismissCancelledAppt(\''+a.id+'\')">VISTO</button>' :
        (!isPast && a.source==='online' ? '<button class="btn btn-sm btn-danger" onclick="cancelAppt(\''+a.id+'\')">Cancelar</button>' : ''))+
      '</div>' : '')+ 
    '</div>';
  }).join('');
}

async function cancelAppt(id) {
  const appt = currentAppointments.find(a => a.id === id);
  const isSalonCancelled = appt && appt.cancelledBy === 'salon';
  if (isSalonCancelled) {
    if (!confirm('¿Has leído el aviso?')) return;
  } else {
    if (!confirm('¿Estás seguro de cancelar esta cita?')) return;
  }
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
    if (isSalonCancelled || (appt && appt.blockGroupId)) {
      const gid = appt ? appt.blockGroupId : null;
      currentAppointments = currentAppointments.filter(a => a.id !== id && (!gid || a.blockGroupId !== gid));
      renderMyAppts();
    } else {
      appt._deleted = true;
      appt.cancelledBy = 'client';
      renderMyAppts();
    }
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
}

async function dismissCancelledAppt(id) {
  const appt = currentAppointments.find(a => a.id === id);
  if (!appt) return;
  showLoading(true);
  try {
    const r = await fetch(API+'/api/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointmentId: id, phone: currentClient.phone })
    });
    const d = await r.json();
    if (!d.ok) { alert(d.error||'Error al marcar como visto'); showLoading(false); return; }
    showLoading(false);
    currentAppointments = currentAppointments.filter(a => a.id !== id);
    renderMyAppts();
  } catch(e) { alert('Error: '+e.message); showLoading(false); }
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
  dateInput.min = madridDateStr(tomorrow);
  dateInput.max = maxBookingDateStr();
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
  selectedServices = []; selectedSlot = null;
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('clientName').value = currentClient.name;
  document.getElementById('clientPhone').value = currentClient.phone;
  document.getElementById('clientEmail').value = currentClient.email || '';
  document.getElementById('bookingNotes').value = '';
  document.getElementById('confirmBtn').disabled = false;
  document.getElementById('confirmBtn').textContent = 'Confirmar Reserva';
  const secSel = document.getElementById('apptSection');
  if (secSel) {
    secSel.innerHTML = '<option value="">Todas las secciones</option>' + sections.map(s => '<option value="'+s.id+'">'+esc(s.name)+'</option>').join('');
    secSel.value = '';
  }
  document.getElementById('searchService').value = '';
  document.getElementById('serviceDropdown').style.display = 'none';
  renderSelectedServices();
  document.getElementById('continueToDateBtn').disabled = true;
  goStep(2);
}

function getFilteredServices() {
  let list = services;
  const secSel = document.getElementById('apptSection');
  const secId = secSel ? secSel.value : '';
  if (secId) list = list.filter(s => s.sectionId === secId);
  const q = document.getElementById('searchService').value.toLowerCase();
  if (q) list = list.filter(s => s.name.toLowerCase().includes(q));
  return list;
}

function onSectionChange() {
  document.getElementById('searchService').value = '';
  renderServiceDropdown('');
}

function renderServiceDropdown(q) {
  const dd = document.getElementById('serviceDropdown');
  let list = getFilteredServices();
  if (q) list = list.filter(s => s.name.toLowerCase().includes(q.toLowerCase()));
  list = list.filter(s => !selectedServices.find(x => x.id === s.id));
  if (!list.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = list.map(s => {
    const sec = sections.find(x => x.id === s.sectionId);
    const sc = sec && sec.color ? sec.color : '#999';
    return '<div class="service-dropdown-item" data-id="'+s.id+'" onclick="addSelectedService(\''+s.id+'\')">'+
      '<span class="s-color-dot" style="background:'+sc+';"></span>'+
      '<span class="s-name">'+esc(s.name)+'</span>'+
      '<span class="s-price">'+cur(s.price)+'</span>'+
    '</div>';
  }).join('');
  dd.style.display = 'block';
}

function onSearchServiceInput() {
  renderServiceDropdown(document.getElementById('searchService').value);
}

function onSearchServiceFocus() {
  renderServiceDropdown(document.getElementById('searchService').value);
}

function addSelectedService(id) {
  if (!id) return;
  const svc = services.find(s => s.id === id);
  if (!svc) return;
  if (selectedServices.find(s => s.id === id)) return;
  selectedServices.push(svc);
  document.getElementById('searchService').value = '';
  document.getElementById('serviceDropdown').style.display = 'none';
  renderSelectedServices();
  renderBlock2Combo();
  document.getElementById('continueToDateBtn').disabled = selectedServices.length === 0;
}

function removeService(idx) {
  selectedServices.splice(idx, 1);
  renderSelectedServices();
  renderBlock2Combo();
  document.getElementById('continueToDateBtn').disabled = selectedServices.length === 0;
}

function renderBlock2Combo() {
  const sec = document.getElementById('block2Section');
  const combo = document.getElementById('block2Combo');
  const warn = document.getElementById('block2Warning');
  const err = document.getElementById('block2Error');
  const bloque1Svcs = selectedServices.filter(s => s.bloque === 'bloque1' || !s.bloque);
  const hasBloque1 = bloque1Svcs.length > 0;
  if (!hasBloque1) { sec.style.display = 'none'; return; }

  const alreadySelected = selectedServices.filter(s => s.bloque === 'bloque2').map(s => s.id);
  const block2Available = services.filter(s => !s._deleted && s.bloque === 'bloque2' && !alreadySelected.includes(s.id));

  if (!block2Available.length) { sec.style.display = 'none'; return; }

  sec.style.display = 'block';
  warn.innerHTML = '⚠️ Has seleccionado un servicio del Bloque 1. Debes completar con <strong>uno o más servicios del Bloque 2</strong> como mínimo, incluyendo un <strong>lavado</strong>.';
  combo.innerHTML = '<option value="">Selecciona servicio(s) del Bloque 2...</option>' +
    block2Available.map(s => '<option value="'+s.id+'">'+esc(s.name)+(s.price?' — '+cur(s.price):'')+'</option>').join('');
  err.style.display = 'none';
}

function addBlock2FromCombo() {
  const combo = document.getElementById('block2Combo');
  const id = combo.value;
  if (!id) return;
  const svc = services.find(s => s.id === id);
  if (!svc || selectedServices.find(s => s.id === id)) { combo.value = ''; return; }
  selectedServices.push(svc);
  combo.value = '';
  renderSelectedServices();
  renderBlock2Combo();
}

function renderSelectedServices() {
  const div = document.getElementById('selectedServicesList');
  if (!selectedServices.length) {
    div.innerHTML = '<p style="font-size:13px;color:var(--text-light);">Ningún servicio seleccionado</p>';
    return;
  }
  div.innerHTML = selectedServices.map((s, i) => {
    const sec = sections.find(x => x.id === s.sectionId);
    const sc = sec && sec.color ? sec.color : '#999';
    return '<span class="svc-tag"><span class="svc-color" style="background:'+sc+';"></span>'+esc(s.name)+' <strong>'+cur(s.price)+'</strong><span class="svc-remove" onclick="removeService('+i+')">&times;</span></span>';
  }).join('');
}

function goToDateStep() {
  if (!selectedServices.length) return;
  const bloque1Svcs = selectedServices.filter(s => s.bloque === 'bloque1' || !s.bloque);
  const bloque2Svcs = selectedServices.filter(s => s.bloque === 'bloque2');

  if (bloque1Svcs.length > 0 && bloque2Svcs.length === 0) {
    document.getElementById('block2Error').textContent = 'Debes seleccionar al menos un servicio del Bloque 2.';
    document.getElementById('block2Error').style.display = 'block';
    return;
  }
  if (bloque1Svcs.length > 0 && bloque2Svcs.length > 0) {
    const hasLavado = bloque2Svcs.some(s => (s.name || '').toLowerCase().startsWith('lavado'));
    if (!hasLavado) {
      document.getElementById('block2Error').textContent = 'Debes incluir al menos un lavado (servicio que comience por "Lavado") en el Bloque 2.';
      document.getElementById('block2Error').style.display = 'block';
      return;
    }
  }

  document.getElementById('block2Error').style.display = 'none';
  selectedSlot = null; selectedDate = '';
  let info = 'Servicios: '+selectedServices.map(s=>s.name+' ('+s.id+')').join(', ');
  if (bloque1Svcs.length && bloque2Svcs.length) {
    const gap = 45;
    const b1Dur = bloque1Svcs.reduce((sum, s) => sum + (s.duration || 30), 0);
    info = '<strong>Primera cita:</strong> '+bloque1Svcs.map(s=>s.name).join(', ')+' ('+b1Dur+' min)<br>'+
      '<strong>Hueco entre servicios:</strong> '+gap+' min<br>'+
      '<strong>Segunda cita:</strong> '+bloque2Svcs.map(s=>s.name).join(', ')+' ('+bloque2Svcs.reduce((sum,s)=>sum+(s.duration||30),0)+' min)';
  }
  document.getElementById('selectedService').innerHTML = info;
  document.getElementById('selectedSlot').textContent = '';
  const bookingDateEl = document.getElementById('bookingDate');
  bookingDateEl.value = '';
  bookingDateEl.min = madridDateStr();
  bookingDateEl.max = maxBookingDateStr();
  document.getElementById('noSlots').style.display = 'none';
  document.getElementById('slotsContainer').innerHTML = '';
  goStep(3);
}

// Close dropdown on click outside
document.addEventListener('click', function(e) {
  const dd = document.getElementById('serviceDropdown');
  const sb = document.getElementById('searchService');
  if (dd && sb && !sb.contains(e.target) && !dd.contains(e.target)) {
    dd.style.display = 'none';
  }
});

function onDateChange() {
  selectedDate = document.getElementById('bookingDate').value;
  if (!selectedServices.length) return;
  selectedSlot = null;
  document.getElementById('selectedSlot').textContent = '';
  document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
  fetchSlots();
}

async function fetchSlots() {
  if (!selectedServices.length || !selectedDate) return;
  showLoading(true);
  try {
    const params = '?date='+encodeURIComponent(selectedDate)+'&serviceIds='+selectedServices.map(s=>encodeURIComponent(s.id)).join(',');
    const r = await fetch(API+'/api/slots'+params);
    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      throw new Error(errData.error || 'HTTP ' + r.status);
    }
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
  if (!selectedServices.length || !selectedSlot) { div.innerHTML = ''; return; }
  const total = selectedServices.reduce((sum, s) => sum + parseFloat(s.price || 0), 0);
  div.innerHTML = '<strong>Resumen</strong><br>'+
    'Servicios: '+selectedServices.map(s=>esc(s.name)).join(', ')+'<br>'+
    'Fecha: '+fmtDate(selectedDate)+'<br>'+
    'Horario: '+selectedSlot.time+(selectedSlot.employeeName?' con '+selectedSlot.employeeName:'')+'<br>'+
    '<strong>Total: '+cur(total)+'</strong>';
}

async function confirmBooking() {
  if (!selectedServices.length || !selectedSlot) { alert('Selecciona servicio y horario'); return; }

  document.getElementById('confirmBtn').disabled = true;
  document.getElementById('confirmBtn').textContent = 'Reservando...';
  showLoading(true);
  try {
    const r = await fetch(API+'/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceIds: selectedServices.map(s => s.id),
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
      if (d.cleanedCount) {
        currentAppointments = currentAppointments.filter(a => a.cancelledBy !== 'salon');
      }
      goStep(5);
      const svcNames = selectedServices.map(s => s.name).join(', ');
      const times = (d.apptTimes && d.apptTimes.length > 1) ? d.apptTimes.join(' y ') : selectedSlot.time;
      const waMsg = 'Hola!%20Tu%20cita%20en%20Nymara%20Estilistas%20ha%20sido%20solicitada%20para%20el%20' + encodeURIComponent(selectedDate) + '%20a%20las%20' + encodeURIComponent(times) + '.%20Estamos%20revis%C3%A1ndola%20y%20te%20confirmaremos%20pronto.';
      const waPhone = (currentClient.phone||'').replace(/[^0-9]/g,'');
      const waLink = 'https://wa.me/34' + waPhone + '?text=' + waMsg;
      let extra = '';
      if (d.emailSent) extra = '✅ Te hemos enviado un email con los detalles.<br><br>';
      extra += '💬 <a href="' + waLink + '" target="_blank" style="color:#25D366;font-weight:600;">Recibir aviso por WhatsApp</a>';
      let msg = 'Tu cita ha sido enviada al salón y está <strong>pendiente de confirmación</strong>.<br><br>📅 <strong>'+fmtDate(selectedDate)+'</strong> a las <strong>'+times+'</strong>'+(selectedSlot.employeeName?' con <strong>'+selectedSlot.employeeName+'</strong>':'')+'.<br><br>'+
        '✂️ '+esc(svcNames)+'<br><br>'+extra;
      if (d.apptTimes && d.apptTimes.length > 1) {
        const bloque1Svcs = selectedServices.filter(s => s.bloque === 'bloque1' || !s.bloque).map(s=>s.name).join(', ');
        const bloque2Svcs = selectedServices.filter(s => s.bloque === 'bloque2').map(s=>s.name).join(', ');
        msg = 'Tus citas han sido enviadas al salón y están <strong>pendientes de confirmación</strong>.<br><br>📅 <strong>'+fmtDate(selectedDate)+'</strong>:<br>'+
          '• <strong>'+d.apptTimes[0]+'</strong> — '+esc(bloque1Svcs)+'<br>'+
          '• <strong>'+d.apptTimes[1]+'</strong> — '+esc(bloque2Svcs)+'<br><br>'+
          (selectedSlot.employeeName?'Con <strong>'+selectedSlot.employeeName+'</strong><br><br>':'')+
          extra;
      }
      document.getElementById('doneMsg').innerHTML = msg;
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
  selectedServices = []; selectedSlot = null;
  document.getElementById('loginPhone').value = '';
  document.getElementById('regName').value = '';
  document.getElementById('regPhone').value = '';
  goStep(0);
}

loadData();
startOnlineStatusPoller();