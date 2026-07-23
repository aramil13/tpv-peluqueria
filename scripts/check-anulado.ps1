$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT num_cita, Anulado, client_uid, Motivo FROM Agenda WHERE num_cita IN (10281, 10280, 10247) ORDER BY num_cita"
$r = $cmd.ExecuteReader()
while ($r.Read()) {
    $anul = if ($r['Anulado']) { 'True' } else { 'False' }
    Write-Host "num_cita=$($r['num_cita']) Anulado=$anul uid=$($r['client_uid']) Motivo=$($r['Motivo'])"
}
$r.Close()
$conn.Close()
