$conn = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb;Jet OLEDB:Database Password=131201%SolKerMediaP")
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT TOP 20 num_cita, Fecha, Hora_Inicio, Hora_Final FROM Agenda ORDER BY Fecha, Hora_Inicio"
$da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
$dt = New-Object System.Data.DataTable
$da.Fill($dt)
$conn.Close()

$html = "<html><body><h2>Citas ($($dt.Rows.Count))</h2><table border=1><tr>"
foreach ($c in $dt.Columns) { $html += "<th>$($c.ColumnName)</th>" }
$html += "</tr>"
foreach ($r in $dt.Rows) {
    $html += "<tr>"
    foreach ($c in $dt.Columns) { $html += "<td>$($r[$c.ColumnName])</td>" }
    $html += "</tr>"
}
$html += "</table></body></html>"

$html | Out-File -FilePath "$env:TEMP\citas.html" -Encoding utf8
Start-Process "$env:TEMP\citas.html"
