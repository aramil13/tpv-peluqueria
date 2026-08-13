Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dbPath = "C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb"
$dbPassword = "131201%SolKerMediaP"
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$dbPassword"

$script:currentDt = $null

function QueryInto($sql) {
    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
    $script:currentDt = New-Object System.Data.DataTable
    $da.Fill($script:currentDt)
    $conn.Close()
}

function ExecuteNonQuery($sql) {
    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $r = $cmd.ExecuteNonQuery()
    $conn.Close()
    return $r
}

$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = "Gestor de Citas - TPV Peluqueria"
$script:form.Size = New-Object System.Drawing.Size(1300, 780)
$script:form.StartPosition = "CenterScreen"
$script:form.MinimumSize = New-Object System.Drawing.Size(900, 500)

$topPanel = New-Object System.Windows.Forms.Panel
$topPanel.Dock = "Top"
$topPanel.Height = 40

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "GESTOR DE CITAS"
$lblTitle.Font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
$lblTitle.AutoSize = $true
$lblTitle.Location = New-Object System.Drawing.Point(10, 8)

$script:lblStatus = New-Object System.Windows.Forms.Label
$script:lblStatus.Text = "Cargando..."
$script:lblStatus.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$script:lblStatus.ForeColor = "DarkBlue"
$script:lblStatus.AutoSize = $true
$script:lblStatus.Location = New-Object System.Drawing.Point(200, 12)

$topPanel.Controls.AddRange(@($lblTitle, $script:lblStatus))

$filterPanel = New-Object System.Windows.Forms.Panel
$filterPanel.Dock = "Top"
$filterPanel.Height = 35

$lblFecha = New-Object System.Windows.Forms.Label
$lblFecha.Text = "Fecha:"
$lblFecha.AutoSize = $true
$lblFecha.Location = New-Object System.Drawing.Point(10, 8)

$script:dtpFecha = New-Object System.Windows.Forms.DateTimePicker
$script:dtpFecha.Format = "Short"
$script:dtpFecha.Location = New-Object System.Drawing.Point(60, 5)
$script:dtpFecha.Size = New-Object System.Drawing.Size(120, 23)

$lblEmp = New-Object System.Windows.Forms.Label
$lblEmp.Text = "Empleado:"
$lblEmp.AutoSize = $true
$lblEmp.Location = New-Object System.Drawing.Point(200, 8)

$script:cmbEmpleado = New-Object System.Windows.Forms.ComboBox
$script:cmbEmpleado.Location = New-Object System.Drawing.Point(270, 5)
$script:cmbEmpleado.Size = New-Object System.Drawing.Size(150, 23)
$script:cmbEmpleado.DropDownStyle = "DropDownList"

$script:chkAnuladas = New-Object System.Windows.Forms.CheckBox
$script:chkAnuladas.Text = "Mostrar anuladas"
$script:chkAnuladas.AutoSize = $true
$script:chkAnuladas.Location = New-Object System.Drawing.Point(440, 7)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = "Refrescar"
$btnRefresh.Location = New-Object System.Drawing.Point(580, 4)
$btnRefresh.Size = New-Object System.Drawing.Size(90, 26)
$btnRefresh.Add_Click({ LoadCitas })

$btnEditar = New-Object System.Windows.Forms.Button
$btnEditar.Text = "Editar"
$btnEditar.Location = New-Object System.Drawing.Point(680, 4)
$btnEditar.Size = New-Object System.Drawing.Size(80, 26)
$btnEditar.BackColor = [System.Drawing.Color]::FromArgb(52, 152, 219)
$btnEditar.ForeColor = [System.Drawing.Color]::White
$btnEditar.Add_Click({
    if ($script:grid.SelectedRows.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show("Selecciona una cita primero.", "Editar", "OK", "Info")
        return
    }
    $row = $script:grid.SelectedRows[0]
    $id = $row.Cells["num_cita"].Value
    if ($id) { EditarCita $id }
})

