param(
    [Parameter(Mandatory=$true)]
    [string]$JsonFile,
    [string]$DbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
)

$dbPath = $DbPath
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

function Get-ValidEndTime($endStr, $startStr) {
    if (-not $endStr -or $endStr -notmatch '^(\d{1,2}):(\d{2})$') { return $null }
    $eh = [int]$Matches[1]; $em = [int]$Matches[2]
    if ($eh -gt 23 -or $em -gt 59) { return $null }
    $endMin = $eh * 60 + $em
    if ($startStr -and $startStr -match '^(\d{1,2}):(\d{2})$') {
        $sh = [int]$Matches[1]; $sm = [int]$Matches[2]
        $startMin = $sh * 60 + $sm
        if ($endMin -le $startMin) { return $null }
    }
    return [DateTime]::Parse("1899-12-30 ${eh}:${em}:00")
}

function Add-Param($cmd, $value) {
    $p = $cmd.CreateParameter()
    $p.Value = $value
    $cmd.Parameters.Add($p) | Out-Null
}

function Reset-Params($cmd) {
    $cmd.Parameters.Clear() | Out-Null
}

function Set-Params($cmd, $values) {
    Reset-Params $cmd
    foreach ($v in $values) { Add-Param $cmd $v }
}

function Set-AccessSynced($appt) {
    $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    if ($appt.PSObject.Properties['_modifiedAccess']) {
        if ([int64]$appt._modifiedAccess -ne $ts) { $appt._modifiedAccess = $ts; $script:accessSynced++ }
    } else {
        $appt | Add-Member -NotePropertyName '_modifiedAccess' -NotePropertyValue $ts
        $script:accessSynced++
    }
}

