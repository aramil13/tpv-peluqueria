Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dbPath = "C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb"
$dbPassword = "131201%SolKerMediaP"
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$dbPassword"

$script:currentTable = ""
$script:tableNames = @()
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

function QueryScalar($sql) {
    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $result = $cmd.ExecuteScalar()
    $conn.Close()
    return $result
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
$script:form.Text = "Gestor DB - TPV Peluqueria"
$script:form.Size = New-Object System.Drawing.Size(1400, 850)
$script:form.StartPosition = "CenterScreen"
$script:form.MinimumSize = New-Object System.Drawing.Size(1000, 600)

$topPanel = New-Object System.Windows.Forms.Panel
$topPanel.Dock = "Top"
$topPanel.Height = 40

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "GESTOR DE BASE DE DATOS"
$lblTitle.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$lblTitle.AutoSize = $true
$lblTitle.Location = New-Object System.Drawing.Point(10, 8)

$script:lblStatus = New-Object System.Windows.Forms.Label
$script:lblStatus.Text = "Iniciando..."
$script:lblStatus.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$script:lblStatus.ForeColor = "Gray"
$script:lblStatus.AutoSize = $true
$script:lblStatus.Location = New-Object System.Drawing.Point(300, 12)

$topPanel.Controls.AddRange(@($lblTitle, $script:lblStatus))

$splitContainer = New-Object System.Windows.Forms.SplitContainer
$splitContainer.Dock = "Fill"
$splitContainer.SplitterDistance = 250
$splitContainer.Panel1MinSize = 150

$leftPanel = New-Object System.Windows.Forms.Panel
$leftPanel.Dock = "Fill"

$lblTables = New-Object System.Windows.Forms.Label
$lblTables.Text = "TABLAS"
$lblTables.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$lblTables.Dock = "Top"
$lblTables.Height = 22

$topLeftBar = New-Object System.Windows.Forms.Panel
$topLeftBar.Dock = "Top"
$topLeftBar.Height = 28

$btnRefreshTables = New-Object System.Windows.Forms.Button
$btnRefreshTables.Text = "R"
$btnRefreshTables.Location = New-Object System.Drawing.Point(0, 2)
$btnRefreshTables.Size = New-Object System.Drawing.Size(30, 24)
$btnRefreshTables.Add_Click({ LoadTableList })

$script:txtFilterTables = New-Object System.Windows.Forms.TextBox
$script:txtFilterTables.Location = New-Object System.Drawing.Point(35, 3)
$script:txtFilterTables.Width = 200
$script:txtFilterTables.Add_TextChanged({
    $filter = $script:txtFilterTables.Text
    $script:lstTables.BeginUpdate()
    $script:lstTables.Items.Clear()
    foreach ($t in $script:tableNames) {
        if ($filter -eq "" -or $t -like "*$filter*") { $script:lstTables.Items.Add($t) }
    }
    $script:lstTables.EndUpdate()
})

$topLeftBar.Controls.AddRange(@($btnRefreshTables, $script:txtFilterTables))

$script:lstTables = New-Object System.Windows.Forms.ListBox
$script:lstTables.Dock = "Fill"
$script:lstTables.Font = New-Object System.Drawing.Font("Consolas", 9)
$script:lstTables.Add_SelectedIndexChanged({
    $sel = $script:lstTables.SelectedItem
    if ($sel) { LoadTable($sel) }
})

$leftPanel.Controls.Add($script:lstTables)
$leftPanel.Controls.Add($topLeftBar)
$leftPanel.Controls.Add($lblTables)
$splitContainer.Panel1.Controls.Add($leftPanel)

$rightPanel = New-Object System.Windows.Forms.Panel
$rightPanel.Dock = "Fill"

$filterBar = New-Object System.Windows.Forms.Panel
$filterBar.Dock = "Top"
$filterBar.Height = 60

$script:lblSelectedTable = New-Object System.Windows.Forms.Label
$script:lblSelectedTable.Text = "Selecciona una tabla"
$script:lblSelectedTable.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$script:lblSelectedTable.AutoSize = $true
$script:lblSelectedTable.Location = New-Object System.Drawing.Point(5, 6)

$script:lblRowCount = New-Object System.Windows.Forms.Label
$script:lblRowCount.Text = ""
$script:lblRowCount.AutoSize = $true
$script:lblRowCount.Location = New-Object System.Drawing.Point(300, 8)
$script:lblRowCount.ForeColor = "DarkBlue"
$script:lblRowCount.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)

