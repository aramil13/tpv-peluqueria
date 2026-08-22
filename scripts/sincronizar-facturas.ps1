param(
    [Parameter(Mandatory=$true)]
    [string]$JsonFile,
    [string]$DbPath = 'C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb',
    [switch]$SoloLeer
)

# Sincronizacion bidireccional de facturas/tickets entre Access (Cabecera/Detalle_Factura)
# y el JSON del TPV (data.sales).
#  - IMPORT : Access -> TPV. Facturas definitivas no borradas que falten en el TPV.
#             Deduplicacion por Numero de Access (sale.accessNumero) y por numero de ticket.
#  - EXPORT : TPV -> Access. Ventas del TPV sin _syncAccess, sin _origen access y no rectificativas.
#             Se insertan con Numero secuencial nuevo (max+1) en una sola transaccion.
# Pagos: Pago 1=Contado(cash), 2=Tarjeta(card), 3=Mixto(mixed con Tarjeta/Efectivo).

$dbPassword = '131201%SolKerMediaP'
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$DbPath;Jet OLEDB:Database Password=$dbPassword"

function R2($x) { [Math]::Round([double]$x, 2) }
function R3($x) { [Math]::Round([double]$x, 3) }
function Clip130($s) {
    $t = [string]$s
    if ($t.Length -gt 130) { return $t.Substring(0, 130) }
    return $t
}

$result = [ordered]@{ ok = $true; importados = 0; yaEnTpv = 0; exportados = 0; errores = @() }

