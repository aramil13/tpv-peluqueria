param(
    [string]$DbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb',
    [switch]$DryRun
)

$dbPath = $DbPath
$password = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$password"

try {
    $today = (Get-Date).Date
    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $cmd = $conn.CreateCommand()

    if ($DryRun) {
        $cmd.CommandText = "SELECT COUNT(*) AS Total FROM Agenda WHERE Fecha IS NOT NULL AND Fecha < ?"
        $p = $cmd.CreateParameter()
        $p.Value = $today
        $cmd.Parameters.Add($p) | Out-Null
        $affected = [int]$cmd.ExecuteScalar()
        $conn.Close()
        Write-Host "DRYRUN: $affected citas anteriores a $($today.ToString('yyyy-MM-dd')) se reactivarian (Anulado=0)"
        return
    }

    $cmd.CommandText = "UPDATE Agenda SET Anulado = 0 WHERE Fecha IS NOT NULL AND Fecha < ?"
    $p = $cmd.CreateParameter()
    $p.Value = $today
    $cmd.Parameters.Add($p) | Out-Null
    $affected = $cmd.ExecuteNonQuery()
    $conn.Close()
    Write-Host "OK: $affected citas anteriores a $($today.ToString('yyyy-MM-dd')) reactivadas (Anulado=0). Estructura de la BD intacta."
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    exit 1
}