$lblSearch = New-Object System.Windows.Forms.Label
$lblSearch.Text = "Buscar:"
$lblSearch.AutoSize = $true
$lblSearch.Location = New-Object System.Drawing.Point(5, 35)

$script:txtSearch = New-Object System.Windows.Forms.TextBox
$script:txtSearch.Location = New-Object System.Drawing.Point(55, 32)
$script:txtSearch.Size = New-Object System.Drawing.Size(150, 20)

$btnFilter = New-Object System.Windows.Forms.Button
$btnFilter.Text = "Filtrar"
$btnFilter.Location = New-Object System.Drawing.Point(215, 30)
$btnFilter.Size = New-Object System.Drawing.Size(70, 24)
$btnFilter.Add_Click({ $sel = $script:lstTables.SelectedItem; if ($sel) { LoadTable($sel) } })

$btnClearFilter = New-Object System.Windows.Forms.Button
$btnClearFilter.Text = "Limpiar"
$btnClearFilter.Location = New-Object System.Drawing.Point(295, 30)
$btnClearFilter.Size = New-Object System.Drawing.Size(70, 24)
$btnClearFilter.Add_Click({ $script:txtSearch.Text = ""; $sel = $script:lstTables.SelectedItem; if ($sel) { LoadTable($sel) } })

$script:chkEditMode = New-Object System.Windows.Forms.CheckBox
$script:chkEditMode.Text = "Edicion"
$script:chkEditMode.AutoSize = $true
$script:chkEditMode.Location = New-Object System.Drawing.Point(380, 33)
$script:chkEditMode.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$script:chkEditMode.ForeColor = [System.Drawing.Color]::DarkRed
$script:chkEditMode.Add_CheckedChanged({
    $script:grid.ReadOnly = -not $script:chkEditMode.Checked
    $script:grid.AllowUserToAddRows = $script:chkEditMode.Checked
    $script:grid.AllowUserToDeleteRows = $script:chkEditMode.Checked
})

$filterBar.Controls.AddRange(@($script:lblSelectedTable, $script:lblRowCount, $lblSearch, $script:txtSearch, $btnFilter, $btnClearFilter, $script:chkEditMode))

$script:grid = New-Object System.Windows.Forms.DataGridView
$script:grid.Dock = "Fill"
$script:grid.ReadOnly = $true
$script:grid.AllowUserToAddRows = $false
$script:grid.AllowUserToDeleteRows = $false
$script:grid.SelectionMode = "FullRowSelect"
$script:grid.MultiSelect = $false
$script:grid.RowHeadersVisible = $true
$script:grid.AutoSizeColumnsMode = "AllCells"
$script:grid.BackgroundColor = "White"
$script:grid.DefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$script:grid.ColumnHeadersDefaultCellStyle.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$script:grid.RowHeadersWidth = 50

$script:grid.Add_CellEndEdit({
    if (-not $script:chkEditMode.Checked) { return }
    if ($e.RowIndex -lt 0 -or $e.RowIndex -ge $script:grid.Rows.Count) { return }
    $row = $script:grid.Rows[$e.RowIndex]
    $colName = $script:grid.Columns[$e.ColumnIndex].Name
    $newVal = $row.Cells[$colName].Value

    $pkCol = $null
    $pkVal = $null
    foreach ($col in $script:grid.Columns) {
        if ($col.Name -eq "Codigo" -or $col.Name -eq "num_cita") {
            $pkCol = $col.Name
            $pkVal = $row.Cells[$pkCol].Value
            break
        }
    }
    if (-not $pkCol -or $pkVal -eq $null) {
        $script:lblStatus.Text = "No se puede editar: sin clave primaria"
        return
    }

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

    $sql = "UPDATE [$script:currentTable] SET [$colName] = $newValSql WHERE [$pkCol] = $pkVal"
    try {
        ExecuteNonQuery($sql)
        $script:lblStatus.Text = "Guardado: $colName en $script:currentTable #$pkVal"
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Error al guardar: $_", "Error", "OK", "Error")
    }
})