$btnAnular = New-Object System.Windows.Forms.Button
$btnAnular.Text = "Anular"
$btnAnular.Location = New-Object System.Drawing.Point(770, 4)
$btnAnular.Size = New-Object System.Drawing.Size(80, 26)
$btnAnular.BackColor = [System.Drawing.Color]::FromArgb(231, 76, 60)
$btnAnular.ForeColor = [System.Drawing.Color]::White
$btnAnular.Add_Click({
    if ($script:grid.SelectedRows.Count -eq 0) { return }
    $row = $script:grid.SelectedRows[0]
    $id = $row.Cells["num_cita"].Value
    $confirm = [System.Windows.Forms.MessageBox]::Show("Anular cita #$id?", "Confirmar", "YesNo", "Warning")
    if ($confirm -eq "Yes") {
        try {
            ExecuteNonQuery("UPDATE Agenda SET Anulado = 1 WHERE num_cita = $id")
            LoadCitas
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Error: $_", "Error", "OK", "Error")
        }
    }
})

$btnReactivar = New-Object System.Windows.Forms.Button
$btnReactivar.Text = "Reactivar"
$btnReactivar.Location = New-Object System.Drawing.Point(860, 4)
$btnReactivar.Size = New-Object System.Drawing.Size(90, 26)
$btnReactivar.BackColor = [System.Drawing.Color]::FromArgb(39, 174, 96)
$btnReactivar.ForeColor = [System.Drawing.Color]::White
$btnReactivar.Add_Click({
    if ($script:grid.SelectedRows.Count -eq 0) { return }
    $row = $script:grid.SelectedRows[0]
    $id = $row.Cells["num_cita"].Value
    $confirm = [System.Windows.Forms.MessageBox]::Show("Reactivar cita #$id?", "Confirmar", "YesNo", "Info")
    if ($confirm -eq "Yes") {
        try {
            ExecuteNonQuery("UPDATE Agenda SET Anulado = 0 WHERE num_cita = $id")
            LoadCitas
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Error: $_", "Error", "OK", "Error")
        }
    }
})

$filterPanel.Controls.AddRange(@($lblFecha, $script:dtpFecha, $lblEmp, $script:cmbEmpleado, $script:chkAnuladas, $btnRefresh, $btnEditar, $btnAnular, $btnReactivar))

$script:grid = New-Object System.Windows.Forms.DataGridView
$script:grid.Dock = "Fill"
$script:grid.AllowUserToAddRows = $false
$script:grid.AllowUserToDeleteRows = $false
$script:grid.SelectionMode = "FullRowSelect"
$script:grid.MultiSelect = $false
$script:grid.RowHeadersVisible = $false
$script:grid.AutoSizeColumnsMode = "AllCells"
$script:grid.BackgroundColor = "White"
$script:grid.DefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$script:grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$script:grid.AlternatingRowsDefaultCellStyle.BackColor = [System.Drawing.Color]::FromArgb(245, 245, 245)

$script:editableColumns = @("Hora_Inicio", "Hora_Final", "Motivo", "Observaciones")
$script:grid.Add_CellBeginEdit({
    param($sender, $e)
    $colName = $script:grid.Columns[$e.ColumnIndex].Name
    if ($colName -notin $script:editableColumns) {
        $e.Cancel = $true
    }
})
$script:grid.Add_CellEndEdit({
    param($sender, $e)
    if ($e.RowIndex -lt 0 -or $e.RowIndex -ge $script:grid.Rows.Count) { return }
    $row = $script:grid.Rows[$e.RowIndex]
    $colName = $script:grid.Columns[$e.ColumnIndex].Name
    $newVal = $row.Cells[$colName].Value
    $id = $row.Cells["num_cita"].Value
    if (-not $id) { return }

    if ($newVal -eq $null -or $newVal -eq [System.DBNull]::Value) {
        $newValSql = "NULL"
    } elseif ($newVal -is [DateTime]) {
        $newValSql = "#$($newVal.ToString('yyyy-MM-dd HH:mm:ss'))#"
    } elseif ($newVal -is [string]) {
        $escaped = $newVal -replace "'", "''"
        $newValSql = "'$escaped'"
    } else {
        $newValSql = "$newVal"
    }

    $sql = "UPDATE Agenda SET [$colName] = $newValSql WHERE num_cita = $id"
    try {
        ExecuteNonQuery($sql)
        $script:lblStatus.Text = "Guardado: $colName cita #$id"
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Error al guardar: $_", "Error", "OK", "Error")
        LoadCitas
    }
})

