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

function Round-ToFifteenMinutes($totalMin) {
    $mod = $totalMin % 15
    if ($mod -eq 0) { return $totalMin }
    return $totalMin + (15 - $mod)
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
    $roundedMin = Round-ToFifteenMinutes $endMin
    $rH = [int]([Math]::Floor($roundedMin / 60))
    $rM = $roundedMin % 60
    if ($rH -gt 23) { $rH = 23; $rM = 55 }
    return [DateTime]::Parse("1899-12-30 ${rH}:${rM}:00")
}

# Access guarda "sin hora de fin" como 1899-12-30 00:00:00 (fecha cero valida).
# Un NULL Hora_Final rompe la app de Access, asi que nunca escribimos NULL;
# al leer, la fecha cero se trata como fin vacio para no generar conflictos.
function Get-EndTimeStr($dt) {
    if ($dt -isnot [DateTime]) { return '' }
    if ($dt.Hour -eq 0 -and $dt.Minute -eq 0 -and $dt.Second -eq 0) { return '' }
    return $dt.ToString('HH:mm')
}

function Get-HoraFinalParam($validEnd) {
    if ($validEnd) { return $validEnd }
    return [DateTime]::Parse("1899-12-30 00:00:00")
}

function Add-Param($cmd, $value) {
    $p = $cmd.CreateParameter()
    $p.Value = $value
    $cmd.Parameters.Add($p) | Out-Null
}