$rightPanel.Controls.Add($script:grid)
$rightPanel.Controls.Add($filterBar)
$splitContainer.Panel2.Controls.Add($rightPanel)

$actionBar = New-Object System.Windows.Forms.Panel
$actionBar.Dock = "Bottom"
$actionBar.Height = 40

$btnAddRow = New-Object System.Windows.Forms.Button
$btnAddRow.Text = "Anadir fila"
$btnAddRow.Location = New-Object System.Drawing.Point(10, 6)
$btnAddRow.Size = New-Object System.Drawing.Size(100, 28)
$btnAddRow.Add_Click({
    if (-not $script:currentTable) { return }
    if (-not $script:chkEditMode.Checked) {
        [System.Windows.Forms.MessageBox]::Show("Activa el modo Edicion primero", "Info", "OK", "Information")
        return
    }
    $newRow = $script:currentDt.NewRow()
    if ($script:currentDt.Columns.Contains("Codigo")) {
        $maxSql = "SELECT NZ(MAX(Codigo),0)+1 FROM [$script:currentTable]"
        $nextId = QueryScalar($maxSql)
        if ($nextId -ne $null) { $newRow["Codigo"] = [int]$nextId }
    }
    $script:currentDt.Rows.Add($newRow)
    $script:lblStatus.Text = "Fila anadida. Rellena campos y pulsa Enter para guardar."
})

$btnDeleteRow = New-Object System.Windows.Forms.Button
$btnDeleteRow.Text = "Eliminar fila"
$btnDeleteRow.Location = New-Object System.Drawing.Point(120, 6)
$btnDeleteRow.Size = New-Object System.Drawing.Size(100, 28)
$btnDeleteRow.Add_Click({
    if ($script:grid.SelectedRows.Count -eq 0) { return }
    if (-not $script:chkEditMode.Checked) {
        [System.Windows.Forms.MessageBox]::Show("Activa el modo Edicion primero", "Info", "OK", "Information")
        return
    }
    $row = $script:grid.SelectedRows[0]
    $pkCol = $null; $pkVal = $null
    foreach ($col in $script:grid.Columns) {
        if ($col.Name -eq "Codigo" -or $col.Name -eq "num_cita") {
            $pkCol = $col.Name; $pkVal = $row.Cells[$pkCol].Value; break
        }
    }
    if (-not $pkCol -or $pkVal -eq $null) {
        [System.Windows.Forms.MessageBox]::Show("No se puede eliminar: sin clave primaria", "Error", "OK", "Warning")
        return
    }
    $tableName = $script:currentTable
    $confirm = [System.Windows.Forms.MessageBox]::Show("Eliminar registro $pkCol=$pkVal de $tableName ?", "Confirmar", "YesNo", "Warning")
    if ($confirm -eq "Yes") {
        $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
        $conn.Open()
        $cols = $conn.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Columns, @($null, $null, $tableName, $null))
        $conn.Close()
        $hasBorrar = $false
        foreach ($c in $cols.Rows) { if ($c["COLUMN_NAME"] -eq "Borrar") { $hasBorrar = $true; break } }
        $sql = if ($hasBorrar) { "UPDATE [$tableName] SET Borrar = 1 WHERE [$pkCol] = $pkVal" } else { "DELETE FROM [$tableName] WHERE [$pkCol] = $pkVal" }
        try {
            ExecuteNonQuery($sql)
            $script:lblStatus.Text = "Registro #$pkVal eliminado de $tableName"
            LoadTable($script:currentTable)
        } catch {
            [System.Windows.Forms.MessageBox]::Show("Error: $_", "Error", "OK", "Error")
        }
    }
})

