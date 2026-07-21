$connStr = 'Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb;Jet OLEDB:Database Password=131201%SolKerMediaP'
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT MAX(num_cita) FROM Agenda"
$r = $cmd.ExecuteScalar()
Write-Host "Max num_cita: $r"
$conn.Close()