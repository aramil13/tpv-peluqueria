$connStr = 'Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb;Jet OLEDB:Database Password=131201%SolKerMediaP'
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT num_cita, Cliente, Fecha, Hora_Inicio, Motivo, Anulado FROM Agenda WHERE num_cita = 1312"
$reader = $cmd.ExecuteReader()
$found = $false
while ($reader.Read()) {
    $found = $true
    Write-Host "Found: num_cita=$($reader['num_cita']) Cliente=$($reader['Cliente']) Fecha=$($reader['Fecha']) Hora=$($reader['Hora_Inicio']) Motivo=$($reader['Motivo']) Anulado=$($reader['Anulado'])"
}
if (-not $found) { Write-Host 'NOT FOUND - num_cita 1312 does not exist in Access DB' }
$reader.Close()
$conn.Close()