
# fix-local-sync.ps1
# Fixes the local Access sync so it polls independently of the cloud,
# preventing exponential backoff from blocking local sync when there's no internet.

param(
    [string]$HtmlFile = ".\electron-app.html"
)

$html = [System.IO.File]::ReadAllText($HtmlFile, [System.Text.Encoding]::UTF8)

# ── PATCH 1: Replace syncPull ──────────────────────────────────────────────
# Old: single Promise.all that counts errors even when only local succeeds
# New: local-only pull always runs at 15s, cloud errors don't affect local backoff

$oldSyncPull = @'
function syncPull() {
  const c = getSyncCfg();
  if (!c.enabled) return;
  const localUrl = LOCAL_SYNC_URL.replace(/\/+$/,'') + '/sync';
  const cloudUrl = c.url.replace(/\/+$/,'') + '/sync';
  const status = document.getElementById('syncStatus');
  Promise.all([
    fetch(localUrl).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(cloudUrl).then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([localData, cloudData]) => {
    if (!localData && !cloudData) { syncErrorCount++; updateSyncErrorIndicator(); if (status) { status.textContent = '? Sync: sin conexi?n'; status.style.color = '#e74c3c'; setTimeout(() => { if (status) status.textContent = ''; }, 5000); } return; }
    syncErrorCount = 0;
    updateSyncErrorIndicator();
    if (syncErrorTimer) { clearTimeout(syncErrorTimer); syncErrorTimer = null; }
    if (status) { status.textContent = '? Sincronizado'; status.style.color = ''; status.style.fontWeight = ''; }
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    if (localData) mergeRemoteData(localData);
    if (cloudData) mergeRemoteData(cloudData);'@

$newSyncPull = @'
// LOCAL-ONLY pull — runs from the dedicated local poller (no backoff, no cloud dependency)
function syncPullLocal() {
  const localUrl = LOCAL_SYNC_URL.replace(/\/+$/,'') + '/sync';
  fetch(localUrl).then(r => r.ok ? r.json() : null).catch(() => null).then(localData => {
    if (!localData) { syncErrorCount++; updateSyncErrorIndicator(); return; }
    syncErrorCount = 0;
    updateSyncErrorIndicator();
    if (syncErrorTimer) { clearTimeout(syncErrorTimer); syncErrorTimer = null; }
    mergeRemoteData(localData);
    try {
      saveKey('services'); saveKey('sections'); saveKey('employees'); saveKey('products');
      saveKey('clients'); saveKey('projects'); saveKey('providers'); saveKey('appointments');
    } catch(e) { console.error('SAVE ERROR (local):', e); }
    const active = document.querySelector('.nav-item.active');
    if (active) {
      const sec = active.dataset.section;
      if (sec === 'agenda') renderAgenda();
      else if (sec === 'clients') renderClients();
      else if (sec === 'services') renderServices();
      else if (sec === 'sections') renderSections();
      else if (sec === 'employees') renderEmployees();
      else if (sec === 'products') { renderProducts(); renderWarehouse(); }
      else if (sec === 'projects') renderProjects();
      else if (sec === 'dashboard') renderDashboard();
    }
    const status = document.getElementById('syncStatus');
    if (status) { status.textContent = '✓ Sync local OK'; status.style.color = '#27ae60'; setTimeout(() => { if (status) status.textContent = ''; }, 2000); }
  });
}

function syncPull() {
  const c = getSyncCfg();
  if (!c.enabled) return;
  const localUrl = LOCAL_SYNC_URL.replace(/\/+$/,'') + '/sync';
  const cloudUrl = c.url.replace(/\/+$/,'') + '/sync';
  const status = document.getElementById('syncStatus');
  Promise.all([
    fetch(localUrl).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(cloudUrl).then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([localData, cloudData]) => {
    // Only count as error if BOTH local AND cloud fail
    if (!localData && !cloudData) { syncErrorCount++; updateSyncErrorIndicator(); if (status) { status.textContent = '⚠ Sync local: sin conexión'; status.style.color = '#e74c3c'; setTimeout(() => { if (status) status.textContent = ''; }, 5000); } return; }
    // If local works (even if cloud doesn't), reset error counter
    if (localData) { syncErrorCount = 0; updateSyncErrorIndicator(); if (syncErrorTimer) { clearTimeout(syncErrorTimer); syncErrorTimer = null; } }
    if (status) { status.textContent = localData ? '✓ Sincronizado' : '⚠ Solo cloud'; status.style.color = ''; status.style.fontWeight = ''; }
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
    if (localData) mergeRemoteData(localData);
    if (cloudData) mergeRemoteData(cloudData);'@

if ($html.Contains('function syncPull()')) {
    # We need to find the EXACT text. Due to encoding differences let's do a targeted find
    $idx = $html.IndexOf('function syncPull() {')
    if ($idx -ge 0) {
        Write-Host "Found syncPull at index $idx"
    } else {
        Write-Host "WARNING: syncPull not found exactly - trying alternate search"
    }
} else {
    Write-Host "WARNING: syncPull not found in file"
}

# ── PATCH 2: Replace scheduleSync to fix backoff (only backoff on local errors) ──
$oldSchedule = @'
function scheduleSync() {
  if (!getSyncCfg().enabled) return;
  if (!isInSyncTimeWindow()) {
    syncTimer = setTimeout(scheduleSync, 60000);
    return;
  }
  const base = 30000;
  const max = 300000;
  const backoff = syncErrorCount > 0
    ? Math.min(base * Math.pow(2, Math.min(syncErrorCount, 6)), max)
    : base;
  syncTimer = setTimeout(function syncTick() {
    syncPull();
    if (!isInSyncTimeWindow()) return;
    syncTimer = setTimeout(syncTick, syncErrorCount > 0
      ? Math.min(base * Math.pow(2, Math.min(syncErrorCount, 6)), max)
      : base);
  }, backoff);
}

function stopSyncPoller() { if (syncTimer) { clearTimeout(syncTimer); syncTimer = null } }
function startSyncPoller() { stopSyncPoller(); scheduleSync(); }'@

$newSchedule = @'
function scheduleSync() {
  if (!getSyncCfg().enabled) return;
  if (!isInSyncTimeWindow()) {
    syncTimer = setTimeout(scheduleSync, 60000);
    return;
  }
  // Cloud sync: 30s base, backoff only on real cloud errors (syncErrorCount counts cloud failures)
  const base = 30000;
  const max = 120000; // cap at 2 min instead of 5 min — local Access always works
  const backoff = syncErrorCount > 0
    ? Math.min(base * Math.pow(2, Math.min(syncErrorCount, 2)), max)
    : base;
  syncTimer = setTimeout(function syncTick() {
    syncPull();
    if (!isInSyncTimeWindow()) return;
    syncTimer = setTimeout(syncTick, syncErrorCount > 0
      ? Math.min(base * Math.pow(2, Math.min(syncErrorCount, 2)), max)
      : base);
  }, backoff);
}

function stopSyncPoller() { if (syncTimer) { clearTimeout(syncTimer); syncTimer = null } }
// Dedicated LOCAL Access poller — always every 15s, never backoff, no cloud dependency
let localAccessTimer = null;
function startLocalAccessPoller() {
  if (localAccessTimer) clearInterval(localAccessTimer);
  localAccessTimer = setInterval(syncPullLocal, 15000);
}
function stopLocalAccessPoller() { if (localAccessTimer) { clearInterval(localAccessTimer); localAccessTimer = null; } }
function startSyncPoller() { stopSyncPoller(); scheduleSync(); startLocalAccessPoller(); }'@

# ── PATCH 3: Also start local poller on init ──
$oldInitSync = '// Start sync on load
if (getSyncCfg().enabled) { syncPush(); syncPull(); }
startSyncPoller();'

$newInitSync = '// Start sync on load — local Access poller runs always (no internet required)
if (getSyncCfg().enabled) { syncPush(); syncPull(); }
startSyncPoller(); // starts both cloud poller + local access poller'

# Apply patches
$changed = $false

if ($html.Contains($oldSchedule)) {
    $html = $html.Replace($oldSchedule, $newSchedule)
    Write-Host "PATCH 2 (scheduleSync + startLocalAccessPoller): APPLIED"
    $changed = $true
} else {
    Write-Host "PATCH 2: target not found - checking fragments..."
    if ($html.Contains('const max = 300000;')) {
        Write-Host "  Found 'const max = 300000' - will do targeted replace"
        $html = $html.Replace('const max = 300000;', 'const max = 120000; // cap at 2 min - local Access always works via local poller')
        $html = $html.Replace('Math.min(syncErrorCount, 6)', 'Math.min(syncErrorCount, 2)')
        Write-Host "  Targeted fragments applied"
        $changed = $true
    }
    if ($html.Contains('function startSyncPoller() { stopSyncPoller(); scheduleSync(); }')) {
        $html = $html.Replace(
            'function startSyncPoller() { stopSyncPoller(); scheduleSync(); }',
            "let localAccessTimer = null;`nfunction startLocalAccessPoller() { if (localAccessTimer) clearInterval(localAccessTimer); localAccessTimer = setInterval(syncPullLocal, 15000); }`nfunction stopLocalAccessPoller() { if (localAccessTimer) { clearInterval(localAccessTimer); localAccessTimer = null; } }`nfunction startSyncPoller() { stopSyncPoller(); scheduleSync(); startLocalAccessPoller(); }"
        )
        Write-Host "  startSyncPoller patch applied"
        $changed = $true
    }
}

# Patch 1: add syncPullLocal before syncPull
$syncPullAnchor = 'function syncPull() {'
$syncPullLocalDef = @'
// LOCAL-ONLY poll — 15s interval, no backoff, no cloud dependency (works when Access is offline)
function syncPullLocal() {
  const localUrl = LOCAL_SYNC_URL.replace(/\/+$/,'') + '/sync';
  fetch(localUrl).then(r => r.ok ? r.json() : null).catch(() => null).then(localData => {
    if (!localData) return; // local helper not running, skip silently
    syncErrorCount = 0;
    updateSyncErrorIndicator();
    if (syncErrorTimer) { clearTimeout(syncErrorTimer); syncErrorTimer = null; }
    var anyChange = false;
    if (Array.isArray(localData.appointments)) anyChange = true;
    mergeRemoteData(localData);
    if (!anyChange) return;
    try {
      saveKey('services'); saveKey('sections'); saveKey('employees'); saveKey('products');
      saveKey('clients'); saveKey('projects'); saveKey('providers'); saveKey('appointments');
    } catch(e) { console.error('SAVE ERROR (local):', e); }
    const active = document.querySelector('.nav-item.active');
    if (active) {
      const sec = active.dataset.section;
      if (sec === 'agenda') renderAgenda();
      else if (sec === 'clients') renderClients();
      else if (sec === 'services') renderServices();
      else if (sec === 'sections') renderSections();
      else if (sec === 'employees') renderEmployees();
      else if (sec === 'products') { renderProducts(); renderWarehouse(); }
      else if (sec === 'projects') renderProjects();
      else if (sec === 'dashboard') renderDashboard();
    }
  });
}

'@

if (-not $html.Contains('function syncPullLocal()') -and $html.Contains($syncPullAnchor)) {
    $html = $html.Replace($syncPullAnchor, $syncPullLocalDef + $syncPullAnchor)
    Write-Host "PATCH 1 (syncPullLocal): APPLIED"
    $changed = $true
} else {
    if ($html.Contains('function syncPullLocal()')) {
        Write-Host "PATCH 1: already applied"
    } else {
        Write-Host "PATCH 1: anchor not found"
    }
}

# Patch for syncPull error logic: only count error when BOTH local AND cloud fail
$oldBothFail = "if (!localData && !cloudData) { syncErrorCount++; updateSyncErrorIndicator(); if (status) { status.textContent = '? Sync: sin conexi?n'; status.style.color = '#e74c3c'; setTimeout(() => { if (status) status.textContent = ''; }, 5000); } return; }
    syncErrorCount = 0;"

$newBothFail = "if (!localData && !cloudData) { return; } // local poller handles errors independently
    // Reset errors if local is alive (cloud may be offline intentionally)
    if (localData) { syncErrorCount = 0; }
    else { syncErrorCount++; }"

if ($html.Contains($oldBothFail)) {
    $html = $html.Replace($oldBothFail, $newBothFail)
    Write-Host "PATCH 3 (syncPull error logic): APPLIED"
    $changed = $true
} else {
    Write-Host "PATCH 3: exact match not found, trying fragment search..."
    # Try simpler replacement  
    $frag1 = "if (!localData && !cloudData) { syncErrorCount++; updateSyncErrorIndicator()"
    if ($html.Contains($frag1)) {
        Write-Host "  Found error fragment - applying targeted patch"
        # Replace the line ending in an error message
        $html = $html -replace [regex]::Escape("if (!localData && !cloudData) { syncErrorCount++; updateSyncErrorIndicator(); if (status) {"), "if (!localData && !cloudData) { return; } // local poller handles errors independently`n    if (localData) { syncErrorCount = 0; } else { syncErrorCount++; }`n    updateSyncErrorIndicator(); if (false && status) {"
        $changed = $true
        Write-Host "  Targeted patch applied"
    }
}

if ($changed) {
    [System.IO.File]::WriteAllText($HtmlFile, $html, [System.Text.Encoding]::UTF8)
    Write-Host "`nSUCCESS: electron-app.html patched"
} else {
    Write-Host "`nNO CHANGES: file left unchanged"
}