function LoadCitas {
    $fecha = $script:dtpFecha.Value.ToString("MM/dd/yyyy")
    $sql = "SELECT a.num_cita, (c.Nombre & ' ' & IIF(ISNULL(c.Apellidos),'',c.Apellidos)) AS Cliente, c.Telefono1 AS Telefono, e.Nombre AS Empleado, s.Nombre AS Servicio, a.Hora_Inicio, a.Hora_Final, a.Motivo, a.Observaciones, a.Anulado FROM ((Agenda a LEFT JOIN Clientes c ON a.Cliente = c.Codigo) LEFT JOIN Empleados e ON a.Empleado = e.Codigo) LEFT JOIN Servicios s ON a.Servicio = s.Codigo WHERE a.Fecha = #$fecha#"

    $selEmp = $script:cmbEmpleado.SelectedItem
    if ($selEmp -and $selEmp -ne "(Todos)") {
        $empCode = ($selEmp -split "\|")[1]
        $sql += " AND a.Empleado = $empCode"
    }

    if (-not $script:chkAnuladas.Checked) {
        $sql += " AND (a.Anulado IS NULL OR a.Anulado = 0)"
    }

    $sql += " ORDER BY a.Hora_Inicio"

    try {
        QueryInto($sql)
        $script:grid.DataSource = $script:currentDt
        $script:grid.Refresh()
        $script:lblStatus.Text = "$($script:currentDt.Rows.Count) citas encontradas"
    } catch {
        $script:lblStatus.Text = "Error: $_"
    }
}

function LoadEmpleados {
    try {
        QueryInto("SELECT Codigo, Nombre FROM Empleados ORDER BY Nombre")
        $script:cmbEmpleado.Items.Clear()
        $script:cmbEmpleado.Items.Add("(Todos)")
        foreach ($r in $script:currentDt.Rows) {
            $script:cmbEmpleado.Items.Add("$($r.Nombre)|$($r.Codigo)")
        }
        $script:cmbEmpleado.SelectedIndex = 0
    } catch {
        $script:lblStatus.Text = "Error cargando empleados: $_"
    }
}

