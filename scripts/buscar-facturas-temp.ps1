#Requires -Version 5.1
<#
.SYNOPSIS
  Busca facturas temporales en Cabecera_Factura_Temp entre dos fechas y muestra su detalle
  (Detalle_Factura_Temp y, si tambien existiera, Detalle_Factura) con desglose Base / IVA / Total.

.USO
  .\buscar-facturas-temp.ps1 -Desde 2026-05-01 -Hasta 2026-05-31
  .\buscar-facturas-temp.ps1                       # pedira las fechas
  .\buscar-facturas-temp.ps1 -Desde ... -Hasta ... -ExportarCsv "$env:USERPROFILE\Desktop\temp.csv"
  .\buscar-facturas-temp.ps1 -Desde ... -Hasta ... -Json   # salida JSON para el TPV
#>
param(
  [datetime]$Desde,
  [datetime]$Hasta,
  [string]$Bd = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb',
  [string]$ExportarCsv = '',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
if (-not $Desde) { $Desde = Read-Host 'Fecha DESDE (aaaa-mm-dd)' | ForEach-Object { [datetime]::Parse($_) } }
if (-not $Hasta) { $Hasta = Read-Host 'Fecha HASTA (aaaa-mm-dd)' | ForEach-Object { [datetime]::Parse($_) } }
if ($Hasta -lt $Desde) { if ($Json) { Write-Output '{"ok":false,"error":"Rango de fechas invalido"}' } else { Write-Host 'El rango de fechas es invalido.' -ForegroundColor Red }; exit 1 }
if ($Json) { try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {} }

$conn = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$Bd;Jet OLEDB:Database Password=131201%SolKerMediaP;")
$conn.Open()

function Invoke-Query([string]$sql, [object[]]$argsVals) {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = $sql
  foreach ($v in $argsVals) {
    $p = New-Object System.Data.OleDb.OleDbParameter
    if ($v -is [datetime]) { $p.OleDbType = [System.Data.OleDb.OleDbType]::Date }
    elseif ($v -is [int] -or $v -is [long] -or $v -is [double]) { $p.OleDbType = [System.Data.OleDb.OleDbType]::Double }
    else { $p.OleDbType = [System.Data.OleDb.OleDbType]::VarChar }
    [void]$cmd.Parameters.Add($p)
    $cmd.Parameters[$cmd.Parameters.Count - 1].Value = $v
  }
  $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
  $dt = New-Object System.Data.DataTable
  [void]$da.Fill($dt)
  $cmd.Dispose(); $da.Dispose()
  return , $dt
}

function Get-Num($v) { if ($null -eq $v -or $v -is [DBNull]) { 0 } else { [double]$v } }

$cabs = Invoke-Query "SELECT Numero, Fecha, Hora, Cliente, Empleado, total, Impuesto, ImpuestoIncluido, borrar FROM [Cabecera_Factura_Temp] WHERE Fecha >= ? AND Fecha < ? ORDER BY Fecha, Numero" @($Desde.Date, $Hasta.Date.AddDays(1))

if (-not $cabs.Rows.Count) {
  if ($Json) {
    Write-Output ([pscustomobject]@{ ok = $true; desde = $Desde.ToString('yyyy-MM-dd'); hasta = $Hasta.ToString('yyyy-MM-dd'); facturas = @(); resumen = [pscustomobject]@{ n = 0; base = 0; iva = 0; total = 0 } } | ConvertTo-Json -Depth 6)
    $conn.Close(); exit 0
  }
  Write-Host ("No hay facturas temporales entre {0:dd/MM/yyyy} y {1:dd/MM/yyyy}" -f $Desde, $Hasta) -ForegroundColor Yellow
  $conn.Close(); exit 0
}

$gBase = 0.0; $gIva = 0.0; $gTotal = 0.0; $csvRows = @(); $facturas = @()

foreach ($cab in $cabs.Rows) {
  $num = Get-Num $cab.Numero
  $incl = [bool]$cab.ImpuestoIncluido

  $marca = if ($cab.borrar) { ' [BORRADA]' } else { '' }
  $clienteTxt = if ((Get-Num $cab.Cliente) -eq 0) { 'Mostrador' } else { 'Cod. ' + $cab.Cliente }

  if (-not $Json) {
    Write-Host ''
    Write-Host ('=' * 78)
    Write-Host ("Factura TEMP #{0}{1}  |  {2:dd/MM/yyyy HH:mm}  |  {3}  |  {4}" -f $num, $marca, $cab.Fecha, $clienteTxt, $cab.Empleado) -ForegroundColor Cyan
    if ($incl) { Write-Host '(precios con IVA incluido)' -ForegroundColor DarkGray }
  }

  $detT = Invoke-Query "SELECT Producto, Unidades, Precio_Unit, Descuento, TipoImpuesto, NombreEmpleado, borrar FROM [Detalle_Factura_Temp] WHERE Num_Factura = ? ORDER BY indice" @($num)
  $detN = Invoke-Query "SELECT COUNT(*) AS n FROM [Detalle_Factura] WHERE Num_Factura = ?" @($num)
  $detalleEn = 'Detalle_Factura_Temp'

  if (-not $detT.Rows.Count -and (Get-Num $detN.Rows[0].n) -gt 0) {
    if (-not $Json) { Write-Host ('  (detalle encontrado en Detalle_Factura: {0} lineas)' -f (Get-Num $detN.Rows[0].n)) -ForegroundColor Yellow }
    $detalleEn = 'Detalle_Factura'
    $detT = Invoke-Query "SELECT Producto, Unidades, Precio_Unit, Descuento, TipoImpuesto, NombreEmpleado, borrar FROM [Detalle_Factura] WHERE Num_Factura = ? ORDER BY indice" @($num)
  }

  if (-not $detT.Rows.Count) {
    if (-not $Json) { Write-Host '  Sin lineas de detalle.' -ForegroundColor Yellow }
    continue
  }

  if (-not $Json) {
    Write-Host ("  {0,-38} {1,7} {2,10} {3,5} {4,5} {5,10}" -f 'Producto','Unid.','P.Unit','IVA%','Dto','Subtotal')
    Write-Host ("  {0}" -f ('-' * 78))
  }

  $rates = @{}
  $lineasArr = @()
  foreach ($l in $detT.Rows) {
    $u = Get-Num $l.Unidades
    $pu = Get-Num $l.Precio_Unit
    $dto = Get-Num $l.Descuento
    $rate = Get-Num $l.TipoImpuesto
    $bruto = $pu * $u * (1 - $dto / 100)
    $base = if ($incl) { $bruto / (1 + $rate / 100) } else { $bruto }
    $sub = $pu * $u
    if (-not $rates.ContainsKey($rate)) { $rates[$rate] = 0.0 }
    $rates[$rate] += $base
    $nombre = [string]$l.Producto
    $nombreCorto = if ($nombre.Length -gt 38) { $nombre.Substring(0, 38) } else { $nombre }
    $borradaL = if ($l.borrar) { ' *' } else { '' }
    if (-not $Json) {
      Write-Host ("  {0,-38} {1,7:n2} {2,10:n2} {3,5:n0} {4,5:n0} {5,10:n2}{6}" -f $nombreCorto, $u, $pu, $rate, $dto, $sub, $borradaL)
      $csvRows += [pscustomobject]@{
        Factura   = $num
        Fecha     = ([datetime]$cab.Fecha).ToString('dd/MM/yyyy')
        Producto  = $nombreCorto
        Unidades  = $u
        PrecioUnit= $pu
        Descuento = $dto
        TipoIva   = $rate
        Subtotal  = [math]::Round($sub, 2)
        Base      = [math]::Round($base, 2)
      }
    }
    $lineasArr += [pscustomobject]@{
      producto   = $nombre
      unidades   = [math]::Round($u, 2)
      precioUnit = [math]::Round($pu, 2)
      descuento  = [math]::Round($dto, 2)
      tipoIva    = [math]::Round($rate, 2)
      subtotal   = [math]::Round($sub, 2)
      base       = [math]::Round($base, 2)
      empleada   = [string]$l.NombreEmpleado
      borrada    = [bool]$l.borrar
    }
  }

  $totBase = ($rates.Values | Measure-Object -Sum).Sum
  $totIva = 0.0
  foreach ($k in $rates.Keys) { $totIva += $rates[$k] * $k / 100 }
  $totalCab = Get-Num $cab.total
  $dif = [math]::Round($totalCab - ($totBase + $totIva), 2)

  if (-not $Json) {
    Write-Host ("  {0}" -f ('-' * 78))
    foreach ($k in ($rates.Keys | Sort-Object)) {
      Write-Host ("  Base ({0,4:n0}%): {1,10:n2} EUR   Cuota IVA: {2,9:n2} EUR" -f $k, $rates[$k], ($rates[$k] * $k / 100))
    }
    Write-Host ("  TOTAL  Base: {0:n2} EUR  |  IVA: {1:n2} EUR  |  Total cabecera: {2:n2} EUR" -f $totBase, $totIva, $totalCab) -ForegroundColor Green
    if ([math]::Abs($dif) -ge 0.02) { Write-Host ("  AVISO: diferencia de {0:n2} EUR entre lineas y cabecera" -f $dif) -ForegroundColor Yellow }
  }

  $facturas += [pscustomobject]@{
    numero     = $num
    fecha      = ([datetime]$cab.Fecha).ToString('dd/MM/yyyy')
    cliente    = $clienteTxt
    empleado   = [string]$cab.Empleado
    borrada    = [bool]$cab.borrar
    ivaIncluido= $incl
    detalleEn  = $detalleEn
    lineas     = $lineasArr
    base       = [math]::Round($totBase, 2)
    iva        = [math]::Round($totIva, 2)
    total      = [math]::Round($totalCab, 2)
    descuadre  = $dif
  }

  $gBase += $totBase; $gIva += $totIva; $gTotal += $totalCab
}

if ($Json) {
  $out = [pscustomobject]@{
    ok       = $true
    desde    = $Desde.ToString('yyyy-MM-dd')
    hasta    = $Hasta.ToString('yyyy-MM-dd')
    facturas = @($facturas)
    resumen  = [pscustomobject]@{ n = $cabs.Rows.Count; base = [math]::Round($gBase, 2); iva = [math]::Round($gIva, 2); total = [math]::Round($gTotal, 2) }
  }
  Write-Output ($out | ConvertTo-Json -Depth 6)
  $conn.Close(); exit 0
}

Write-Host ''
Write-Host ('=' * 78)
Write-Host ("RESUMEN: {0} facturas temporales | Base: {1:n2} EUR | IVA: {2:n2} EUR | Total: {3:n2} EUR" -f $cabs.Rows.Count, $gBase, $gIva, $gTotal) -ForegroundColor Cyan
Write-Host ('=' * 78)

if ($ExportarCsv) {
  $csvRows | Export-Csv -Path $ExportarCsv -NoTypeInformation -Encoding UTF8
  Write-Host ("CSV exportado: {0}" -f $ExportarCsv) -ForegroundColor Green
}

$conn.Close()