try {
    if (-not (Test-Path -LiteralPath $JsonFile)) { throw "No existe el JSON: $JsonFile" }
    $jsonFileStamp = (Get-Item -LiteralPath $JsonFile).LastWriteTimeUtc
    $json = Get-Content -LiteralPath $JsonFile -Encoding UTF8 -Raw | ConvertFrom-Json
    if (-not $json.sales) { $json | Add-Member -NotePropertyName sales -NotePropertyValue @() }
    $sales = @($json.sales)

    # ---- mapas de ids TPV <-> codigos Access ----
    $clientByCode = @{}
    foreach ($c in @($json.clients)) {
        if ($c.id -match '^svcl_(\d+)$') { $clientByCode[[int]$Matches[1]] = [string]$c.id }
    }
    $empById = @{}
    foreach ($e in @($json.employees)) {
        $code = 0
        if ($e.id -match '^svem_(\d+)$') { $code = [int]$Matches[1] }
        $empById[[string]$e.id] = @{ code = $code; name = [string]$e.name }
    }
    $serviceCodes = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($s in @($json.services)) {
        if ($s.id -match '^svsv_(\d+)$') { [void]$serviceCodes.Add([int]$Matches[1]) }
    }

    function Get-Emp([string]$internalId) {
        if ($internalId -and $empById.ContainsKey($internalId)) { return $empById[$internalId] }
        return @{ code = 0; name = '' }
    }

    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()

    function Q($sql) {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sql
        $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
        $dt = New-Object System.Data.DataTable
        [void]$da.Fill($dt)
        return ,$dt
    }

    # ================= IMPORT (Access -> TPV) =================
    $cabeceras = Q "SELECT Numero, Fecha, Hora, Cliente, Empleado, Codigo_Empleado, Total, Impuesto, Impuesto_2, Pago, Tarjeta, Efectivo, Descuento FROM Cabecera_Factura WHERE Borrar=False"
    $detalles  = Q "SELECT Num_Factura, indice, Codigo, Producto, Unidades, Precio, Precio_Unit, NombreEmpleado FROM Detalle_Factura WHERE borrar=False ORDER BY Num_Factura, indice"

    $detByNum = @{}
    foreach ($dr in $detalles.Rows) {
        $n = [int][double]$dr['Num_Factura']
        if (-not $detByNum.ContainsKey($n)) { $detByNum[$n] = New-Object System.Collections.ArrayList }
        [void]$detByNum[$n].Add($dr)
    }

    $numerosTpv = New-Object 'System.Collections.Generic.HashSet[double]'
    foreach ($s in $sales) {
        if ($s.PSObject.Properties['accessNumero']) { [void]$numerosTpv.Add([double]$s.accessNumero) }
        elseif ($s.PSObject.Properties['_origen'] -and $s._origen -eq 'access' -and $s.PSObject.Properties['number']) { [void]$numerosTpv.Add([double]$s.number) }
    }

    $maxAccess = 0.0
    foreach ($cr in $cabeceras.Rows) { $v = [double]$cr['Numero']; if ($v -gt $maxAccess) { $maxAccess = $v } }
    # La numeracion exportada continua la secuencia de Cabecera_Factura (unicidad en Access);
    # los numeros de ticket del TPV no participan porque a cada venta se le asigna Numero nuevo.
    $nextNum = [Math]::Floor($maxAccess) + 1

    $importados = 0
    $yaEnTpv = 0
    foreach ($cr in $cabeceras.Rows) {
        $numero = [double]$cr['Numero']
        if ($numerosTpv.Contains($numero)) { $yaEnTpv++; continue }

        $fecha = $cr['Fecha']
        $hora = $cr['Hora']
        $dtLocal = [DateTime]$fecha
        if ($hora -is [DateTime]) { $dtLocal = ([DateTime]$fecha).Date.Add($hora.TimeOfDay) }

        $pagoCode = 0
        try { $pagoCode = [int]$cr['Pago'] } catch {}
        $pm = switch ($pagoCode) { 2 { 'card' } 3 { 'mixed' } default { 'cash' } }

        $total = R2 $cr['Total']
        $imp   = R2 (([double]$cr['Impuesto']) + ([double]$cr['Impuesto_2']))
        $baseV = R2 ($total - $imp)
        $dto   = R2 $cr['Descuento']

        $items = New-Object System.Collections.ArrayList
        $key = [int]$numero
        if ($detByNum.ContainsKey($key)) {
            foreach ($dr in $detByNum[$key]) {
                $qty = [Math]::Round([double]$dr['Unidades'], 3)
                if ($qty -eq 0) { $qty = 1 }
                $unit = [double]$dr['Precio_Unit']
                if ($unit -le 0) { $unit = ([double]$dr['Precio']) / [Math]::Abs($qty) }
                $codigo = 0
                try { $codigo = [int]$dr['Codigo'] } catch {}
                if ($serviceCodes.Contains($codigo)) { $itType = 'service'; $itId = "svsv_$codigo" }
                else { $itType = 'product'; $itId = '' }
                [void]$items.Add([ordered]@{
                    type = $itType; id = $itId
                    name = [string]$dr['Producto']
                    price = R2 $unit; qty = $qty
                })
            }
        }

        $clientId = ''
        $cliCode = 0
        try { $cliCode = [int]$cr['Cliente'] } catch {}
        if ($cliCode -gt 0 -and $clientByCode.ContainsKey($cliCode)) { $clientId = $clientByCode[$cliCode] }

        $sale = [ordered]@{
            id = "acc-$([int]$numero)"
            number = [int]$numero
            invoiceNumber = $null
            items = $items
            total = $total
            base = $baseV
            iva = $imp
            clientId = $clientId
            date = $dtLocal.ToString('yyyy-MM-ddTHH:mm:ss')
            paymentMethod = $pm
            discount = $dto
            accessNumero = [int]$numero
            _origen = 'access'
        }
        if ($pm -eq 'mixed') {
            $tarj = R2 $cr['Tarjeta']; $efe = R2 $cr['Efectivo']
            if ($tarj -gt 0 -or $efe -gt 0) { $sale.cardAmount = $tarj; $sale.cashAmount = $efe }
        }
        $sales += [pscustomobject]$sale
        [void]$numerosTpv.Add($numero)
        $importados++
    }
    $result.importados = $importados
    $result.yaEnTpv = $yaEnTpv
    $json.sales = $sales

    # ================= EXPORT (TPV -> Access) =================
    $pendientes = @($sales | Where-Object {
        $s = $_
        (-not $s.PSObject.Properties['_origen'] -or $s._origen -ne 'access') -and
        (-not $s.PSObject.Properties['_syncAccess']) -and
        (-not $s.PSObject.Properties['isRectifying'] -or -not $s.isRectifying) -and
        ($s.PSObject.Properties['items'] -and @($s.items).Count -gt 0) -and
        ($s.PSObject.Properties['total'])
    })

    if (-not $SoloLeer -and $pendientes.Count -gt 0) {
        $tx = $conn.BeginTransaction()
        $exportados = 0
        $asignados = New-Object System.Collections.ArrayList
        $numeroActual = 0
        $indiceActual = 0
        try {
            foreach ($s in $pendientes) {
                # idempotencia: si ya existe una cabecera identica (fecha+total+cliente), no reexportar
                $chk = $conn.CreateCommand()
                $chk.Transaction = $tx
                $chk.CommandText = "SELECT TOP 1 Numero FROM Cabecera_Factura WHERE Fecha = ? AND Total = ? AND Cliente = ? ORDER BY Numero DESC"
                foreach ($v in @([DateTime]$fechaAcc, [double]$total, [int]$cliCode)) { $pp = $chk.CreateParameter(); $pp.Value = $v; [void]$chk.Parameters.Add($pp) }
                $existente = $chk.ExecuteScalar()
                $chk.Dispose()
                if ($null -ne $existente) {
                    [void]$asignados.Add(@{ sale = $s; numero = [int][double]$existente })
                    continue
                }
                $numero = $nextNum; $nextNum++
                $numeroActual = $numero
                [void]$asignados.Add(@{ sale = $s; numero = [int]$numero })

                $fechaVenta = if ($s.PSObject.Properties['date'] -and $s.date) { [DateTime]$s.date } else { Get-Date }
                $fechaAcc = [DateTime]$fechaVenta.Date
                    $horaAcc = [DateTime]::Parse('1899-12-30').AddSeconds([Math]::Floor($fechaVenta.TimeOfDay.TotalSeconds))

                $cliCode = 0
                if ($s.clientId -match '^svcl_(\d+)$') { $cliCode = [int]$Matches[1] }

                $empCode = 0; $empName = ''
                $firstEmp = @($s.items | Where-Object { $_.employeeId } | Select-Object -First 1)
                if ($firstEmp.Count -gt 0) {
                    $ei = Get-Emp ([string]$firstEmp[0].employeeId)
                    $empCode = $ei.code; $empName = $ei.name
                }

                $pm = [string]$s.paymentMethod
                if (-not $pm) { $pm = 'cash' }
                $pagoCode = switch ($pm) { 'card' { 2 } 'mixed' { 3 } default { 1 } }
                $tarj = 0.0; $efe = 0.0
                if ($pm -eq 'mixed') {
                    if ($s.PSObject.Properties['cardAmount']) { $tarj = R2 $s.cardAmount }
                    if ($s.PSObject.Properties['cashAmount']) { $efe = R2 $s.cashAmount }
                    if (($tarj + $efe) -eq 0) { $tarj = R2 $s.total }
                }

                $total = R2 $s.total
                $imp = if ($s.PSObject.Properties['iva'] -and $null -ne $s.iva) { R2 $s.iva } else { R2 ($total * 21 / 121) }
                $dto = if ($s.PSObject.Properties['discount'] -and $null -ne $s.discount) { R2 $s.discount } else { 0.0 }

                $insCab = $conn.CreateCommand()
                $insCab.Transaction = $tx
                $insCab.CommandText = "INSERT INTO Cabecera_Factura (Numero, Fecha, FechaVenta, Hora, Hora_Inicio, Cliente, Mesa, Comensales, Zona_Venta, Empleado, Codigo_Empleado, Total, Impuesto, Impuesto_2, ImpuestoIncluido, Pago, Tarjeta, Efectivo, Recargo, Descuento, Borrar, Cierre, Terminal, Repartidor, Num_Albaran, CaracteristicaVenta, Observaciones, consumoDinDeposito, PagoDinDeposito, numCierre, PagoValeDescuento, PagoTarjetaRegalo, PagoValePromo, ImporteBonoDenda) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                $vals = @(
                    [double]$numero, $fechaAcc, $fechaAcc, $horaAcc, [DateTime]::Parse('1899-12-30'),
                    [int]$cliCode, 0, 0, 0, (Clip130 $empName), [int]$empCode,
                    $total, $imp, 0.0, $true, [int]$pagoCode, $tarj, $efe, 0.0, $dto,
                    $false, $false, '1', 0, 0, '', '', 0.0, 0.0, 0, 0.0, 0.0, 0.0, 0.0
                )
                foreach ($v in $vals) {
                    $p = $insCab.CreateParameter(); $p.Value = $v; [void]$insCab.Parameters.Add($p)
                }
                [void]$insCab.ExecuteNonQuery()
                $insCab.Dispose()

                $indice = 0
                foreach ($it in @($s.items)) {
                    $indice++
                    $indiceActual = $indice
                    $qty = if ($it.PSObject.Properties['qty']) { [double]$it.qty } else { 1 }
                    if ($qty -eq 0) { $qty = 1 }
                    $unit = if ($it.PSObject.Properties['price']) { [double]$it.price } else { 0 }
                    $linea = R2 ($unit * $qty)
                    $ivaRate = if ($s.PSObject.Properties['ivaRate'] -and $s.ivaRate) { [double]$s.ivaRate } else { 21 }
                    $lineIva = R3 ($linea * $ivaRate / (100 + $ivaRate))

                    $codArt = 0
                    if ($it.id -match '^svsv_(\d+)$') { $codArt = [int]$Matches[1] }
                    $iEmpCode = 0; $iEmpName = ''
                    if ($it.PSObject.Properties['employeeId'] -and $it.employeeId) {
                        $ie = Get-Emp ([string]$it.employeeId)
                        $iEmpCode = $ie.code; $iEmpName = $ie.name
                    }

                    $insDet = $conn.CreateCommand()
                    $insDet.Transaction = $tx
                    $insDet.CommandText = "INSERT INTO Detalle_Factura (Num_Factura, indice, Codigo, Producto, Unidades, Precio, Precio_Unit, Coste, Descuento, Impuesto, TipoImpuesto, Impuesto_2, borrar, codEmpleado, NombreEmpleado, CodFamilia, Menu, ProductoDeMenu, Recargo, MargenComercial, Tipo_Venta, Num_Albaran) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
                    $dvals = @(
                        [int]$numero, [int]$indice, [int]$codArt, (Clip130 $it.name),
                        $qty, $linea, (R2 $unit), 0.0, 0.0, $lineIva, 1.0, 0.0,
                        $false, [int]$iEmpCode, (Clip130 $iEmpName), 0, $false, $false, 0.0, 0.0, '', 0
                    )
                    foreach ($v in $dvals) {
                        $p = $insDet.CreateParameter(); $p.Value = $v; [void]$insDet.Parameters.Add($p)
                    }
                    [void]$insDet.ExecuteNonQuery()
                    $insDet.Dispose()
                }
                $exportados++
            }
            $tx.Commit()
            $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            foreach ($par in $asignados) {
                $s = $par.sale
                if ($s.PSObject.Properties['accessNumero']) { $s.accessNumero = $par.numero }
                else { $s | Add-Member -NotePropertyName accessNumero -NotePropertyValue $par.numero }
                if ($s.PSObject.Properties['_syncAccess']) { $s._syncAccess = $ts }
                else { $s | Add-Member -NotePropertyName _syncAccess -NotePropertyValue $ts }
            }
            $result.exportados = $exportados
        } catch {
            try { $tx.Rollback() } catch {}
            $result.ok = $false
            $ex = $_.Exception
            $detalle = $ex.Message
            while ($ex.InnerException) { $ex = $ex.InnerException; $detalle += ' << ' + $ex.Message }
            $result.errores += ("EXPORT (venta #$numeroActual, linea $indiceActual): " + $detalle)
        }
    }

    $conn.Close()

    # ================= guardar JSON =================
    $shouldWrite = (-not $SoloLeer) -and (-not $DbPath) -and ($importados -gt 0 -or $result.exportados -gt 0)
    if ($shouldWrite) {
        $currentStamp = (Get-Item -LiteralPath $JsonFile).LastWriteTimeUtc
        if ($currentStamp -ne $jsonFileStamp) {
            $result.ok = $false
            $result.errores += "El JSON cambio durante el proceso; reintenta (no se escribio nada)."
        } else {
            $utf8NoBom = New-Object System.Text.UTF8Encoding $false
            $tmp = "$JsonFile.tmp"
            [System.IO.File]::WriteAllText($tmp, ($json | ConvertTo-Json -Depth 30), $utf8NoBom)
            Move-Item -Force -LiteralPath $tmp -Destination $JsonFile
        }
    }

    $result | ConvertTo-Json -Depth 6 -Compress
} catch {
    if ($conn -and $conn.State -ne 'Closed') { try { $conn.Close() } catch {} }
    @{ ok = $false; error = ($_.Exception.Message + ' @ ' + ($_.InvocationInfo.ScriptLineNumber)); importados = 0; exportados = 0; yaEnTpv = 0; errores = @() } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