function EditarCita($id) {
    try {
        QueryInto("SELECT * FROM Agenda WHERE num_cita = $id")
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Error al cargar la cita: $_", "Error", "OK", "Error")
        return
    }
    if ($script:currentDt.Rows.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show("No se encontro la cita #$id", "Editar", "OK", "Warning")
        return
    }
    $row = $script:currentDt.Rows[0]

    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = "Editar cita #$id"
    $dlg.Size = New-Object System.Drawing.Size(460, 520)
    $dlg.StartPosition = "CenterParent"
    $dlg.Font = New-Object System.Drawing.Font("Segoe UI", 9)

    $pnl = New-Object System.Windows.Forms.Panel
    $pnl.Dock = "Fill"
    $pnl.Padding = New-Object System.Windows.Forms.Padding(12)

    $y = 10

    $lblCliente = New-Object System.Windows.Forms.Label
    $lblCliente.Text = "Cliente:"
    $lblCliente.Location = New-Object System.Drawing.Point(12, ($y + 3))
    $lblCliente.AutoSize = $true

    $txtCliente = New-Object System.Windows.Forms.TextBox
    $txtCliente.Location = New-Object System.Drawing.Point(150, $y)
    $txtCliente.Size = New-Object System.Drawing.Size(270, 23)
    $pnl.Controls.AddRange(@($lblCliente, $txtCliente))
    $y += 30

    $lblEmp = New-Object System.Windows.Forms.Label
    $lblEmp.Text = "Empleado:"
    $lblEmp.Location = New-Object System.Drawing.Point(12, ($y + 3))
    $lblEmp.AutoSize = $true

    $txtEmpleado = New-Object System.Windows.Forms.TextBox
    $txtEmpleado.Location = New-Object System.Drawing.Point(150, $y)
    $txtEmpleado.Size = New-Object System.Drawing.Size(270, 23)
    $pnl.Controls.AddRange(@($lblEmp, $txtEmpleado))
    $y += 30

    $lblServ = New-Object System.Windows.Forms.Label
    $lblServ.Text = "Servicio:"
    $lblServ.Location = New-Object System.Drawing.Point(12, ($y + 3))
    $lblServ.AutoSize = $true

    $txtServicio = New-Object System.Windows.Forms.TextBox
    $txtServicio.Location = New-Object System.Drawing.Point(150, $y)
    $txtServicio.Size = New-Object System.Drawing.Size(270, 23)
    $pnl.Controls.AddRange(@($lblServ, $txtServicio))
    $y += 30

    $lblFecha = New-Object System.Windows.Forms.Label
    $lblFecha.Text = "Fecha:"
    $lblFecha.Location = New-Object System.Drawing.Point(12, ($y + 3))
    $lblFecha.AutoSize = $true

    $dtpFecha = New-Object System.Windows.Forms.DateTimePicker
    $dtpFecha.Location = New-Object System.Drawing.Point(150, $y)
    $dtpFecha.Size = New-Object System.Drawing.Size(150, 23)
    $dtpFecha.Format = "Short"
    $pnl.Controls.AddRange(@($lblFecha, $dtpFecha))
    $y += 30

    $lblHora = New-Object System.Windows.Forms.Label
    $lblHora.Text = "Hora Inicio:"
    $lblHora.Location = New-Object System.Drawing.Point(12, ($y + 3))
    $lblHora.AutoSize = $true

    $dtpHoraIni = New-Object System.Windows.Forms.DateTimePicker
    $dtpHoraIni.Location = New-Object System.Drawing.Point(150, $y)
    $dtpHoraIni.Size = New-Object System.Drawing.Size(100, 23)
    $dtpHoraIni.Format = "Time"
    $dtpHoraIni.ShowUpDown = $true

    $lblHoraFin = New-Object System.Windows.Forms.Label
    $lblHoraFin.Text = "Hora Fin:"
    $lblHoraFin.Location = New-Object System.Drawing.Point(260, ($y + 3))
    $lblHoraFin.AutoSize = $true

    $dtpHoraFin = New-Object System.Windows.Forms.DateTimePicker
    $dtpHoraFin.Location = New-Object System.Drawing.Point(330, $y)
    $dtpHoraFin.Size = New-Object System.Drawing.Size(90, 23)
    $dtpHoraFin.Format = "Time"
    $dtpHoraFin.ShowUpDown = $true
    $pnl.Controls.AddRange(@($lblHora, $dtpHoraIni, $lblHoraFin, $dtpHoraFin))
    $y += 30

    $lblMotivo = New-Object System.Windows.Forms.Label
    $lblMotivo.Text = "Motivo:"
    $lblMotivo.Location = New-Object System.Drawing.Point(12, ($y + 3))
    $lblMotivo.AutoSize = $true

    $txtMotivo = New-Object System.Windows.Forms.TextBox
    $txtMotivo.Location = New-Object System.Drawing.Point(150, $y)
    $txtMotivo.Size = New-Object System.Drawing.Size(270, 23)
    $pnl.Controls.AddRange(@($lblMotivo, $txtMotivo))
    $y += 30

    $lblObs = New-Object System.Windows.Forms.Label
    $lblObs.Text = "Observaciones:"
    $lblObs.Location = New-Object System.Drawing.Point(12, ($y + 3))
    $lblObs.AutoSize = $true

    $txtObs = New-Object System.Windows.Forms.TextBox
    $txtObs.Location = New-Object System.Drawing.Point(150, $y)
    $txtObs.Size = New-Object System.Drawing.Size(270, 23)
    $pnl.Controls.AddRange(@($lblObs, $txtObs))
    $y += 30

    $chkAnulado = New-Object System.Windows.Forms.CheckBox
    $chkAnulado.Text = "Anulada"
    $chkAnulado.Location = New-Object System.Drawing.Point(150, $y)
    $chkAnulado.AutoSize = $true
    $pnl.Controls.Add($chkAnulado)
    $y += 35

    $lblMsg = New-Object System.Windows.Forms.Label
    $lblMsg.Text = ""
    $lblMsg.Location = New-Object System.Drawing.Point(12, $y)
    $lblMsg.Size = New-Object System.Drawing.Size(420, 20)
    $lblMsg.ForeColor = "DarkGreen"
    $pnl.Controls.Add($lblMsg)

    $btnSave = New-Object System.Windows.Forms.Button
    $btnSave.Text = "Guardar"
    $btnSave.Location = New-Object System.Drawing.Point(150, ($y + 25))
    $btnSave.Size = New-Object System.Drawing.Size(90, 28)
    $btnSave.BackColor = [System.Drawing.Color]::FromArgb(39, 174, 96)
    $btnSave.ForeColor = [System.Drawing.Color]::White

    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = "Cancelar"
    $btnCancel.Location = New-Object System.Drawing.Point(250, ($y + 25))
    $btnCancel.Size = New-Object System.Drawing.Size(90, 28)
    $pnl.Controls.AddRange(@($btnSave, $btnCancel))

    $dlg.Controls.Add($pnl)

    $script:mapCli = @{}
    QueryInto("SELECT Codigo, Nombre FROM Clientes ORDER BY Nombre")
    $acCli = New-Object System.Windows.Forms.AutoCompleteStringCollection
    foreach ($r in $script:currentDt.Rows) {
        if ($r["Codigo"] -eq [System.DBNull]::Value) { continue }
        $script:mapCli[[string]$r["Nombre"]] = [int]$r["Codigo"]
        [void]$acCli.Add([string]$r["Nombre"])
    }
    $txtCliente.AutoCompleteMode = "SuggestAppend"
    $txtCliente.AutoCompleteSource = "CustomSource"
    $txtCliente.AutoCompleteCustomSource = $acCli

    $script:mapEmp = @{}
    QueryInto("SELECT Codigo, Nombre FROM Empleados ORDER BY Nombre")
    $acEmp = New-Object System.Windows.Forms.AutoCompleteStringCollection
    foreach ($r in $script:currentDt.Rows) {
        if ($r["Codigo"] -eq [System.DBNull]::Value) { continue }
        $script:mapEmp[[string]$r["Nombre"]] = [int]$r["Codigo"]
        [void]$acEmp.Add([string]$r["Nombre"])
    }
    $txtEmpleado.AutoCompleteMode = "SuggestAppend"
    $txtEmpleado.AutoCompleteSource = "CustomSource"
    $txtEmpleado.AutoCompleteCustomSource = $acEmp

    $script:mapSvc = @{}
    QueryInto("SELECT Codigo, Nombre FROM Servicios ORDER BY Nombre")
    $acSvc = New-Object System.Windows.Forms.AutoCompleteStringCollection
    foreach ($r in $script:currentDt.Rows) {
        if ($r["Codigo"] -eq [System.DBNull]::Value) { continue }
        $script:mapSvc[[string]$r["Nombre"]] = [int]$r["Codigo"]
        [void]$acSvc.Add([string]$r["Nombre"])
    }
    $txtServicio.AutoCompleteMode = "SuggestAppend"
    $txtServicio.AutoCompleteSource = "CustomSource"
    $txtServicio.AutoCompleteCustomSource = $acSvc

    $curCli = if ($row["Cliente"] -ne [System.DBNull]::Value) { [int]$row["Cliente"] } else { 0 }
    $curEmp = if ($row["Empleado"] -ne [System.DBNull]::Value) { [int]$row["Empleado"] } else { 0 }
    $curSvc = if ($row["Servicio"] -ne [System.DBNull]::Value) { [int]$row["Servicio"] } else { 0 }
    $txtCliente.Text = if ($curCli -gt 0) { (($script:mapCli.GetEnumerator() | Where-Object { $_.Value -eq $curCli } | Select-Object -First 1).Key) } else { "" }
    $txtEmpleado.Text = if ($curEmp -gt 0) { (($script:mapEmp.GetEnumerator() | Where-Object { $_.Value -eq $curEmp } | Select-Object -First 1).Key) } else { "" }
    $txtServicio.Text = if ($curSvc -gt 0) { (($script:mapSvc.GetEnumerator() | Where-Object { $_.Value -eq $curSvc } | Select-Object -First 1).Key) } else { "" }

    if ($row["Fecha"] -is [DateTime]) { $dtpFecha.Value = $row["Fecha"] }
    if ($row["Hora_Inicio"] -is [DateTime]) { $dtpHoraIni.Value = $row["Hora_Inicio"] }
    if ($row["Hora_Final"] -is [DateTime] -and $row["Hora_Final"].Year -gt 1900) {
        $dtpHoraFin.Value = $row["Hora_Final"]
    } else {
        $dtpHoraFin.Value = $dtpHoraIni.Value.AddMinutes(45)
    }
    if ($row["Motivo"] -ne [System.DBNull]::Value) { $txtMotivo.Text = [string]$row["Motivo"] }
    if ($row["Observaciones"] -ne [System.DBNull]::Value) { $txtObs.Text = [string]$row["Observaciones"] }
    $chkAnulado.Checked = ($row["Anulado"] -and $row["Anulado"] -ne [System.DBNull]::Value -and [bool]$row["Anulado"])

    $btnSave.Add_Click({
        try {
            $cliSql = "NULL"
            if (-not [string]::IsNullOrWhiteSpace($txtCliente.Text)) {
                $nameCli = $txtCliente.Text.Trim()
                if ($script:mapCli.ContainsKey($nameCli)) { $cliSql = [string]$script:mapCli[$nameCli] }
                else { $lblMsg.Text = "Cliente no encontrado: $nameCli"; return }
            }
            $empSql = "NULL"
            if (-not [string]::IsNullOrWhiteSpace($txtEmpleado.Text)) {
                $nameEmp = $txtEmpleado.Text.Trim()
                if ($script:mapEmp.ContainsKey($nameEmp)) { $empSql = [string]$script:mapEmp[$nameEmp] }
                else { $lblMsg.Text = "Empleado no encontrado: $nameEmp"; return }
            }
            $svcSql = "NULL"
            if (-not [string]::IsNullOrWhiteSpace($txtServicio.Text)) {
                $nameSvc = $txtServicio.Text.Trim()
                if ($script:mapSvc.ContainsKey($nameSvc)) { $svcSql = [string]$script:mapSvc[$nameSvc] }
                else { $lblMsg.Text = "Servicio no encontrado: $nameSvc"; return }
            }
            $fechaSql = $dtpFecha.Value.ToString("MM/dd/yyyy")
            $horaIniSql = $dtpHoraIni.Value.ToString("HH:mm:ss")
            $horaFinSql = $dtpHoraFin.Value.ToString("HH:mm:ss")
            $motivoSql = ($txtMotivo.Text -replace "'", "''")
            $obsSql = ($txtObs.Text -replace "'", "''")
            $anu = if ($chkAnulado.Checked) { 1 } else { 0 }
            $sql = "UPDATE Agenda SET Cliente=$cliSql, Empleado=$empSql, Servicio=$svcSql, Fecha=#$fechaSql#, Hora_Inicio=#$horaIniSql#, Hora_Final=#$horaFinSql#, Motivo='$motivoSql', Observaciones='$obsSql', Anulado=$anu WHERE num_cita=$id"
            ExecuteNonQuery($sql) | Out-Null
            $lblMsg.Text = "Cita #$id guardada correctamente."
            LoadCitas
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Error al guardar: $_", "Error", "OK", "Error")
        }
    })
    $btnCancel.Add_Click({ $dlg.Close() })

    [void]$dlg.ShowDialog()
}

$script:chkAnuladas.Add_CheckedChanged({ LoadCitas })
$script:cmbEmpleado.Add_SelectedIndexChanged({ LoadCitas })

$script:form.Controls.Add($script:grid)
$script:form.Controls.Add($filterPanel)
$script:form.Controls.Add($topPanel)

$script:form.Add_Shown({
    LoadEmpleados
    LoadCitas
})

[System.Windows.Forms.Application]::EnableVisualStyles()
[void]$script:form.ShowDialog()
