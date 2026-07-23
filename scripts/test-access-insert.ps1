$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()

$maxCmd = $conn.CreateCommand()
$maxCmd.CommandText = "SELECT MAX(num_cita) FROM Agenda"
$maxResult = $maxCmd.ExecuteScalar()
$nextNum = if ($maxResult -is [int]) { $maxResult + 1 } else { 10001 }

$cmd = $conn.CreateCommand()
$cmd.CommandText = "INSERT INTO Agenda (num_cita, Cliente, Empleado, Servicio, Fecha, Hora_Inicio, Hora_Final, Motivo, Anulado) VALUES (?,?,?,?,?,?,?,?,0)"
$p1 = $cmd.CreateParameter(); $p1.Value = $nextNum; $cmd.Parameters.Add($p1) | Out-Null
$p2 = $cmd.CreateParameter(); $p2.Value = 208; $cmd.Parameters.Add($p2) | Out-Null
$p3 = $cmd.CreateParameter(); $p3.Value = 3; $cmd.Parameters.Add($p3) | Out-Null
$p4 = $cmd.CreateParameter(); $p4.Value = 39; $cmd.Parameters.Add($p4) | Out-Null
$p5 = $cmd.CreateParameter(); $p5.Value = [DateTime]::Parse('2026-07-25'); $cmd.Parameters.Add($p5) | Out-Null
$p6 = $cmd.CreateParameter(); $p6.Value = [DateTime]::Parse('1899-12-30 11:00:00'); $cmd.Parameters.Add($p6) | Out-Null
$p7 = $cmd.CreateParameter(); $p7.Value = [DateTime]::Parse('1899-12-30 12:30:00'); $cmd.Parameters.Add($p7) | Out-Null
$p8 = $cmd.CreateParameter(); $p8.Value = 'Test bidireccional - Victor Alonso'; $cmd.Parameters.Add($p8) | Out-Null
$cmd.ExecuteNonQuery() | Out-Null

Write-Host "Inserted num_cita=$nextNum in Access (no client_uid)"

$conn.Close()
