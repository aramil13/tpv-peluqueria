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
    if (-not $timeStr) { return [DateTime]::Parse("1899-12-30 00:00:00") }
    $parts = $timeStr -split ':'
    $h = [int]$parts[0]
    $m = [int]$parts[1]
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

    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()

    # Build maps for matching
    $uidMap = @{}   # client_uid -> num_cita
    $keyMap = @{}   # "date|time|employee" -> num_cita (for fallback matching)
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT num_cita, client_uid, Fecha, Hora_Inicio, Empleado FROM Agenda WHERE (Anulado = False OR Anulado IS NULL)"
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
        $nc = $r['num_cita']
        $uid = $r['client_uid']
        if ($uid -and $uid -ne '') { $uidMap[$uid] = $nc }
        # Fallback key
        $f = $r['Fecha']
        $fi = $r['Hora_Inicio']
        $emp = $r['Empleado']
        if ($f -is [DateTime] -and $fi -is [DateTime]) {
            $key = "$($f.ToString('yyyy-MM-dd'))|$($fi.ToString('HH:mm'))|$emp"
            $keyMap[$key] = $nc
        }
    }
    $r.Close()

    # Get max num_cita for new inserts
    $maxCmd = $conn.CreateCommand()
    $maxCmd.CommandText = "SELECT MAX(num_cita) FROM Agenda"
    $maxResult = $maxCmd.ExecuteScalar()
    $nextNumCita = if ($maxResult -is [int]) { $maxResult + 1 } else { 10001 }

    $inserted = 0
    $updated = 0
    $matchedByExisting = 0

    foreach ($appt in $activeAppts) {
        $uid = $appt.id
        if (-not $uid) { continue }

        $clienteCode = Extract-Code $appt.clientId 'svcl_'
        $empleadoCode = Extract-Code $appt.employeeId 'svem_'
        $servicioCode = Extract-Code $appt.serviceId 'svsv_'
        $fecha = [DateTime]::Parse($appt.date)
        $horaInicio = Parse-Time $appt.time
        $horaFinal = Parse-Time $appt.endTime
        $motivo = if ($appt.notes) { [string]$appt.notes } else { '' }

        $existingNumCita = $null

        # Try matching by client_uid first
        if ($uidMap.ContainsKey($uid)) {
            $existingNumCita = $uidMap[$uid]
        } else {
            # Fallback: match by date+time+employee
            $key = "$($appt.date)|$($appt.time)|$empleadoCode"
            if ($keyMap.ContainsKey($key)) {
                $existingNumCita = $keyMap[$key]
                # Update the existing record's client_uid so next time it matches
                $fixUid = $conn.CreateCommand()
                $fixUid.CommandText = "UPDATE Agenda SET client_uid=? WHERE num_cita=?"
                Add-Param $fixUid $uid
                Add-Param $fixUid $existingNumCita
                $fixUid.ExecuteNonQuery() | Out-Null
            }
        }

        if ($existingNumCita -ne $null) {
            # UPDATE existing
            $upd = $conn.CreateCommand()
            $upd.CommandText = "UPDATE Agenda SET Cliente=?, Empleado=?, Servicio=?, Fecha=?, Hora_Inicio=?, Hora_Final=?, Motivo=?, Anulado=0, client_uid=? WHERE num_cita=?"
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
            $updated++
        } else {
            # INSERT new - generate num_cita
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
            # Also store back as svap_XXXX in the JSON for future matching
            $appt | Add-Member -NotePropertyName 'accessNumCita' -NotePropertyValue $nextNumCita -Force
            $nextNumCita++
            $inserted++
        }
    }

    # Write back any accessNumCita fields to the JSON
    $anyBackref = $false
    foreach ($appt in $json.appointments) {
        if ($appt.accessNumCita) { $anyBackref = $true }
    }
    if ($anyBackref) {
        $json | ConvertTo-Json -Depth 20 | Set-Content -Path $JsonFile -Encoding UTF8
    }

    # Mark orphaned records (no client_uid and not matched by key) as deleted
    $orphan = $conn.CreateCommand()
    $orphan.CommandText = "UPDATE Agenda SET Anulado=1 WHERE (client_uid IS NULL OR client_uid = '') AND (Anulado = False OR Anulado IS NULL)"
    $orphaned = $orphan.ExecuteNonQuery()

    $conn.Close()
    Write-Host "OK: $inserted inserted, $updated updated, $orphaned orphans cleaned (total active: $($activeAppts.Count))"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
    exit 1
}