try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $jsonFileStamp = (Get-Item -LiteralPath $JsonFile).LastWriteTimeUtc
    $raw = Get-Content -Path $JsonFile -Encoding UTF8 -Raw
    $json = $raw | ConvertFrom-Json
    $activeAppts = @($json.appointments | Where-Object { -not $_._deleted })
    $todayStr = (Get-Date).ToString('yyyy-MM-dd')

    # Build lookup maps for client/service/employee names
    $clientMap = @{}
    if ($json.clients) {
        foreach ($c in $json.clients) {
            if ($c.id) {
                $clientMap[$c.id] = ((@([string]$c.name, [string]$c.apellidos) | Where-Object { $_ -ne '' }) -join ' ').Trim()
            }
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
            if ($e.id) {
                $employeeMap[$e.id] = ((@([string]$e.name, [string]$e.apellidos) | Where-Object { $_ -ne '' }) -join ' ').Trim()
            }
        }
    }

    # === BUILD JSON HASHTABLES FOR O(1) LOOKUP (replaces O(n) Where-Object) ===
    $jsonUidActive = @{}     # uid -> appointment (non-deleted only)
    $jsonUidAll = @{}        # uid -> appointment (all, for existence check)
    foreach ($appt in $json.appointments) {
        if ($appt.id) {
            $jsonUidAll[$appt.id] = $appt
            if (-not $appt._deleted) {
                $jsonUidActive[$appt.id] = $appt
            }
        }
    }

    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $tx = $conn.BeginTransaction()

    # Build uidMap: active records FIRST, then cancelled (active wins over cancelled)
    $uidMap = @{}       # client_uid -> num_cita (active preferred)
    $keyMap = @{}       # "date|time|employee" -> num_cita (active only, for fallback)
    $allAccessActive = @{} # num_cita -> client_uid (active only)
    $accessSnapshot = @{}  # num_cita -> {fields} for detecting Access-side changes

    # First pass: active records (wins for uidMap)
    $cmd2 = $conn.CreateCommand()
    $cmd2.Transaction = $tx
    $cmd2.CommandText = "SELECT num_cita, client_uid, Cliente, Empleado, Servicio, Fecha, Hora_Inicio, Hora_Final, Motivo FROM Agenda WHERE (Anulado = False OR Anulado IS NULL)"
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
        $accessSnapshot[$nc] = @{
            uid = if ($uid) { $uid.ToString().Trim() } else { '' }
            cliente = if ($r2['Cliente']) { [int]$r2['Cliente'] } else { 0 }
            empleado = if ($r2['Empleado']) { [int]$r2['Empleado'] } else { 0 }
            servicio = if ($r2['Servicio']) { [int]$r2['Servicio'] } else { 0 }
            fecha = $f
            horaInicio = $fi
            horaFinal = $r2['Hora_Final']
            motivo = if ($r2['Motivo']) { $r2['Motivo'].ToString() } else { '' }
        }
    }
    $r2.Close()

    # Second pass: cancelled records (only fill gaps, never overwrite active)
    $cmd = $conn.CreateCommand()
    $cmd.Transaction = $tx
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
    $maxCmd.Transaction = $tx
    $maxCmd.CommandText = "SELECT MAX(num_cita) FROM Agenda"
    $maxResult = $maxCmd.ExecuteScalar()
    $nextNumCita = if ($maxResult -is [int]) { $maxResult + 1 } else { 10001 }

    $inserted = 0
    $updated = 0
    $reactivated = 0
    $pulledFromAccess = 0
    $accessSynced = 0
    $matchedNumCitas = @{}

    # === REUSABLE COMMAND OBJECTS ===
    $cmdFixUid = $conn.CreateCommand()
    $cmdFixUid.Transaction = $tx
    $cmdFixUid.CommandText = "UPDATE Agenda SET client_uid=? WHERE num_cita=?"
    $pUid = $cmdFixUid.CreateParameter()
    $cmdFixUid.Parameters.Add($pUid) | Out-Null
    $pNc = $cmdFixUid.CreateParameter()
    $cmdFixUid.Parameters.Add($pNc) | Out-Null

    $cmdUpdate = $conn.CreateCommand()
    $cmdUpdate.Transaction = $tx
    $cmdUpdate.CommandText = "UPDATE Agenda SET Cliente=?, Empleado=?, Servicio=?, Fecha=?, Hora_Inicio=?, Hora_Final=?, Motivo=?, client_uid=? WHERE num_cita=?"
    for ($i = 0; $i -lt 9; $i++) { $cmdUpdate.Parameters.Add($cmdUpdate.CreateParameter()) | Out-Null }

    $cmdInsert = $conn.CreateCommand()
    $cmdInsert.Transaction = $tx
    $cmdInsert.CommandText = "INSERT INTO Agenda (num_cita, Cliente, Empleado, Servicio, Fecha, Hora_Inicio, Hora_Final, Motivo, Anulado, client_uid) VALUES (?,?,?,?,?,?,?,?,?,?)"
    for ($i = 0; $i -lt 10; $i++) { $cmdInsert.Parameters.Add($cmdInsert.CreateParameter()) | Out-Null }

    $cmdReactivate = $conn.CreateCommand()
    $cmdReactivate.Transaction = $tx
    $cmdReactivate.CommandText = "UPDATE Agenda SET Anulado=0 WHERE num_cita=?"
    $pReactNc = $cmdReactivate.CreateParameter()
    $cmdReactivate.Parameters.Add($pReactNc) | Out-Null

    foreach ($appt in $activeAppts) {
        $uid = $appt.id
        if (-not $uid) { continue }

        $clienteCode = Extract-Code $appt.clientId 'svcl_'
        $empleadoCode = Extract-Code $appt.employeeId 'svem_'
        $servicioCode = Extract-Code $appt.serviceId 'svsv_'
        $fecha = [DateTime]::Parse($appt.date)
        $horaInicio = Parse-Time $appt.time
        $validEnd = Get-ValidEndTime $appt.endTime $appt.time
        $horaFinal = if ($validEnd) { $validEnd } else { $null }
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

        # Try matching by client_uid first
        if ($uidMap.ContainsKey($uid)) {
            $existingNumCita = $uidMap[$uid]
        } else {
            # Fallback: match by date+time+employee (active records only)
            $key = "$($appt.date)|$($appt.time)|$empleadoCode"
            if ($keyMap.ContainsKey($key)) {
                $existingNumCita = $keyMap[$key]
                $pUid.Value = $uid
                $pNc.Value = $existingNumCita
                $cmdFixUid.ExecuteNonQuery() | Out-Null
            }
        }

        if ($existingNumCita -ne $null) {
            # Detect if Access was modified externally
            $snap = $accessSnapshot[$existingNumCita]
            $accessChanged = $false
            if ($snap) {
                $snapDate = if ($snap.fecha -is [DateTime]) { $snap.fecha.ToString('yyyy-MM-dd') } else { '' }
                $snapTime = if ($snap.horaInicio -is [DateTime]) { $snap.horaInicio.ToString('HH:mm') } else { '' }
                $snapEndTime = if ($snap.horaFinal -is [DateTime]) { $snap.horaFinal.ToString('HH:mm') } else { '' }
                if ($snapDate -ne $appt.date -or $snapTime -ne $appt.time -or $snapEndTime -ne $appt.endTime -or
                    $snap.empleado -ne $empleadoCode -or $snap.servicio -ne $servicioCode) {
                    $accessChanged = $true
                }
            }

            if ($accessChanged) {
                # Prioridad por origen: si el JSON se modifico (TPV) DESPUES de la ultima reconciliacion con Access -> gana el TPV
                $effAccessMod = if ($null -ne $appt._modifiedAccess) { [int64]$appt._modifiedAccess } else { [int64]0 }
                $tpvWins = ([int64]$appt._modified -gt $effAccessMod)
                if ($tpvWins) {
                    # TPV gana -> empujar JSON a Access
                    $cmdUpdate.Parameters[0].Value = $clienteCode
                    $cmdUpdate.Parameters[1].Value = $empleadoCode
                    $cmdUpdate.Parameters[2].Value = $servicioCode
                    $cmdUpdate.Parameters[3].Value = $fecha
                    $cmdUpdate.Parameters[4].Value = $horaInicio
                    $cmdUpdate.Parameters[5].Value = $horaFinal
                    $cmdUpdate.Parameters[6].Value = $motivo
                    $cmdUpdate.Parameters[7].Value = $uid
                    $cmdUpdate.Parameters[8].Value = $existingNumCita
                    $cmdUpdate.ExecuteNonQuery() | Out-Null
                    $matchedNumCitas[$existingNumCita] = $true
                    if ($allAccessActive.ContainsKey($existingNumCita)) { $updated++ } else { $reactivated++ }
                    Set-AccessSynced $appt
                } else {
                    # Access gana -> traer Access al JSON
                    $appt.clientId = $(if ($snap.cliente -gt 0) { "svcl_$($snap.cliente)" } else { $appt.clientId })
                    $appt.employeeId = $(if ($snap.empleado -gt 0) { "svem_$($snap.empleado)" } else { $appt.employeeId })
                    $appt.serviceId = $(if ($snap.servicio -gt 0) { "svsv_$($snap.servicio)" } else { $appt.serviceId })
                    $appt.date = $snapDate
                    $appt.time = $snapTime
                    if (Get-ValidEndTime $snapEndTime $snapTime) {
                        $appt.endTime = $snapEndTime
                    }
                    $appt.notes = $snap.motivo
                    $appt._modified = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
                    Set-AccessSynced $appt
                    $matchedNumCitas[$existingNumCita] = $true
                    $pulledFromAccess++
                    if (-not $snap.uid -or $snap.uid -eq '') {
                        $pUid.Value = $uid
                        $pNc.Value = $existingNumCita
                        $cmdFixUid.ExecuteNonQuery() | Out-Null
                    }
                }
            } else {
                # Push JSON to Access
                $cmdUpdate.Parameters[0].Value = $clienteCode
                $cmdUpdate.Parameters[1].Value = $empleadoCode
                $cmdUpdate.Parameters[2].Value = $servicioCode
                $cmdUpdate.Parameters[3].Value = $fecha
                $cmdUpdate.Parameters[4].Value = $horaInicio
                $cmdUpdate.Parameters[5].Value = $horaFinal
                $cmdUpdate.Parameters[6].Value = $motivo
                $cmdUpdate.Parameters[7].Value = $uid
                $cmdUpdate.Parameters[8].Value = $existingNumCita
                $cmdUpdate.ExecuteNonQuery() | Out-Null
                $matchedNumCitas[$existingNumCita] = $true
                if ($allAccessActive.ContainsKey($existingNumCita)) { $updated++ } else { $reactivated++ }
            }
        } else {
            # INSERT new
            $cmdInsert.Parameters[0].Value = $nextNumCita
            $cmdInsert.Parameters[1].Value = $clienteCode
            $cmdInsert.Parameters[2].Value = $empleadoCode
            $cmdInsert.Parameters[3].Value = $servicioCode
            $cmdInsert.Parameters[4].Value = $fecha
            $cmdInsert.Parameters[5].Value = $horaInicio
            $cmdInsert.Parameters[6].Value = $horaFinal
            $cmdInsert.Parameters[7].Value = $motivo
            $cmdInsert.Parameters[8].Value = ([int]0)
            $cmdInsert.Parameters[9].Value = $uid
            $cmdInsert.ExecuteNonQuery() | Out-Null
            $matchedNumCitas[$nextNumCita] = $true
            $nextNumCita++
            $inserted++
            Set-AccessSynced $appt
        }
    }

    # Phase 1.5: Detect Access cancellations and propagate to JSON
    # USE HASHTABLE LOOKUP instead of O(n) Where-Object
    $accessCancelled = 0
    $cancelDetect = $conn.CreateCommand()
    $cancelDetect.Transaction = $tx
    $cancelDetect.CommandText = "SELECT num_cita, client_uid FROM Agenda WHERE Anulado=True AND client_uid IS NOT NULL AND client_uid <> ''"
    $cancelReader = $cancelDetect.ExecuteReader()
    while ($cancelReader.Read()) {
        $cuid = $cancelReader['client_uid'].ToString().Trim()
        $cnc = $cancelReader['num_cita']
        if ($jsonUidActive.ContainsKey($cuid)) {
            $appt = $jsonUidActive[$cuid]
            $effAccessMod = if ($null -ne $appt._modifiedAccess) { [int64]$appt._modifiedAccess } else { [int64]0 }
            $tpvWins = ([int64]$appt._modified -gt $effAccessMod)
            if ($tpvWins) {
                # TPV lo modifico despues -> la cancelacion de Access no manda; reactivar Access
                $pReactNc.Value = $cnc
                $cmdReactivate.ExecuteNonQuery() | Out-Null
                $matchedNumCitas[$cnc] = $true
                $reactivated++
            } else {
                $appt._deleted = $true
                $appt._modified = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
                $appt.cancelledBy = 'salon'
                Set-AccessSynced $appt
                # Remove from active map so it doesn't match again
                $jsonUidActive.Remove($cuid)
                if ($matchedNumCitas.ContainsKey($cnc)) { $matchedNumCitas.Remove($cnc) }
                $accessCancelled++
            }
        }
    }
    $cancelReader.Close()

    # Phase 2: Access -> JSON (pull new Access appointments into JSON)
    # USE HASHTABLE LOOKUP instead of O(n) Where-Object
    $cmdPull = $conn.CreateCommand()
    $cmdPull.Transaction = $tx
    $cmdPull.CommandText = "SELECT num_cita, Cliente, Empleado, Servicio, Fecha, Hora_Inicio, Hora_Final, Motivo, client_uid FROM Agenda WHERE (Anulado = False OR Anulado IS NULL)"
    $pullReader = $cmdPull.ExecuteReader()
    while ($pullReader.Read()) {
        $nc = $pullReader['num_cita']
        if ($matchedNumCitas.ContainsKey($nc)) { continue }
        $existingUid = if ($pullReader['client_uid']) { $pullReader['client_uid'].ToString().Trim() } else { '' }
        # If Access record has a client_uid that matches an ACTIVE JSON appointment, skip — that appointment is already synced
        if ($existingUid -and $jsonUidActive.ContainsKey($existingUid)) { continue }
        # If Access record has a client_uid that matches only a DELETED JSON appointment, reactivate it later — don't skip
        $newUid = if ($existingUid) { $existingUid } else { "svap_$nc" }
        $cliCode = if ($pullReader['Cliente']) { [int]$pullReader['Cliente'] } else { 0 }
        $empCode = if ($pullReader['Empleado']) { [int]$pullReader['Empleado'] } else { 0 }
        $svcCode = if ($pullReader['Servicio']) { [int]$pullReader['Servicio'] } else { 0 }
        $fechaVal = $pullReader['Fecha']
        $hiVal = $pullReader['Hora_Inicio']
        $hfVal = $pullReader['Hora_Final']
        $dateStr = if ($fechaVal -is [DateTime]) { $fechaVal.ToString('yyyy-MM-dd') } else { '' }
        if ($dateStr -and $dateStr -lt $todayStr) { continue }
        $timeStr = if ($hiVal -is [DateTime]) { $hiVal.ToString('HH:mm') } else { '' }
        $endTimeStr = if ($hfVal -is [DateTime]) { $hfVal.ToString('HH:mm') } else { '' }
        $endTimeValid = Get-ValidEndTime $endTimeStr $timeStr
        $motivoText = if ($pullReader['Motivo']) { $pullReader['Motivo'].ToString() } else { '' }
        if (-not $jsonUidAll.ContainsKey($newUid)) {
            $newAppt = [ordered]@{
                id = $newUid
                clientId = if ($cliCode -gt 0) { "svcl_$cliCode" } else { '' }
                employeeId = if ($empCode -gt 0) { "svem_$empCode" } else { '' }
                serviceId = if ($svcCode -gt 0) { "svsv_$svcCode" } else { '' }
                serviceIds = @()
                date = $dateStr
                time = $timeStr
                endTime = if ($endTimeValid) { $endTimeStr } else { '' }
                notes = $motivoText
                source = 'access'
                status = 'confirmed'
                _deleted = $false
                _modified = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
                _modifiedAccess = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
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
            $json.appointments += [PSCustomObject]$newAppt
            $jsonUidAll[$newUid] = $json.appointments[-1]
            $jsonUidActive[$newUid] = $json.appointments[-1]
            if (-not $existingUid) {
                $pUid.Value = $newUid
                $pNc.Value = $nc
                $cmdFixUid.ExecuteNonQuery() | Out-Null
            }
            $matchedNumCitas[$nc] = $true
            $pulledFromAccess++
        } else {
            # Re-activate deleted JSON entry if Access record is still active
            $existingAppt = $jsonUidAll[$newUid]
            if ($existingAppt) {
                $isDeleted = $existingAppt._deleted -eq $true -or ($existingAppt.cancelledBy -ne '' -and $existingAppt.cancelledBy -ne $null)
                if ($isDeleted) {
                    $effAccessMod = if ($null -ne $existingAppt._modifiedAccess) { [int64]$existingAppt._modifiedAccess } else { [int64]0 }
                    $tpvWins = ([int64]$existingAppt._modified -gt $effAccessMod)
                    if ($tpvWins) {
                        # TPV lo borro despues -> no reactivar; Phase 3 cancelara la cita en Access
                    } else {
                        $existingAppt._deleted = $false
                        $existingAppt.cancelledBy = ''
                        $existingAppt.notes = $motivoText
                        $existingAppt._modified = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
                        Set-AccessSynced $existingAppt
                        $jsonUidActive[$newUid] = $existingAppt
                        $matchedNumCitas[$nc] = $true
                        $pulledFromAccess++
                    }
                }
            }
        }
    }
    $pullReader.Close()

    # Phase 3: Cancel unmatched, reactivate matched - BATCH OPERATIONS
    if ($matchedNumCitas.Count -gt 0) {
        # Build list of matched num_cita values
        $matchedNcs = @($matchedNumCitas.Keys)
        $placeholders = ($matchedNcs | ForEach-Object { '?' }) -join ','

        # Cancel all active NOT in matched set
        $cancelAll = $conn.CreateCommand()
        $cancelAll.Transaction = $tx
        $cancelAll.CommandText = "UPDATE Agenda SET Anulado=1 WHERE (Anulado = False OR Anulado IS NULL) AND num_cita NOT IN ($placeholders)"
        foreach ($nc in $matchedNcs) {
            Add-Param $cancelAll $nc
        }
        $cancelAll.ExecuteNonQuery() | Out-Null
    } else {
        # No matches at all - cancel everything
        $cancelAll = $conn.CreateCommand()
        $cancelAll.Transaction = $tx
        $cancelAll.CommandText = "UPDATE Agenda SET Anulado=1 WHERE (Anulado = False OR Anulado IS NULL)"
        $cancelAll.ExecuteNonQuery() | Out-Null
    }

    # Clean up duplicate cancelled records: batch DELETE
    $findDupes = $conn.CreateCommand()
    $findDupes.Transaction = $tx
    $findDupes.CommandText = "SELECT DISTINCT client_uid FROM Agenda WHERE client_uid IS NOT NULL AND client_uid <> '' AND Anulado=0"
    $activeUids = @()
    $rd = $findDupes.ExecuteReader()
    while ($rd.Read()) { $activeUids += $rd[0] }
    $rd.Close()

    $cleaned = 0
    if ($activeUids.Count -gt 0) {
        $uidPlaceholders = ($activeUids | ForEach-Object { '?' }) -join ','
        $delDup = $conn.CreateCommand()
        $delDup.Transaction = $tx
        $delDup.CommandText = "DELETE FROM Agenda WHERE client_uid IN ($uidPlaceholders) AND Anulado=True"
        foreach ($u in $activeUids) {
            Add-Param $delDup $u
        }
        $cleaned = $delDup.ExecuteNonQuery()
    }

    # Phase 3.5: Pull client surnames (Apellidos) from Access Clientes into JSON clients
    $surnamesPulled = 0
    try {
        $jsonClientMap = @{}
        foreach ($jc in @($json.clients)) { if ($jc.id) { $jsonClientMap[$jc.id] = $jc } }
        $cmdSurname = $conn.CreateCommand()
        $cmdSurname.Transaction = $tx
        $cmdSurname.CommandText = "SELECT Codigo, Apellidos FROM Clientes"
        $sr = $cmdSurname.ExecuteReader()
        while ($sr.Read()) {
            $codigo = $sr['Codigo']
            $apellidos = if ($sr['Apellidos']) { $sr['Apellidos'].ToString().Trim() } else { '' }
            if (-not $apellidos) { continue }
            $matchId = "svcl_$codigo"
            if ($jsonClientMap.ContainsKey($matchId)) {
                $jsonClient = $jsonClientMap[$matchId]
                $curAp = if ($jsonClient.apellidos) { [string]$jsonClient.apellidos } else { '' }
                if ($curAp -ne $apellidos) {
                    if ($jsonClient.PSObject.Properties['apellidos']) {
                        $jsonClient.apellidos = $apellidos
                    } else {
                        $jsonClient | Add-Member -NotePropertyName 'apellidos' -NotePropertyValue $apellidos
                    }
                    $jsonClient._modified = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
                    $surnamesPulled++
                }
            }
        }
        $sr.Close()
    } catch {
        Write-Host "WARN: Apellidos sync skipped: $($_.Exception.Message)"
    }

    $shouldWrite = ($pulledFromAccess -gt 0 -or $accessCancelled -gt 0 -or $cleaned -gt 0 -or $surnamesPulled -gt 0 -or $accessSynced -gt 0)

    # Detect concurrent edits: if the JSON file changed while we were reading Access,
    # roll back everything so a stale snapshot never overwrites the TPV's latest changes.
    # The next queued run re-syncs from scratch.
    $currentStamp = (Get-Item -LiteralPath $JsonFile).LastWriteTimeUtc
    if ($shouldWrite -and $currentStamp -ne $jsonFileStamp) {
        $tx.Rollback()
        $conn.Close()
        Write-Host "ABORTED: JSON changed during processing ($($currentStamp.ToString('HH:mm:ss.fff')) != $($jsonFileStamp.ToString('HH:mm:ss.fff'))). Next run will re-sync."
        exit 0
    }

    # Commit transaction
    $tx.Commit()
    $conn.Close()

    if ($shouldWrite) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($JsonFile, ($json | ConvertTo-Json -Depth 10), $utf8NoBom)
    }

    $sw.Stop()
    $wasAccess = $allAccessActive.Count
    $cancelled = $wasAccess - $updated
    Write-Host "OK (${($sw.Elapsed.TotalSeconds.ToString('0.00'))}s): $inserted inserted, $updated updated, $reactivated reactivated, $pulledFromAccess pulled, $accessCancelled access-cancelled, $cancelled cancelled, $cleaned dupes, $surnamesPulled surnames (JSON: $($activeAppts.Count), Access: $wasAccess)"
} catch {
    if ($tx) { try { $tx.Rollback() } catch {} }
    if ($conn -and $conn.State -ne 'Closed') { try { $conn.Close() } catch {} }
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
    exit 1
}
