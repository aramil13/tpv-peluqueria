Add-Type -AssemblyName System.Windows.Forms

$form = New-Object System.Windows.Forms.Form
$form.Text = "TEST"; $form.Size = "600,400"; $form.StartPosition = "CenterScreen"

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock = "Fill"
$grid.AllowUserToAddRows = $false
$grid.RowHeadersVisible = $false
$form.Controls.Add($grid)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = "Cargar datos quemados"
$btn.Dock = "Bottom"
$btn.Add_Click({
    $grid.Columns.Clear()
    $grid.Rows.Clear()
    $grid.Columns.Add("Col1","Col1"); $grid.Columns.Add("Col2","Col2")
    $grid.Rows.Add("Hola","Mundo")
    $grid.Rows.Add("Test","123")
    $form.Text = "Filas: $($grid.Rows.Count)"
})
$form.Controls.Add($btn)

$btn2 = New-Object System.Windows.Forms.Button
$btn2.Text = "Cargar desde Access"
$btn2.Dock = "Bottom"
$btn2.Add_Click({
    $dbPath = "C:\TPVGratuito\peluqueria\TpvPeluqueria.accdb"
    $connStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath;Jet OLEDB:Database Password=131201%SolKerMediaP"
    $conn = New-Object System.Data.OleDb.OleDbConnection($connStr)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT TOP 10 num_cita, Fecha, Hora_Inicio FROM Agenda ORDER BY num_cita"
    $da = New-Object System.Data.OleDb.OleDbDataAdapter($cmd)
    $dt = New-Object System.Data.DataTable
    $da.Fill($dt)
    $conn.Close()
    $grid.DataSource = $dt
    $form.Text = "DT: $($dt.Rows.Count) rows, Grid: $($grid.Rows.Count)"
})
$form.Controls.Add($btn2)

$form.ShowDialog()
