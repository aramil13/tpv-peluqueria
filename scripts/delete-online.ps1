$dbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb'
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"

$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()

# Find Victor Alonso clients
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT Codigo, Nombre, Apellidos, Telefono1 FROM Clientes WHERE Nombre LIKE '*Victor*' AND Apellidos LIKE '*Alonso*'"
$reader = $cmd.ExecuteReader()
$ids = @()
while ($reader.Read()) {
    $codigo = $reader['Codigo']
    $nombre = $reader['Nombre']
    $apellidos = $reader['Apellidos']
    $telefono = $reader['Telefono1']
    Write-Host "  Client: Codigo=$codigo Nombre=$nombre Apellidos=$apellidos Phone=$telefono"
    $ids += $codigo
}
$reader.Close()
Write-Host "Found $($ids.Count) Victor Alonso clients in Access"

# Delete appointments for these clients
foreach ($id in $ids) {
    $del = $conn.CreateCommand()
    $del.CommandText = "DELETE FROM Agenda WHERE Cliente = ?"
    $p = $del.CreateParameter()
    $p.Value = $id
    $del.Parameters.Add($p) | Out-Null
    $affected = $del.ExecuteNonQuery()
    Write-Host "  Deleted $affected appointments for client $id"
}

# Delete the clients
foreach ($id in $ids) {
    $del = $conn.CreateCommand()
    $del.CommandText = "DELETE FROM Clientes WHERE Codigo = ?"
    $p = $del.CreateParameter()
    $p.Value = $id
    $del.Parameters.Add($p) | Out-Null
    $affected = $del.ExecuteNonQuery()
    Write-Host "  Deleted client $id ($affected rows)"
}

# Verify
$cmd2 = $conn.CreateCommand()
$cmd2.CommandText = "SELECT COUNT(*) FROM Clientes WHERE Nombre LIKE '*Victor*' AND Apellidos LIKE '*Alonso*'"
$remaining = $cmd2.ExecuteScalar()
Write-Host "Remaining Victor Alonso clients in Access: $remaining"

$conn.Close()
Write-Host "Done"
