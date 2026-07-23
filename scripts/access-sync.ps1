param(
    [Parameter(Mandatory=$true)]
    [string]$JsonFile
)

$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"

function Extract-Code($internalId, $prefix) {
    if ($internalId -match "$prefix(\d+)") {
        return [int]$Matches[1]
    }
    return 0
}

function Parse-Time($timeStr) {
    if (-not $timeStr -or $timeStr -notmatch '^\d{1,2}:\d{2}$') { return [DateTime]::Parse("1899-12-30 00:00:00") }
    $parts = $timeStr -split ':'
    $h = [int]$parts[0]
    $m = [int]$parts[1]
    if ($h -lt 0 -or $h -gt 23 -or $m -lt 0 -or $m -gt 59) { return [DateTime]::Parse("1899-12-30 00:00:00") }
    return [DateTime]::Parse("1899-12-30 ${h}:${m}:00")
}

function Add-Param($cmd, $value) {
    $p = $cmd.CreateParameter()
    $p.Value = $value
    $cmd.Parameters.Add($p) | Out-Null
}

try {
    $raw = Get-Content -Path $JsonFile -Encoding UTF8 -Raw
    $json = $raw | ConvertFrom-Json
    $activeAppts = @($json.appointments | Where-Object { -not $_._deleted })

    # Build lookup maps for client/service/employee names
    $clientMap = @{}
    if ($json.clients) {
        foreach ($c in $json.clients) {
            if ($c.id) { $clientMap[$c.id] = $c.name }
        }
    }
    $serviceMap = @{}
    if ($json.services) {
        foreach ($s in $json.services) {
            if ($s.id) { $serviceMap[$s.id] = $s.name }
        }
    }
    $employeeMap = @{}
    if ($json.employees) {
        foreach ($e in $json.employees) {
            if ($e.id) { $employeeMap[$e.id] = $e.name }
        }
    }

    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()

    # Build uidMap: active records FIRST, then cancelled (active wins over cancelled)
    $uidMap = @{}       # client_uid -> num_cita (active preferred)
    $keyMap = @{}       # "date|time|employee" -> num_cita (active only, for fallback)
    $allAccessActive = @{} # num_cita -> client_uid (active only)

    # First pass: active records (wins for uidMap)
    $cmd2 = $conn.CreateCommand()
    $cmd2.CommandText = "SELECT num_cita, client_uid, Fecha, Hora_Inicio, Empleado FROM Agenda WHERE (Anulado = False OR Anulado IS NULL)"
    $r2 = $cmd2.ExecuteReader()
    while ($r2.Read()) {
        $nc = $r2['num_cita']
        $uid = $r2['client_uid']
        $allAccessActive[$nc] = $uid
        if ($uid -and $uid -ne '' -and -not $uidMap.ContainsKey($uid)) { $uidMap[$uid] = $nc }
        $f = $r2['Fecha']
        $fi = $r2['Hora_Inicio']
        $emp = $r2['Empleado']
        if ($f -is [DateTime] -and $fi -is [DateTime]) {
            $key = "$($f.ToString('yyyy-MM-dd'))|$($fi.ToString('HH:mm'))|$emp"
            $keyMap[$key] = $nc
        }
    }
    $r2.Close()

    # Second pass: cancelled records (only fill gaps, never overwrite active)
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT num_cita, client_uid FROM Agenda WHERE (Anulado = True AND client_uid IS NOT NULL AND client_uid <> '')"
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
        $nc = $r['num_cita']
        $uid = $r['client_uid']
        if ($uid -and $uid -ne '' -and -not $uidMap.ContainsKey($uid)) { $uidMap[$uid] = $nc }
    }
    $r.Close()

    # Get max num_cita for new inserts
    $maxCmd = $conn.CreateCommand()
    $maxCmd.CommandText = "SELECT MAX(num_cita) FROM Agenda"
    $maxResult = $maxCmd.ExecuteScalar()
    $nextNumCita = if ($maxResult -is [int]) { $maxResult + 1 } else { 10001 }

    $inserted = 0
    $updated = 0
    $reactivated = 0
    $matchedNumCitas = @{}

    foreach ($appt in $activeAppts) {
        $uid = $appt.id
        if (-not $uid) { continue }

        $clienteCode = Extract-Code $appt.clientId 'svcl_'
        $empleadoCode = Extract-Code $appt.employeeId 'svem_'
        $servicioCode = Extract-Code $appt.serviceId 'svsv_'
        $fecha = [DateTime]::Parse($appt.date)
        $horaInicio = Parse-Time $appt.time
        $horaFinal = Parse-Time $appt.endTime
        $notes = if ($appt.notes) { $appt.notes } else { '' }
        $isOnline = ($appt.source -eq 'online') -or ($notes -match 'Reserva online')
        $clientName = if ($appt.clientId -and $clientMap.ContainsKey($appt.clientId)) { $clientMap[$appt.clientId] } else { '' }
        $serviceName = if ($appt.serviceId -and $serviceMap.ContainsKey($appt.serviceId)) { $serviceMap[$appt.serviceId] } else { '' }
        $employeeName = if ($appt.employeeId -and $employeeMap.ContainsKey($appt.employeeId)) { $employeeMap[$appt.employeeId] } else { '' }
        $parts = @()
        if ($isOnline) { $parts += 'Reserva online' }
        if ($clientName) { $parts += "Cliente: $clientName" }
        if ($serviceName) { $parts += "Servicio: $serviceName" }
        if ($employeeName) { $parts += "Empleada: $employeeName" }
        $motivo = $parts -join ' - '
        if (-not $clientName -and -not $serviceName -and $notes) { $motivo = $notes }

        $existingNumCita = $null

        # Try matching by client_uid first (searches ALL records including cancelled)
        if ($uidMap.ContainsKey($uid)) {
            $existingNumCita = $uidMap[$uid]
        } else {
            # Fallback: match by date+time+employee (active records only)
            $key = "$($appt.date)|$($appt.time)|$empleadoCode"
            if ($keyMap.ContainsKey($key)) {
                $existingNumCita = $keyMap[$key]
                $fixUid = $conn.CreateCommand()
                $fixUid.CommandText = "UPDATE Agenda SET client_uid=? WHERE num_cita=?"
                Add-Param $fixUid $uid
                Add-Param $fixUid $existingNumCita
                $fixUid.ExecuteNonQuery() | Out-Null
            }
        }

        if ($existingNumCita -ne $null) {
            # UPDATE existing (handles modifications + re-activation)
            $upd = $conn.CreateCommand()
            $upd.CommandText = "UPDATE Agenda SET Cliente=?, Empleado=?, Servicio=?, Fecha=?, Hora_Inicio=?, Hora_Final=?, Motivo=?, client_uid=? WHERE num_cita=?"
            Add-Param $upd $clienteCode
            Add-Param $upd $empleadoCode
            Add-Param $upd $servicioCode
            Add-Param $upd $fecha
            Add-Param $upd $horaInicio
            Add-Param $upd $horaFinal
            Add-Param $upd $motivo
            Add-Param $upd $uid
            Add-Param $upd $existingNumCita
            $upd.ExecuteNonQuery() | Out-Null
            $matchedNumCitas[$existingNumCita] = $true
            if ($allAccessActive.ContainsKey($existingNumCita)) { $updated++ } else { $reactivated++ }
        } else {
            # INSERT new
            $ins = $conn.CreateCommand()
            $ins.CommandText = "INSERT INTO Agenda (num_cita, Cliente, Empleado, Servicio, Fecha, Hora_Inicio, Hora_Final, Motivo, Anulado, client_uid) VALUES (?,?,?,?,?,?,?,?,?,?)"
            Add-Param $ins $nextNumCita
            Add-Param $ins $clienteCode
            Add-Param $ins $empleadoCode
            Add-Param $ins $servicioCode
            Add-Param $ins $fecha
            Add-Param $ins $horaInicio
            Add-Param $ins $horaFinal
            Add-Param $ins $motivo
            Add-Param $ins ([int]0)
            Add-Param $ins $uid
            $ins.ExecuteNonQuery() | Out-Null
            $matchedNumCitas[$nextNumCita] = $true
            $nextNumCita++
            $inserted++
        }
    }

    # Phase 2: Access → JSON (pull new Access appointments into JSON)
    $pulledFromAccess = 0
    $pullCmd = $conn.CreateCommand()
    $pullCmd.CommandText = "SELECT num_cita, Cliente, Empleado, Servicio, Fecha, Hora_Inicio, Hora_Final, Motivo, client_uid FROM Agenda WHERE (Anulado = False OR Anulado IS NULL)"
    $pullReader = $pullCmd.ExecuteReader()
    while ($pullReader.Read()) {
        $nc = $pullReader['num_cita']
        if ($matchedNumCitas.ContainsKey($nc)) { continue }
        $existingUid = if ($pullReader['client_uid']) { $pullReader['client_uid'].ToString().Trim() } else { '' }
        if ($existingUid -and ($json.appointments | Where-Object { $_.id -eq $existingUid -and -not $_._deleted })) { continue }
        $newUid = if ($existingUid) { $existingUid } else { "svap_$nc" }
        $cliCode = if ($pullReader['Cliente']) { [int]$pullReader['Cliente'] } else { 0 }
        $empCode = if ($pullReader['Empleado']) { [int]$pullReader['Empleado'] } else { 0 }
        $svcCode = if ($pullReader['Servicio']) { [int]$pullReader['Servicio'] } else { 0 }
        $fechaVal = $pullReader['Fecha']
        $hiVal = $pullReader['Hora_Inicio']
        $hfVal = $pullReader['Hora_Final']
        $dateStr = if ($fechaVal -is [DateTime]) { $fechaVal.ToString('yyyy-MM-dd') } else { '' }
        $timeStr = if ($hiVal -is [DateTime]) { $hiVal.ToString('HH:mm') } else { '' }
        $endTimeStr = if ($hfVal -is [DateTime]) { $hfVal.ToString('HH:mm') } else { '' }
        $motivoText = if ($pullReader['Motivo']) { $pullReader['Motivo'].ToString() } else { '' }
        $newAppt = [ordered]@{
            id = $newUid
            clientId = if ($cliCode -gt 0) { "svcl_$cliCode" } else { '' }
            employeeId = if ($empCode -gt 0) { "svem_$empCode" } else { '' }
            serviceId = if ($svcCode -gt 0) { "svsv_$svcCode" } else { '' }
            serviceIds = @()
            date = $dateStr
            time = $timeStr
            endTime = $endTimeStr
            notes = $motivoText
            source = 'access'
            status = 'confirmed'
            _deleted = $false
            _modified = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            cancelledBy = ''
            salonModified = $false
            clientModified = $false
            modificationCount = 0
            blockGroupId = ''
            blockNum = ''
            pendingEmployeeId = ''
            pendingDate = ''
            pendingTime = ''
        }
        if (-not ($json.appointments | Where-Object { $_.id -eq $newUid })) {
            $json.appointments += [PSCustomObject]$newAppt
            if (-not $existingUid) {
                $fixUid = $conn.CreateCommand()
                $fixUid.CommandText = "UPDATE Agenda SET client_uid=? WHERE num_cita=?"
                Add-Param $fixUid $newUid
                Add-Param $fixUid $nc
                $fixUid.ExecuteNonQuery() | Out-Null
            }
            $matchedNumCitas[$nc] = $true
            $pulledFromAccess++
        }
    }
    $pullReader.Close()

    # Cancel ALL active Access records NOT in the matched set
    $cancelCmd = $conn.CreateCommand()
    $cancelCmd.CommandText = "UPDATE Agenda SET Anulado=1 WHERE (Anulado = False OR Anulado IS NULL)"
    $cancelCmd.ExecuteNonQuery() | Out-Null

    # Re-activate only the matched ones
    foreach ($nc in $matchedNumCitas.Keys) {
        $reactCmd = $conn.CreateCommand()
        $reactCmd.CommandText = "UPDATE Agenda SET Anulado=0 WHERE num_cita=?"
        Add-Param $reactCmd $nc
        $reactCmd.ExecuteNonQuery() | Out-Null
    }

    # Clean up duplicate cancelled records: for each UID that now has an active record, delete old cancelled ones
    $findDupes = $conn.CreateCommand()
    $findDupes.CommandText = "SELECT DISTINCT client_uid FROM Agenda WHERE client_uid IS NOT NULL AND client_uid <> '' AND Anulado=0"
    $activeUids = @()
    $rd = $findDupes.ExecuteReader()
    while ($rd.Read()) { $activeUids += $rd[0] }
    $rd.Close()
    $cleaned = 0
    foreach ($uid in $activeUids) {
        $delDup = $conn.CreateCommand()
        $delDup.CommandText = "DELETE FROM Agenda WHERE client_uid=? AND Anulado=True"
        Add-Param $delDup $uid
        $cleaned += $delDup.ExecuteNonQuery()
    }

    $conn.Close()

    if ($pulledFromAccess -gt 0) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($JsonFile, ($json | ConvertTo-Json -Depth 10), $utf8NoBom)
    }

    $wasAccess = $allAccessActive.Count
    $cancelled = $wasAccess - $updated
    Write-Host "OK: $inserted inserted, $updated updated, $reactivated reactivated, $pulledFromAccess pulled from Access, $cancelled cancelled, $cleaned duplicates cleaned (JSON: $($activeAppts.Count), Access: $wasAccess)"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
    exit 1
}
