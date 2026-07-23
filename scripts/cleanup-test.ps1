$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "UPDATE Agenda SET Anulado=1 WHERE num_cita=10289"
$cmd.ExecuteNonQuery()
$conn.Close()
Write-Host "Test record 10289 deleted"
