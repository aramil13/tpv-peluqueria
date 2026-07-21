try {
    $conn = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb;Jet OLEDB:Database Password=131201%SolKerMediaP")
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT TOP 10 num_cita, Fecha, Hora_Inicio FROM Agenda ORDER BY num_cita"
    $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
    $dt = New-Object System.Data.DataTable
    $da.Fill($dt)
    $conn.Close()
    Write-Host "OK: $($dt.Rows.Count) filas"
    $dt | Out-GridView -Title "TEST - $($dt.Rows.Count) filas"
} catch {
    Write-Host "ERROR: $_"
    [System.Windows.Forms.MessageBox]::Show("Error: $_","Error","OK","Error")
}