# Ejecuta una escritura tolerando filas bloqueadas por otra sesion de Access
# (el usuario editando en Access UI). Si la fila esta bloqueada se salta SIN
# abortar el ciclo completo; la siguiente ejecucion reintentara.
function Invoke-SafeWrite($cmd, $what) {
    try {
        $null = $cmd.ExecuteNonQuery()
        return $true
    } catch {
        if ($_.Exception.Message -match 'bloqueado|locked|no se pudo actualizar|exclusiv|shared') {
            Write-Host "SKIP ($what): $($_.Exception.Message)"
            return $false
        }
        throw
    }
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

function Set-ApptField($appt, $name, $value) {
    if ($appt.PSObject.Properties[$name]) {
        $appt.$name = $value
    } else {
        $appt | Add-Member -NotePropertyName $name -NotePropertyValue $value
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

    # Build uidMap: active records FIRST, then cancelled (active wins over cancelled)
    $uidMap = @{}       # client_uid -> num_cita (active preferred)
    $keyMap = @{}       # "date|time|employee" -> num_cita (active only, for fallback)
    $allAccessActive = @{} # num_cita -> client_uid (active only)
    $accessSnapshot = @{}  # num_cita -> {fields} for detecting Access-side changes

    # First pass: active records (wins for uidMap)
    $cmd2 = $conn.CreateCommand()
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
            cliente = if ($r2['Cliente'] -and $r2['Cliente'] -ne [System.DBNull]::Value) { [int]$r2['Cliente'] } else { 0 }
            empleado = if ($r2['Empleado'] -and $r2['Empleado'] -ne [System.DBNull]::Value) { [int]$r2['Empleado'] } else { 0 }
            servicio = if ($r2['Servicio'] -and $r2['Servicio'] -ne [System.DBNull]::Value) { [int]$r2['Servicio'] } else { 0 }
            fecha = $f
            horaInicio = $fi
            horaFinal = $r2['Hora_Final']
            motivo = if ($r2['Motivo']) { $r2['Motivo'].ToString() } else { '' }
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
    $pulledFromAccess = 0
    $accessSynced = 0
    $matchedNumCitas = @{}

    # === REUSABLE COMMAND OBJECTS ===
    $cmdFixUid = $conn.CreateCommand()
    $cmdFixUid.CommandText = "UPDATE Agenda SET client_uid=? WHERE num_cita=?"
    $pUid = $cmdFixUid.CreateParameter()
    $cmdFixUid.Parameters.Add($pUid) | Out-Null
    $pNc = $cmdFixUid.CreateParameter()
    $cmdFixUid.Parameters.Add($pNc) | Out-Null

    $cmdUpdate = $conn.CreateCommand()
    $cmdUpdate.CommandText = "UPDATE Agenda SET Cliente=?, Empleado=?, Servicio=?, Fecha=?, Hora_Inicio=?, Hora_Final=?, Motivo=?, client_uid=? WHERE num_cita=?"
    for ($i = 0; $i -lt 9; $i++) { $cmdUpdate.Parameters.Add($cmdUpdate.CreateParameter()) | Out-Null }

    $cmdInsert = $conn.CreateCommand()
    $cmdInsert.CommandText = "INSERT INTO Agenda (num_cita, Cliente, Empleado, Servicio, Fecha, Hora_Inicio, Hora_Final, Motivo, Anulado, client_uid) VALUES (?,?,?,?,?,?,?,?,?,?)"
    for ($i = 0; $i -lt 10; $i++) { $cmdInsert.Parameters.Add($cmdInsert.CreateParameter()) | Out-Null }

    $cmdReactivate = $conn.CreateCommand()
    $cmdReactivate.CommandText = "UPDATE Agenda SET Anulado=0 WHERE num_cita=?"
    $pReactNc = $cmdReactivate.CreateParameter()
    $cmdReactivate.Parameters.Add($pReactNc) | Out-Null

    foreach ($appt in $activeAppts) {
        $uid = $appt.id
        if (-not $uid) { continue }

        $clienteCode = Extract-Code $appt.clientId 'svcl_'
        $empleadoCode = Extract-Code $appt.employeeId 'svem_'
        $effectiveServiceId = $appt.serviceId
        if (-not $effectiveServiceId -and $appt.serviceIds -and $appt.serviceIds.Count -gt 0) {
            $effectiveServiceId = $appt.serviceIds[0]
        }
        $servicioCode = Extract-Code $effectiveServiceId 'svsv_'
        $fecha = [DateTime]::Parse($appt.date)
        $horaInicio = Parse-Time $appt.time
        $validEnd = Get-ValidEndTime $appt.endTime $appt.time
        $horaFinal = if ($validEnd) { $validEnd } else { $null }
        $horaFinalParam = Get-HoraFinalParam $horaFinal
        $notes = if ($appt.notes) { $appt.notes } else { '' }
        $isOnline = ($appt.source -eq 'online') -or ($notes -match 'Reserva online')
        $clientName = if ($appt.clientId -and $clientMap.ContainsKey($appt.clientId)) { $clientMap[$appt.clientId] } else { '' }
        $serviceName = if ($effectiveServiceId -and $serviceMap.ContainsKey($effectiveServiceId)) { $serviceMap[$effectiveServiceId] } else { '' }
        $employeeName = if ($appt.employeeId -and $employeeMap.ContainsKey($appt.employeeId)) { $employeeMap[$appt.employeeId] } else { '' }
        $parts = @()
        if ($isOnline) { $parts += 'Reserva online' }
        if ($clientName) { $parts += "Cliente: $clientName" }
        if ($serviceName) { $parts += "Servicio: $serviceName" }
        if ($employeeName) { $parts += "Empleada: $employeeName" }
        $motivo = $parts -join ' - '
        # Strip previously generated prefix from notes to prevent duplication
        $userNotes = $notes
        if ($motivo -and $userNotes.StartsWith($motivo)) {
            $remainder = $userNotes.Substring($motivo.Length)
            $remainder = $remainder.TrimStart(' ', '|', ' ')
            $userNotes = $remainder
        }
        if ($userNotes) {
            if ($motivo) { $motivo = "$motivo | $userNotes" } else { $motivo = $userNotes }
        }

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
            $null = Invoke-SafeWrite $cmdFixUid 'fix uid (keyMap)'
            }
        }

        if ($existingNumCita -ne $null) {
            # Si la fila de Access esta CANCELADA (no activa), no empujar nada: la cancelacion
            # de Access manda y la Fase 1.5 propagara el borrado al JSON. Escribir aqui no
            # reactiva pero si toma locks innecesarios sobre la fila.
            if (-not $allAccessActive.ContainsKey($existingNumCita)) { continue }
            # Detect if Access was modified externally
            $snap = $accessSnapshot[$existingNumCita]
            $accessChanged = $false
            $motivoChanged = $false
            $snapMotivo = ''
            $jsonNotes = if ($appt.notes) { [string]$appt.notes } else { '' }
            if ($snap) {
                $snapDate = if ($snap.fecha -is [DateTime]) { $snap.fecha.ToString('yyyy-MM-dd') } else { '' }
                $snapTime = if ($snap.horaInicio -is [DateTime]) { $snap.horaInicio.ToString('HH:mm') } else { '' }
                $snapEndTime = Get-EndTimeStr $snap.horaFinal
                if ($snapDate -ne $appt.date -or $snapTime -ne $appt.time -or $snapEndTime -ne $appt.endTime -or
                    $snap.empleado -ne $empleadoCode -or $snap.servicio -ne $servicioCode) {
                    $accessChanged = $true
                }
                # El Motivo es editable por el usuario en Access y debe sincronizarse con el TPV.
                # Se considera cambiado si Access difiere TANTO del motivo que el TPV generaria
                # como de las notas que el TPV ya conoce (las citas creadas en Access guardan su
                # texto libre en Motivo/notes, asi que esa igualdad es el estado "en paz").
                # EXCEPCION - reservas online: su Motivo es texto generado por la propia sync
                # y las Notas del TPV deben quedar VACIAS (no se vuelca el Motivo de Access),
                # asi que aqui no se detecta cambio de Motivo (evita re-sincros eternas).
                $snapMotivo = if ($snap.motivo) { [string]$snap.motivo } else { '' }
                if (-not $isOnline -and $snapMotivo -ne $motivo -and $snapMotivo -ne $jsonNotes) {
                    $motivoChanged = $true
                }
            }

            if ($accessChanged -or $motivoChanged) {
                # Prioridad por origen: si el JSON se modifico (TPV) DESPUES de la ultima reconciliacion con Access -> gana el TPV
                $effAccessMod = if ($null -ne $appt._modifiedAccess) { [int64]$appt._modifiedAccess } else { [int64]0 }
                $tpvWins = ([int64]$appt._modified -gt $effAccessMod)
                if ($tpvWins) {
                    # TPV gana -> empujar JSON a Access
                    # La hora final se preserva siempre: si el JSON no trae una hora final valida
                    # (p.ej. cita de Access sin servicios) se conserva la Hora_Final real que ya tiene
                    # Access y se incorpora al JSON, en vez de escribir la fecha cero que la destruiria.
                    if (-not (Get-ValidEndTime $appt.endTime $appt.time) -and $snapEndTime) {
                        Set-ApptField $appt 'endTime' $snapEndTime
                        Set-ApptField $appt '_modified' ([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
                        $horaFinal = $snap.horaFinal
                        $horaFinalParam = Get-HoraFinalParam $horaFinal
                    }
                    $cmdUpdate.Parameters[0].Value = $clienteCode
                    $cmdUpdate.Parameters[1].Value = $empleadoCode
                    $cmdUpdate.Parameters[2].Value = $servicioCode
                    $cmdUpdate.Parameters[3].Value = $fecha
                    $cmdUpdate.Parameters[4].Value = $horaInicio
                    $cmdUpdate.Parameters[5].Value = $horaFinalParam
                    $cmdUpdate.Parameters[6].Value = $motivo
                    $cmdUpdate.Parameters[7].Value = $uid
                    $cmdUpdate.Parameters[8].Value = $existingNumCita
                    $null = Invoke-SafeWrite $cmdUpdate 'update (tpv wins)'
                    $matchedNumCitas[$existingNumCita] = $true
                    if ($allAccessActive.ContainsKey($existingNumCita)) { $updated++ } else { $reactivated++ }
                    Set-AccessSynced $appt
                } else {
                    # Access gana -> traer Access al JSON
                    Set-ApptField $appt 'clientId' $(if ($snap.cliente -gt 0) { "svcl_$($snap.cliente)" } else { $appt.clientId })
                    Set-ApptField $appt 'employeeId' $(if ($snap.empleado -gt 0) { "svem_$($snap.empleado)" } else { $appt.employeeId })
                    Set-ApptField $appt 'serviceId' $(if ($snap.servicio -gt 0) { "svsv_$($snap.servicio)" } else { $appt.serviceId })
                    Set-ApptField $appt 'date' $snapDate
                    Set-ApptField $appt 'time' $snapTime
                    if (Get-ValidEndTime $snapEndTime $snapTime) {
                        Set-ApptField $appt 'endTime' $snapEndTime
                    }
                    # Reservas online: las Notas del TPV quedan vacias; el Motivo generado
                    # de Access NO se pasa a Notas (solo aplica a citas no online).
                    Set-ApptField $appt 'notes' $(if ($isOnline) { '' } else { $snapMotivo })
                    Set-ApptField $appt '_modified' ([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
                    Set-AccessSynced $appt
                    $matchedNumCitas[$existingNumCita] = $true
                    $pulledFromAccess++
                    if (-not $snap.uid -or $snap.uid -eq '') {
                        $pUid.Value = $uid
                        $pNc.Value = $existingNumCita
                        $null = Invoke-SafeWrite $cmdFixUid 'fix uid (access wins)'
                    }
                }
            } else {
                # Push JSON to Access
                # Sin conflicto de prioridad: el TPV empuja sus datos. Pero si Access es el origen
                # del texto (su Motivo == las notas que el TPV ya conoce), se preserva ese texto
                # en vez de sobrescribirlo con el motivo generado automaticamente.
                $motivoToWrite = $motivo
                if ($snapMotivo -ne $motivo -and $snapMotivo -eq $jsonNotes) {
                    $motivoToWrite = $snapMotivo
                }
                # NO escribir si Access ya tiene exactamente los mismos valores: evita tomar locks
                # sobre filas que el usuario podria estar editando en Access cada ciclo de 30s.
                $snapCli = if ($snap.cliente -gt 0) { "svcl_$($snap.cliente)" } else { '' }
                $snapEmp = if ($snap.empleado -gt 0) { "svem_$($snap.empleado)" } else { '' }
                $snapSvc = if ($snap.servicio -gt 0) { "svsv_$($snap.servicio)" } else { '' }
                $sameValues = ($snapCli -eq $clienteCode) -and ($snapEmp -eq $empleadoCode) -and
                              ($snapSvc -eq $servicioCode) -and ($snapDate -eq $appt.date) -and
                              ($snapTime -eq $appt.time) -and ($snapEndTime -eq $appt.endTime) -and
                              ($snapMotivo -eq $motivoToWrite)
                if (-not $sameValues) {
                    $cmdUpdate.Parameters[0].Value = $clienteCode
                    $cmdUpdate.Parameters[1].Value = $empleadoCode
                    $cmdUpdate.Parameters[2].Value = $servicioCode
                    $cmdUpdate.Parameters[3].Value = $fecha
                    $cmdUpdate.Parameters[4].Value = $horaInicio
                    $cmdUpdate.Parameters[5].Value = $horaFinalParam
                    $cmdUpdate.Parameters[6].Value = $motivoToWrite
                    $cmdUpdate.Parameters[7].Value = $uid
                    $cmdUpdate.Parameters[8].Value = $existingNumCita
                    $null = Invoke-SafeWrite $cmdUpdate 'update (push)'
                }
                $matchedNumCitas[$existingNumCita] = $true
                if ($allAccessActive.ContainsKey($existingNumCita)) { $updated++ } else { $reactivated++ }
                # El TPV pudo "tocar" la cita (ej. confirmar reserva online) sin cambiar sus datos.
                # Registramos ese push en _modifiedAccess para que no parezca una modificacion pendiente
                # (eso hara que _modified deje de ser > _modifiedAccess y Access recupere su prioridad).
                $modAcc = if ($null -ne $appt._modifiedAccess) { [int64]$appt._modifiedAccess } else { [int64]0 }
                if ([int64]$appt._modified -gt $modAcc) { Set-AccessSynced $appt }
            }
        } else {
            # INSERT new
            $cmdInsert.Parameters[0].Value = $nextNumCita
            $cmdInsert.Parameters[1].Value = $clienteCode
            $cmdInsert.Parameters[2].Value = $empleadoCode
            $cmdInsert.Parameters[3].Value = $servicioCode
            $cmdInsert.Parameters[4].Value = $fecha
            $cmdInsert.Parameters[5].Value = $horaInicio
            $cmdInsert.Parameters[6].Value = $horaFinalParam
            $cmdInsert.Parameters[7].Value = $motivo
            $cmdInsert.Parameters[8].Value = ([int]0)
            $cmdInsert.Parameters[9].Value = $uid
            $null = Invoke-SafeWrite $cmdInsert 'insert new'
            $matchedNumCitas[$nextNumCita] = $true
            $nextNumCita++
            $inserted++
            Set-AccessSynced $appt
        }
    }

    # Phase 1.5: Detect Access cancellations and propagate to JSON
    # USE HASHTABLE LOOKUP instead of O(n) Where-Object
    # REGLA DE PRIORIDAD (absoluta): si la cita esta cancelada en Access, la cancelacion
    # manda y queda cancelada en TODOS los programas. No se reactiva nunca, ni aunque el
    # TPV/online tenga datos distintos: los borrados son definitivos.
    $accessCancelled = 0
    $cancelDetect = $conn.CreateCommand()
    $cancelDetect.CommandText = "SELECT num_cita, client_uid FROM Agenda WHERE Anulado=True AND client_uid IS NOT NULL AND client_uid <> ''"
    $cancelReader = $cancelDetect.ExecuteReader()
    while ($cancelReader.Read()) {
        $cuid = $cancelReader['client_uid'].ToString().Trim()
        $cnc = $cancelReader['num_cita']
        if ($jsonUidActive.ContainsKey($cuid)) {
            $appt = $jsonUidActive[$cuid]
            Set-ApptField $appt '_deleted' $true
            Set-ApptField $appt '_modified' ([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
            Set-ApptField $appt 'cancelledBy' 'salon'
            Set-AccessSynced $appt
            # Remove from active map so it doesn't match again
            $jsonUidActive.Remove($cuid)
            if ($matchedNumCitas.ContainsKey($cnc)) { $matchedNumCitas.Remove($cnc) }
            $accessCancelled++
        }
    }
    $cancelReader.Close()

    # Phase 2: Access -> JSON (pull new Access appointments into JSON)
    # USE HASHTABLE LOOKUP instead of O(n) Where-Object
    $cmdPull = $conn.CreateCommand()
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
        $cliCode = if ($pullReader['Cliente'] -and $pullReader['Cliente'] -ne [System.DBNull]::Value) { [int]$pullReader['Cliente'] } else { 0 }
        $empCode = if ($pullReader['Empleado'] -and $pullReader['Empleado'] -ne [System.DBNull]::Value) { [int]$pullReader['Empleado'] } else { 0 }
        $svcCode = if ($pullReader['Servicio'] -and $pullReader['Servicio'] -ne [System.DBNull]::Value) { [int]$pullReader['Servicio'] } else { 0 }
        $fechaVal = $pullReader['Fecha']
        $hiVal = $pullReader['Hora_Inicio']
        $hfVal = $pullReader['Hora_Final']
        $dateStr = if ($fechaVal -is [DateTime]) { $fechaVal.ToString('yyyy-MM-dd') } else { '' }
        if ($dateStr -and $dateStr -lt $todayStr) { continue }
        $timeStr = if ($hiVal -is [DateTime]) { $hiVal.ToString('HH:mm') } else { '' }
        $endTimeStr = Get-EndTimeStr $hfVal
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
                $null = Invoke-SafeWrite $cmdFixUid 'fix uid (pull)'
            }
            $matchedNumCitas[$nc] = $true
            $pulledFromAccess++
        } else {
            # REGLA DE PRIORIDAD (absoluta): si la cita esta borrada en el TPV/online
            # (JSON _deleted) pero Access sigue con la fila activa, el borrado manda:
            # NO se reactiva el JSON. La fila de Access queda SIN emparejar y la Fase 3
            # la cancelara (Anulado=1). Los borrados son definitivos en todos los programas.
            $existingAppt = $jsonUidAll[$newUid]
            if ($existingAppt) {
                $isDeleted = $existingAppt._deleted -eq $true -or ($existingAppt.cancelledBy -ne '' -and $existingAppt.cancelledBy -ne $null)
                if ($isDeleted) {
                    # no-op: dejar borrado; Fase 3 cancela la cita en Access
                }
            }
        }
    }
    $pullReader.Close()

    # Phase 3: Cancel unmatched, reactivate matched - BATCH OPERATIONS
    # NOTE: nunca cancelar citas pasadas (Fecha < hoy): el JSON solo contiene hoy/futuro
    # (purgePastAppointments), asi que sin este filtro la Fase 3 anularia el historial
    # reactivado en Access en cada sync. Solo se gestionan citas de hoy o futuras.
    # Solo se ejecuta la cancelacion si HAY citas activas de hoy/futuro sin emparejar:
    # en estado normal no hay, asi que no se toca la tabla y no se bloquean filas del usuario.
    $toCancelNcs = @($allAccessActive.Keys | Where-Object {
        -not $matchedNumCitas.ContainsKey($_) -and
        $accessSnapshot[$_] -and $accessSnapshot[$_].fecha -is [DateTime] -and
        $accessSnapshot[$_].fecha -ge (Get-Date).Date
    })
    if ($toCancelNcs.Count -gt 0) {
        if ($matchedNumCitas.Count -gt 0) {
            # Build list of matched num_cita values
            $matchedNcs = @($matchedNumCitas.Keys)
            $placeholders = ($matchedNcs | ForEach-Object { '?' }) -join ','

            $cancelAll = $conn.CreateCommand()
            $cancelAll.CommandText = "UPDATE Agenda SET Anulado=1 WHERE (Anulado = False OR Anulado IS NULL) AND (Fecha IS NULL OR Fecha >= ?) AND num_cita NOT IN ($placeholders)"
            Add-Param $cancelAll (Get-Date).Date
            foreach ($nc in $matchedNcs) {
                Add-Param $cancelAll $nc
            }
            $null = Invoke-SafeWrite $cancelAll 'cancel unmatched'
        } else {
            $cancelAll = $conn.CreateCommand()
            $cancelAll.CommandText = "UPDATE Agenda SET Anulado=1 WHERE (Anulado = False OR Anulado IS NULL) AND (Fecha IS NULL OR Fecha >= ?)"
            Add-Param $cancelAll (Get-Date).Date
            $null = Invoke-SafeWrite $cancelAll 'cancel unmatched'
        }
    }

    # Clean up duplicate cancelled records: batch DELETE
    $findDupes = $conn.CreateCommand()
    $findDupes.CommandText = "SELECT DISTINCT client_uid FROM Agenda WHERE client_uid IS NOT NULL AND client_uid <> '' AND Anulado=0"
    $activeUids = @()
    $rd = $findDupes.ExecuteReader()
    while ($rd.Read()) { $activeUids += $rd[0] }
    $rd.Close()

    $cleaned = 0
    if ($activeUids.Count -gt 0) {
        $uidPlaceholders = ($activeUids | ForEach-Object { '?' }) -join ','
        # Solo borrar si hay filas canceladas con esos uids (evitar el DELETE masivo que
        # toma locks de tabla cada ciclo aunque no haya nada que limpiar).
        $dupCheck = $conn.CreateCommand()
        $dupCheck.CommandText = "SELECT TOP 1 num_cita FROM Agenda WHERE client_uid IN ($uidPlaceholders) AND Anulado=True"
        foreach ($u in $activeUids) {
            Add-Param $dupCheck $u
        }
        $dupFound = $dupCheck.ExecuteScalar()
        if ($null -ne $dupFound) {
            $delDup = $conn.CreateCommand()
            $delDup.CommandText = "DELETE FROM Agenda WHERE client_uid IN ($uidPlaceholders) AND Anulado=True"
            foreach ($u in $activeUids) {
                Add-Param $delDup $u
            }
            if (Invoke-SafeWrite $delDup 'delete dupes') { $cleaned = 1 }
        }
    }

    # Phase 3.5: Pull client surnames (Apellidos) from Access Clientes, and the client
    # observations into the TPV "Historial Tecnico" (historialTecnico).
    # OJO: el programa de Access NO usa Clientes.Observaciones (esta vacio); las observaciones
    # de clientes viven en la tabla ObserClientes (CodCli + NumObservacion secuencial, una fila
    # por apunte). Se concatenan en orden cronologico separadas por salto de linea.
    # Se guarda una copia oculta (_obsAccess) del ultimo texto traido: si Access no ha cambiado
    # desde entonces, no se toca historialTecnico (asi las ediciones hechas en el TPV no se
    # pierden); si Access cambia (apunte nuevo/editado/borrado), manda Access y se sobrescribe.
    $surnamesPulled = 0
    $obsPulled = 0
    try {
        $jsonClientMap = @{}
        foreach ($jc in @($json.clients)) { if ($jc.id) { $jsonClientMap[$jc.id] = $jc } }

        # Observaciones por cliente desde ObserClientes, ordenadas por NumObservacion (cronologico)
        $obsByClient = @{}
        try {
            $cmdObs = $conn.CreateCommand()
            $cmdObs.CommandText = "SELECT CodCli, Observacion FROM ObserClientes ORDER BY CodCli, NumObservacion, Fecha"
            $or = $cmdObs.ExecuteReader()
            while ($or.Read()) {
                if ($or['CodCli'] -eq [System.DBNull]::Value) { continue }
                $codCli = [int]$or['CodCli']
                $txt = if ($or['Observacion'] -and $or['Observacion'] -ne [System.DBNull]::Value) { $or['Observacion'].ToString().Trim() } else { '' }
                if (-not $txt) { continue }
                if (-not $obsByClient.ContainsKey($codCli)) { $obsByClient[$codCli] = New-Object System.Collections.Generic.List[string] }
                $obsByClient[$codCli].Add($txt)
            }
            $or.Close()
        } catch {
            Write-Host "WARN: ObserClientes read skipped: $($_.Exception.Message)"
        }

        $cmdSurname = $conn.CreateCommand()
        $cmdSurname.CommandText = "SELECT Codigo, Apellidos FROM Clientes"
        $sr = $cmdSurname.ExecuteReader()
        while ($sr.Read()) {
            $codigo = $sr['Codigo']
            $matchId = "svcl_$codigo"
            if (-not $jsonClientMap.ContainsKey($matchId)) { continue }
            $jsonClient = $jsonClientMap[$matchId]
            $clientTouched = $false

            $apellidos = if ($sr['Apellidos']) { $sr['Apellidos'].ToString().Trim() } else { '' }
            if ($apellidos) {
                $curAp = if ($jsonClient.apellidos) { [string]$jsonClient.apellidos } else { '' }
                if ($curAp -ne $apellidos) {
                    Set-ApptField $jsonClient 'apellidos' $apellidos
                    $clientTouched = $true
                    $surnamesPulled++
                }
            }

            # Historial tecnico: todos los apuntes de ObserClientes del cliente, uno por linea
            $observaciones = ''
            $codKey = 0
            try { $codKey = [int]$codigo } catch { $codKey = 0 }
            if ($obsByClient.ContainsKey($codKey)) { $observaciones = ($obsByClient[$codKey] -join "`n") }
            $hasMarker = $jsonClient.PSObject.Properties['_obsAccess']
            $storedObs = if ($hasMarker) { [string]$jsonClient._obsAccess } else { $null }
            if ($observaciones -ne $storedObs) {
                # Access cambio (o primera vez). Solo escribir si trae texto, o si ya habiamos
                # sincronizado antes (permite propagar borrados de Access sin limpiar el TPV
                # cuando el cliente nunca tuvo apuntes).
                if ($observaciones -or $hasMarker) {
                    Set-ApptField $jsonClient 'historialTecnico' $observaciones
                    Set-ApptField $jsonClient '_obsAccess' $observaciones
                    $clientTouched = $true
                    $obsPulled++
                }
            }

            if ($clientTouched) {
                Set-ApptField $jsonClient '_modified' ([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
            }
        }
        $sr.Close()
    } catch {
        Write-Host "WARN: Apellidos/Observaciones sync skipped: $($_.Exception.Message)"
    }

    $shouldWrite = ($pulledFromAccess -gt 0 -or $accessCancelled -gt 0 -or $cleaned -gt 0 -or $surnamesPulled -gt 0 -or $obsPulled -gt 0 -or $accessSynced -gt 0)

    # Detect concurrent edits: if the JSON file changed while we were reading Access,
    # skip the JSON write so a stale snapshot never overwrites the TPV's latest changes.
    # (Sin transaccion no hay rollback: los writes ya hechos a Access se autocorrigen en
    # la siguiente ejecucion del ciclo.)
    $currentStamp = (Get-Item -LiteralPath $JsonFile).LastWriteTimeUtc
    if ($shouldWrite -and $currentStamp -ne $jsonFileStamp) {
        $conn.Close()
        Write-Host "ABORTED: JSON changed during processing ($($currentStamp.ToString('HH:mm:ss.fff')) != $($jsonFileStamp.ToString('HH:mm:ss.fff'))). Next run will re-sync."
        exit 0
    }

    $conn.Close()

    if ($shouldWrite) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($JsonFile, ($json | ConvertTo-Json -Depth 10), $utf8NoBom)
    }

    $sw.Stop()
    $wasAccess = $allAccessActive.Count
    $cancelled = $wasAccess - $updated
    Write-Host "OK (${($sw.Elapsed.TotalSeconds.ToString('0.00'))}s): $inserted inserted, $updated updated, $reactivated reactivated, $pulledFromAccess pulled, $accessCancelled access-cancelled, $cancelled cancelled, $cleaned dupes, $surnamesPulled surnames, $obsPulled obs->historial (JSON: $($activeAppts.Count), Access: $wasAccess)"
} catch {
    if ($conn -and $conn.State -ne 'Closed') { try { $conn.Close() } catch {} }
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
    exit 1
}