$btnExportCSV = New-Object System.Windows.Forms.Button
$btnExportCSV.Text = "Exportar CSV"
$btnExportCSV.Location = New-Object System.Drawing.Point(230, 6)
$btnExportCSV.Size = New-Object System.Drawing.Size(100, 28)
$btnExportCSV.Add_Click({
    if (-not $script:currentTable -or -not $script:currentDt) { return }
    $sfd = New-Object System.Windows.Forms.SaveFileDialog
    $sfd.Filter = "CSV files (*.csv)|*.csv"
    $sfd.FileName = "$script:currentTable.csv"
    if ($sfd.ShowDialog() -eq "OK") {
        $lines = @()
        $header = ($script:currentDt.Columns | ForEach-Object { $_.ColumnName }) -join ";"
        $lines += $header
        foreach ($r in $script:currentDt.Rows) {
            $vals = @()
            foreach ($col in $script:currentDt.Columns) {
                $val = $r[$col.ColumnName]
                if ($val -eq $null -or $val -eq [System.DBNull]::Value) { $vals += "" }
                else { $vals += $val.ToString() }
            }
            $lines += ($vals -join ";")
        }
        $lines -join "`r`n" | Set-Content -LiteralPath $sfd.FileName -Encoding UTF8
        [System.Windows.Forms.MessageBox]::Show("Exportado a $($sfd.FileName)", "OK", "OK", "Information")
    }
})

$btnSqlConsole = New-Object System.Windows.Forms.Button
$btnSqlConsole.Text = "Consola SQL"
$btnSqlConsole.Location = New-Object System.Drawing.Point(340, 6)
$btnSqlConsole.Size = New-Object System.Drawing.Size(100, 28)
$btnSqlConsole.Add_Click({ ShowSqlConsole })

$actionBar.Controls.AddRange(@($btnAddRow, $btnDeleteRow, $btnExportCSV, $btnSqlConsole))

function ShowSqlConsole {
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = "Consola SQL"
    $dlg.Size = New-Object System.Drawing.Size(800, 500)
    $dlg.StartPosition = "CenterParent"
    $dlg.Font = New-Object System.Drawing.Font("Consolas", 10)

    $txtSql = New-Object System.Windows.Forms.TextBox
    $txtSql.Multiline = $true
    $txtSql.Dock = "Fill"
    $txtSql.ScrollBars = "Both"
    $txtSql.AcceptsReturn = $true
    $txtSql.Text = "SELECT * FROM [$script:currentTable]"

    $bottomPnl = New-Object System.Windows.Forms.Panel
    $bottomPnl.Dock = "Bottom"
    $bottomPnl.Height = 35

    $btnRun = New-Object System.Windows.Forms.Button
    $btnRun.Text = "Ejecutar (F5)"
    $btnRun.Location = New-Object System.Drawing.Point(10, 5)
    $btnRun.Size = New-Object System.Drawing.Size(120, 28)

    $lblResult = New-Object System.Windows.Forms.Label
    $lblResult.Text = ""
    $lblResult.Location = New-Object System.Drawing.Point(140, 10)
    $lblResult.Size = New-Object System.Drawing.Size(600, 20)

    $resultDt = $null
    $resultGrid = New-Object System.Windows.Forms.DataGridView
    $resultGrid.Dock = "Fill"
    $resultGrid.ReadOnly = $true
    $resultGrid.AutoSizeColumnsMode = "AllCells"
    $resultGrid.AllowUserToAddRows = $false
    $resultGrid.BackgroundColor = "White"
    $resultGrid.RowHeadersVisible = $false

    $btnRun.Add_Click({
        $sql = $txtSql.Text.Trim()
        $upper = $sql.ToUpper()
        try {
            if ($upper.StartsWith("SELECT")) {
                $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
                $conn.Open()
                $cmd = $conn.CreateCommand()
                $cmd.CommandText = $sql
                $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
                $resultDt = New-Object System.Data.DataTable
                $da.Fill($resultDt)
                $conn.Close()
                $resultGrid.DataSource = $resultDt
                $lblResult.Text = "$($resultDt.Rows.Count) filas devueltas"
            } else {
                $r = ExecuteNonQuery($sql)
                $lblResult.Text = "Ejecutada. Filas afectadas: $r"
                $resultGrid.DataSource = $null
            }
        } catch { $lblResult.Text = "Error: $_" }
    })

    $txtSql.Add_KeyDown({
        if ($_.KeyCode -eq "F5") { $btnRun.PerformClick() }
    })

    $bottomPnl.Controls.AddRange(@($btnRun, $lblResult))

    $split = New-Object System.Windows.Forms.SplitContainer
    $split.Dock = "Fill"
    $split.Orientation = "Horizontal"
    $split.Panel1.Controls.Add($txtSql)
    $split.Panel2.Controls.Add($resultGrid)
    $split.SplitterDistance = 150

    $dlg.Controls.Add($split)
    $dlg.Controls.Add($bottomPnl)
    $dlg.ShowDialog()
}

