// patch-cancelled-salon.js - Adds salon-cancelled indicator to mini-calendar
const fs = require('fs');
const path = require('path');

const htmlFile = path.join(__dirname, '..', 'electron-app.html');
let content = fs.readFileSync(htmlFile, 'utf8');

// Both occurrences of the mini-calendar block (current month + next month filler cells)
// Pattern: after the appts filter line, before the hasOnline check
const OLD1 = `const hasOnline = appts.some(a => a.source === 'online');
    const hasPending = appts.some(a => getPendingType(a));
    html += \`<div class="agenda-day \${isToday?'today':''}`;

const NEW1 = `const hasOnline = appts.some(a => a.source === 'online');
    const hasPending = appts.some(a => getPendingType(a));
    const hasCancelledBySalon = (data.appointments || []).some(a => a && a.date === dateStr && a._deleted && a.cancelledBy === 'salon' && (a.source === 'online' || a.source === 'whatsapp'));
    html += \`<div class="agenda-day \${isToday?'today':''}`;

// Old day-num line
const OLD_DAYNUM = `      <div class="day-num">\${d}</div>`;
const NEW_DAYNUM = `      <div class="day-num">\${d}\${hasCancelledBySalon?'<span title="Cita online cancelada por salón" style="float:right;font-size:9px;color:#e74c3c;font-weight:700;">✕</span>':''}</div>`;

// Old class string (no cancelled-salon)
const OLD_CLASS = `\${hasOnline?' has-online':''}`;
const NEW_CLASS = `\${hasOnline?' has-online':''}\${hasCancelledBySalon?' has-cancelled-salon':''}`;

// Apply all patches
let patched = content;

// Patch 1: add hasCancelledBySalon variable declaration (both occurrences)
let count = 0;
while (patched.includes(OLD1)) {
  patched = patched.replace(OLD1, NEW1);
  count++;
}
console.log(`Patched hasCancelledBySalon declaration: ${count} times`);

// Patch 2: add class to div (both occurrences)  
// We need to handle the class string carefully - it appears multiple times
// So we only patch instances that already have hasCancelledBySalon nearby
const lines = patched.split('\n');
let newLines = [];
for (let i = 0; i < lines.length; i++) {
  let line = lines[i];
  // If previous few lines contain hasCancelledBySalon and this line has has-pending but not has-cancelled-salon
  const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
  if (context.includes('hasCancelledBySalon') && line.includes("has-pending':''") && !line.includes('has-cancelled-salon')) {
    line = line.replace(`\${hasPending?' has-pending':''}`, `\${hasPending?' has-pending':''}\${hasCancelledBySalon?' has-cancelled-salon':''}`);
    console.log(`Patched class at line ${i + 1}`);
  }
  // Patch day-num div if hasCancelledBySalon is in context
  if (context.includes('hasCancelledBySalon') && line.includes('<div class="day-num">${d}</div>') && !line.includes('hasCancelledBySalon')) {
    line = line.replace(
      '<div class="day-num">${d}</div>',
      '<div class="day-num">${d}${hasCancelledBySalon?\'<span title="Cita online cancelada por salón" style="float:right;font-size:9px;color:#e74c3c;font-weight:700;">✕</span>`:\'\'}</div>'
    );
    console.log(`Patched day-num at line ${i + 1}`);
  }
  newLines.push(line);
}
patched = newLines.join('\n');

fs.writeFileSync(htmlFile, patched, 'utf8');
console.log('Done!');
