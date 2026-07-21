Add-Type -AssemblyName System.Windows.Forms

$dbPath = "C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb"
$dbPassword = "131201%SolKerMediaP"
$connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=$dbPassword"

$conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT TOP 5 num_cita, Fecha, Hora_Inicio FROM Agenda WHERE Fecha = #2026-07-10# ORDER BY Hora_Inicio"
$da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
$dt = New-Object System.Data.DataTable
$da.Fill($dt)
$conn.Close()

Write-Host "Filas en DT: $($dt.Rows.Count)"
Write-Host "Columnas: $($dt.Columns.Count)"

$form = New-Object System.Windows.Forms.Form
$form.Text = "TEST"; $form.Size = "600,400"; $form.StartPosition = "CenterScreen"

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock = "Fill"; $grid.RowHeadersVisible = $false

# Try DataSource first
$grid.DataSource = $dt

$btn = New-Object System.Windows.Forms.Button
$btn.Text = "Refresh grid rows count"; $btn.Dock = "Bottom"
$btn.Add_Click({
    Write-Host "Grid rows visible: $($grid.Rows.Count)"
    Write-Host "Grid cols: $($grid.Columns.Count)"
    $grid.Refresh()
})

$form.Controls.Add($grid)
$form.Controls.Add($btn)
$form.ShowDialog()
