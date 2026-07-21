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

$btnAnular = New-Object System.Windows.Forms.Button
$btnAnular.Text = "Anular"
$btnAnular.Location = New-Object System.Drawing.Point(680, 4)
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
$btnReactivar.Location = New-Object System.Drawing.Point(770, 4)
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

$filterPanel.Controls.AddRange(@($lblFecha, $script:dtpFecha, $lblEmp, $script:cmbEmpleado, $script:chkAnuladas, $btnRefresh, $btnAnular, $btnReactivar))

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

$script:editableColumns = @("Hora_Inicio", "Hora_Final", "Motivo", "Observaciones", "Empleado", "Servicio")
$script:grid.Add_CellBeginEdit({
    $colName = $script:grid.Columns[$e.ColumnIndex].Name
    if ($colName -notin $script:editableColumns) {
        $e.Cancel = $true
    }
})
$script:grid.Add_CellEndEdit({
    if ($e.RowIndex -lt 0 -or $e.RowIndex -ge $script:grid.Rows.Count) { return }
    $row = $script:grid.Rows[$e.RowIndex]
    $colName = $script:grid.Columns[$e.ColumnIndex].Name
    $newVal = $row.Cells[$colName].Value
    $id = $row.Cells["num_cita"].Value
    if (-not $id) { return }

    if ($newVal -eq $null -or $newVal -eq [System.DBNull]::Value) {
        $newValSql = "NULL"
    } elseif ($newVal -is [string]) {
        $escaped = $newVal -replace "'", "''"
        $newValSql = "'$escaped'"
    } else {
        $newValSql = "'$newVal'"
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
