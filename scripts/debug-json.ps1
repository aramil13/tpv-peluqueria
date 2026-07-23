$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()

$raw = Get-Content -Path 'C:\Users\tester\OneDrive\Documentos\carpeta para opencode\tpv para peluqueria\sync\appointments.json' -Encoding UTF8 -Raw
$json = $raw | ConvertFrom-Json

$employeeMap = @{}
foreach ($e in $json.employees) { if ($e.id) { $employeeMap[$e.id] = $e.name } }

foreach ($appt in $json.appointments) {
    if ($appt._deleted) { continue }
    $uid = $appt.id
    $notes = if ($appt.notes) { $appt.notes } else { '' }
    $clientId = if ($appt.clientId) { $appt.clientId } else { 'NONE' }
    $serviceId = if ($appt.serviceId) { $appt.serviceId } else { 'NONE' }
    $employeeId = if ($appt.employeeId) { $appt.employeeId } else { 'NONE' }

    if ($uid -match 'svap_(10044|10046|10045|1196|1197)') {
        Write-Host "JSON uid=$uid clientId=$clientId serviceId=$serviceId employeeId=$employeeId notes=$notes"
    }
}
$conn.Close()
