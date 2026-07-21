Add-Type -AssemblyName System.Windows.Forms, System.Data

$form = New-Object System.Windows.Forms.Form
$form.Text = "TEST C# DataTable"
$form.Size = "600,400"
$form.StartPosition = "CenterScreen"

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock = "Fill"
$grid.RowHeadersVisible = $false

$btn = New-Object System.Windows.Forms.Button
$btn.Dock = "Bottom"
$btn.Text = "Probar con ArrayList PSObject"
$btn.Add_Click({
    $list = New-Object System.Collections.ArrayList
    $obj = New-Object PSObject -Property @{ Name = "Juan"; Age = 30 }
    $list.Add($obj)
    $grid.DataSource = $list
    $form.Text = "Rows: $($grid.Rows.Count)"
})
$form.Controls.Add($btn)

$btn2 = New-Object System.Windows.Forms.Button
$btn2.Dock = "Bottom"
$btn2.Text = "Probar con DataTable C#"
$btn2.Add_Click({
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Data;
using System.Data.OleDb;
public class DBHelper {
    public static DataTable GetData() {
        var conn = new OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\\TPVGratuito\\peluqueria\\TpvPeluqueria.accdb;Jet OLEDB:Database Password=131201%SolKerMediaP");
        conn.Open();
        var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT TOP 10 num_cita, Fecha, Hora_Inicio FROM Agenda ORDER BY num_cita";
        var da = new OleDbDataAdapter(cmd);
        var dt = new DataTable();
        da.Fill(dt);
        conn.Close();
        return dt;
    }
}
"@ -ReferencedAssemblies "System.Data", "System.Data.OleDb"
        $dt = [DBHelper]::GetData()
        $grid.DataSource = $dt
        $form.Text = "Rows: $($dt.Rows.Count), Grid: $($grid.Rows.Count)"
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Error: $_")
    }
})

$form.Controls.Add($btn2)
$form.Controls.Add($grid)
$form.ShowDialog()
