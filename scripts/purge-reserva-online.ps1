$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"

$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()

$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT COUNT(*) FROM Agenda WHERE Motivo LIKE '%Reserva Online%' AND (Anulado = False OR Anulado IS NULL)"
$count = $cmd.ExecuteScalar()
Write-Host "Active Reserva Online in Access: $count"

$cmd2 = $conn.CreateCommand()
$cmd2.CommandText = "UPDATE Agenda SET Anulado = 1 WHERE Motivo LIKE '%Reserva Online%'"
$affected = $cmd2.ExecuteNonQuery()
Write-Host "Anulated all Reserva Online (including already anulated): $affected"

$cmd3 = $conn.CreateCommand()
$cmd3.CommandText = "SELECT COUNT(*) FROM Agenda WHERE Motivo LIKE '%Reserva Online%' AND (Anulado = False OR Anulado IS NULL)"
$remaining = $cmd3.ExecuteScalar()
Write-Host "Remaining active Reserva Online: $remaining"

$conn.Close()
