$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb;Jet OLEDB:Database Password=131201%SolKerMediaP"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8080/")
$listener.Start()
Write-Host "Servidor iniciado"
Start-Process "http://localhost:8080"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $path = $req.Url.AbsolutePath
    Write-Host "-> $path"

    try {
        if ($path -eq "/") {
            $html = @"
<html><body>
<h2>Test BD</h2>
<button onclick="testEmpleados()">Empleados</button>
<button onclick="testCitas()">Citas</button>
<div id="result"></div>
<script>
async function testEmpleados(){
  const r=await fetch('/api/empleados');
  document.getElementById('result').textContent=await r.text();
}
async function testCitas(){
  const r=await fetch('/api/citas?f=07/10/2026&e=&a=1');
  document.getElementById('result').textContent=await r.text();
}
</script>
</body></html>
"@
            $buff = [Text.Encoding]::UTF8.GetBytes($html)
            $res.ContentType = "text/html"
        }
        elseif ($path -eq "/api/empleados") {
            $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
            $conn.Open()
            $cmd = $conn.CreateCommand()
            $cmd.CommandText = "SELECT Codigo, Nombre FROM Empleados ORDER BY Nombre"
            $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
            $dt = New-Object System.Data.DataTable
            [void]$da.Fill($dt)
            $conn.Close()
            Write-Host "  Empleados: $($dt.Rows.Count) filas"
            $arr = @()
            foreach ($row in $dt.Rows) {
                $arr += [PSCustomObject]@{Codigo=$row.Codigo; Nombre=$row.Nombre}
            }
            $json = $arr | ConvertTo-Json
            Write-Host "  JSON: $json"
            $buff = [Text.Encoding]::UTF8.GetBytes($json)
            $res.ContentType = "application/json"
        }
        elseif ($path -eq "/api/citas") {
            $f = $req.QueryString["f"]
            Write-Host "  Fecha: $f"
            $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
            $conn.Open()
            $cmd = $conn.CreateCommand()
            $cmd.CommandText = "SELECT num_cita, Fecha, Hora_Inicio FROM Agenda WHERE Fecha = #$f# ORDER BY Hora_Inicio"
            $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
            $dt = New-Object System.Data.DataTable
            [void]$da.Fill($dt)
            $conn.Close()
            Write-Host "  Citas: $($dt.Rows.Count) filas"
            $arr = @()
            foreach ($row in $dt.Rows) {
                $arr += [PSCustomObject]@{
                    num_cita = $row.num_cita
                    Fecha = $row.Fecha.ToString("yyyy-MM-dd")
                    Hora_Inicio = $row.Hora_Inicio.ToString("HH:mm")
                }
            }
            $json = $arr | ConvertTo-Json
            Write-Host "  JSON: $json"
            $buff = [Text.Encoding]::UTF8.GetBytes($json)
            $res.ContentType = "application/json"
        }
        else {
            $buff = [Text.Encoding]::UTF8.GetBytes("Not found")
        }
    } catch {
        Write-Host "  ERROR: $_"
        $buff = [Text.Encoding]::UTF8.GetBytes("Error: $_")
    }

    $res.ContentLength64 = $buff.Length
    $res.OutputStream.Write($buff, 0, $buff.Length)
    $res.OutputStream.Close()
}
