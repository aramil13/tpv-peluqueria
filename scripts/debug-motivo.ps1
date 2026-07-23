$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT TOP 5 num_cita, Motivo, client_uid FROM Agenda WHERE Anulado=0 AND (Cliente=0 OR Cliente IS NULL) ORDER BY num_cita DESC"
$r = $cmd.ExecuteReader()
while ($r.Read()) {
    Write-Host "ID: $($r['num_cita']) | UID: $($r['client_uid']) | Motivo: $($r['Motivo'])"
}
$r.Close()
$conn.Close()
