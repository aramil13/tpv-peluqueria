$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"
$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT TOP 15 num_cita, Motivo, Cliente, Empleado, Servicio, Anulado FROM Agenda WHERE Anulado=0 ORDER BY num_cita DESC"
$r = $cmd.ExecuteReader()
while ($r.Read()) {
    Write-Host "ID: $($r['num_cita']) | Motivo: $($r['Motivo']) | Cl: $($r['Cliente']) | Emp: $($r['Empleado']) | Svc: $($r['Servicio'])"
}
$r.Close()
$conn.Close()