function LoadTableList {
    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $schema = $conn.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Tables, @($null, $null, $null, "TABLE"))
    $conn.Close()
    $script:tableNames = @()
    $script:lstTables.BeginUpdate()
    $script:lstTables.Items.Clear()
    foreach ($row in $schema.Rows) {
        $name = $row["TABLE_NAME"]
        $script:tableNames += $name
        $script:lstTables.Items.Add($name)
    }
    $script:lstTables.EndUpdate()
    $cnt = $script:tableNames.Count
    $script:lblStatus.Text = "$cnt tablas cargadas"
}

function LoadTable($tableName) {
    if (-not $tableName) { return }
    $script:currentTable = $tableName
    $script:lblSelectedTable.Text = "Tabla: $tableName"

    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $colsSchema = $conn.GetOleDbSchemaTable([System.Data.OleDb.OleDbSchemaGuid]::Columns, @($null, $null, $tableName, $null))
    $conn.Close()

    $search = $script:txtSearch.Text.Trim()
    $orderBy = ""
    if ($tableName -eq "Agenda") { $orderBy = " ORDER BY Fecha DESC, Hora_Inicio" }
    elseif ($tableName -eq "Clientes") { $orderBy = " ORDER BY Nombre" }
    elseif ($tableName -eq "Empleados") { $orderBy = " ORDER BY Nombre" }
    elseif ($tableName -eq "Servicios") { $orderBy = " ORDER BY Nombre" }

    $sql = "SELECT * FROM [$tableName]"
    $whereClauses = @()
    if ($search -ne "") {
        $searchClauses = @()
        foreach ($col in $colsSchema.Rows) {
            $colName = $col["COLUMN_NAME"]
            $dataType = $col["DATA_TYPE"]
            if ($dataType -eq 130 -or $dataType -eq 129 -or $dataType -eq 200 -or $dataType -eq 201) {
                $escaped = $search -replace "'", "''"
                $searchClauses += "[$colName] LIKE '%$escaped%'"
            }
        }
        if ($searchClauses.Count -gt 0) {
            $whereClauses += "($($searchClauses -join ' OR '))"
        }
    }
    if ($whereClauses.Count -gt 0) {
        $sql += " WHERE $($whereClauses -join ' AND ')"
    }
    $sql += $orderBy

    try {
        QueryInto($sql)
        $script:grid.AutoGenerateColumns = $true
        $script:grid.DataSource = $script:currentDt
        $script:grid.Refresh()
        $cnt = $script:currentDt.Rows.Count
        $script:lblRowCount.Text = "Registros: $cnt"
        $script:lblStatus.Text = "$tableName : $cnt registros"
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Error al cargar $tableName : $_", "Error", "OK", "Error")
    }
}

$script:form.Controls.Add($splitContainer)
$script:form.Controls.Add($actionBar)
$script:form.Controls.Add($topPanel)

try {
    LoadTableList
    $cnt = $script:tableNames.Count
    $script:lblStatus.Text = "Conectado a Access DB. $cnt tablas disponibles."
} catch {
    [System.Windows.Forms.MessageBox]::Show("Error de conexion a Access DB: $_", "Error critico", "OK", "Error")
}

[void]$script:form.ShowDialog()
