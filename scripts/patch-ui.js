const fs = require('fs');
const f = 'electron-app.html';
let c = fs.readFileSync(f, 'utf8');

const regex1 = /const hasPending = appts\.some\(a => getPendingType\(a\)\);\s+html \+= `<div class="agenda-day \$\{isToday\?'today':''\}\$\{hasOnline\?' has-online':''\}\$\{hasPending\?' has-pending':''\}" onclick="showDayAppts\('\$\{dateStr\}'\)">\s+<div class="day-num">\$\{d\}<\/div>/g;

const replacement1 = `const hasPending = appts.some(a => getPendingType(a));
    const hasCancelledBySalon = (data.appointments || []).some(a => a && a.date === dateStr && a._deleted && a.cancelledBy === 'salon' && (a.source === 'online' || a.source === 'whatsapp'));
    html += \`<div class="agenda-day \${isToday?'today':''}\${hasOnline?' has-online':''}\${hasPending?' has-pending':''}\${hasCancelledBySalon?' has-cancelled-salon':''}" onclick="showDayAppts('\${dateStr}')">
      <div class="day-num">\${d}\${hasCancelledBySalon?'<span title="Cita online cancelada por salón" style="float:right;font-size:9px;color:#e74c3c;font-weight:700;">✕</span>':''}</div>`;

c = c.replace(regex1, replacement1);

const regex2 = /const hasPending = appts\.some\(a => getPendingType\(a\)\);\s+html \+= `<div class="agenda-day other-month\$\{hasOnline\?' has-online':''\}\$\{hasPending\?' has-pending':''\}" onclick="showDayAppts\('\$\{dateStr\}'\)">\s+<div class="day-num">\$\{i\}<\/div>/g;

const replacement2 = `const hasPending = appts.some(a => getPendingType(a));
    const hasCancelledBySalon = (data.appointments || []).some(a => a && a.date === dateStr && a._deleted && a.cancelledBy === 'salon' && (a.source === 'online' || a.source === 'whatsapp'));
    html += \`<div class="agenda-day other-month\${hasOnline?' has-online':''}\${hasPending?' has-pending':''}\${hasCancelledBySalon?' has-cancelled-salon':''}" onclick="showDayAppts('\${dateStr}')">
      <div class="day-num">\${i}\${hasCancelledBySalon?'<span title="Cita online cancelada por salón" style="float:right;font-size:9px;color:#e74c3c;font-weight:700;">✕</span>':''}</div>`;

c = c.replace(regex2, replacement2);

fs.writeFileSync(f, c);
console.log('Update finished.');
