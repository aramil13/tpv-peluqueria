using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Security.Principal;
using Microsoft.Win32;

namespace TpvUninstaller
{
    class Program
    {
        static void Main(string[] args)
        {
            // Auto-elevate to Administrator if required
            if (!IsAdministrator())
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = Process.GetCurrentProcess().MainModule.FileName;
                    psi.UseShellExecute = true;
                    psi.Verb = "runas";
                    psi.Arguments = string.Join(" ", args);
                    Process.Start(psi);
                    return;
                }
                catch (Exception)
                {
                    // User canceled UAC prompt
                    return;
                }
            }

            bool keepUserData = false;
            foreach (var arg in args)
            {
                if (arg.Equals("/keepdata", StringComparison.OrdinalIgnoreCase) || arg.Equals("-keepdata", StringComparison.OrdinalIgnoreCase))
                {
                    keepUserData = true;
                }
            }

            // 1. Detener procesos
            StopProcess("tpv-peluqueria");
            StopProcess("TPV-Builder2");
            StopProcess("electron");
            StopNodeSyncProcesses();

            // 2. Ejecutar desinstalador NSIS registrado
            RunRegistryUninstaller();

            // 3. Eliminar directorios de programa
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);

            DeleteDirectory(Path.Combine(localAppData, @"Programs\tpv-peluqueria"));
            DeleteDirectory(Path.Combine(localAppData, @"Programs\TPV-Builder2"));
            DeleteDirectory(Path.Combine(localAppData, @"tpv-peluqueria-updater"));
            DeleteDirectory(Path.Combine(programFiles, @"tpv-peluqueria"));
            if (!string.IsNullOrEmpty(programFilesX86))
            {
                DeleteDirectory(Path.Combine(programFilesX86, @"tpv-peluqueria"));
            }

            // 4. Eliminar accesos directos
            string userDesktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            string commonDesktop = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
            string startMenu = Path.Combine(appData, @"Microsoft\Windows\Start Menu\Programs");
            string startup = Path.Combine(startMenu, @"Startup");

            DeleteFile(Path.Combine(userDesktop, "TPV Peluquería.lnk"));
            DeleteFile(Path.Combine(userDesktop, "TPV Peluqueria.lnk"));
            DeleteFile(Path.Combine(userDesktop, "tpv-peluqueria.lnk"));
            DeleteFile(Path.Combine(userDesktop, "TPV-Builder2.lnk"));
            DeleteFile(Path.Combine(userDesktop, "Gestor Citas TPV.lnk"));

            DeleteFile(Path.Combine(commonDesktop, "TPV Peluquería.lnk"));
            DeleteFile(Path.Combine(commonDesktop, "TPV Peluqueria.lnk"));
            DeleteFile(Path.Combine(commonDesktop, "tpv-peluqueria.lnk"));

            DeleteFile(Path.Combine(startMenu, "tpv-peluqueria.lnk"));
            DeleteFile(Path.Combine(startMenu, "TPV Peluquería.lnk"));
            DeleteFile(Path.Combine(startup, "iniciar-sync-helper.bat.lnk"));
            DeleteFile(Path.Combine(startup, "tpv-peluqueria.lnk"));

            DeleteDirectory(Path.Combine(startMenu, "tpv-peluqueria"));

            // 5. Limpieza de AppData si no se solicita mantener datos
            if (!keepUserData)
            {
                DeleteDirectory(Path.Combine(appData, "tpv-peluqueria"));
            }

            // 6. Eliminar claves de registro
            CleanRegistryKeys();
        }

        static bool IsAdministrator()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            WindowsPrincipal principal = new WindowsPrincipal(identity);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }

        static void StopProcess(string processName)
        {
            try
            {
                Process[] processes = Process.GetProcessesByName(processName);
                foreach (Process p in processes)
                {
                    try { p.Kill(); } catch { }
                }
            }
            catch { }
        }

        static void StopNodeSyncProcesses()
        {
            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
                {
                    foreach (ManagementObject obj in searcher.Get())
                    {
                        string cmd = obj["CommandLine"] as string;
                        if (!string.IsNullOrEmpty(cmd) && (cmd.Contains("sync-helper.js") || cmd.Contains("access-sync.js")))
                        {
                            int pid = Convert.ToInt32(obj["ProcessId"]);
                            try
                            {
                                Process p = Process.GetProcessById(pid);
                                p.Kill();
                            }
                            catch { }
                        }
                    }
                }
            }
            catch { }
        }

        static void RunRegistryUninstaller()
        {
            string[] searchKeys = new string[]
            {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            };

            RegistryKey[] rootKeys = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };

            foreach (RegistryKey root in rootKeys)
            {
                foreach (string subKeyPath in searchKeys)
                {
                    try
                    {
                        using (RegistryKey key = root.OpenSubKey(subKeyPath))
                        {
                            if (key == null) continue;
                            foreach (string sub in key.GetSubKeyNames())
                            {
                                using (RegistryKey appKey = key.OpenSubKey(sub))
                                {
                                    if (appKey == null) continue;
                                    string displayName = appKey.GetValue("DisplayName") as string;
                                    string uninstallString = appKey.GetValue("UninstallString") as string;

                                    if (sub.Equals("com.peluqueria.tpv", StringComparison.OrdinalIgnoreCase) ||
                                        (!string.IsNullOrEmpty(displayName) && (displayName.Contains("TPV-Builder2") || displayName.Contains("tpv-peluqueria"))))
                                    {
                                        if (!string.IsNullOrEmpty(uninstallString))
                                        {
                                            ExecuteUninstallCommand(uninstallString);
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    catch { }
                }
            }
        }

        static void ExecuteUninstallCommand(string uninstallString)
        {
            try
            {
                string rawCmd = uninstallString.Trim();
                string exePath = "";
                string extraArgs = "";

                if (rawCmd.StartsWith("\""))
                {
                    int endQuote = rawCmd.IndexOf('"', 1);
                    if (endQuote > 1)
                    {
                        exePath = rawCmd.Substring(1, endQuote - 1);
                        extraArgs = rawCmd.Substring(endQuote + 1).Trim();
                    }
                }
                else
                {
                    int spaceIdx = rawCmd.IndexOf(' ');
                    if (spaceIdx > 0)
                    {
                        exePath = rawCmd.Substring(0, spaceIdx);
                        extraArgs = rawCmd.Substring(spaceIdx + 1).Trim();
                    }
                    else
                    {
                        exePath = rawCmd;
                    }
                }

                if (File.Exists(exePath))
                {
                    string args = string.IsNullOrEmpty(extraArgs) ? "/S" : extraArgs + " /S";
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = exePath;
                    psi.Arguments = args;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    Process p = Process.Start(psi);
                    if (p != null)
                    {
                        p.WaitForExit(15000);
                    }
                }
            }
            catch { }
        }

        static void DeleteDirectory(string path)
        {
            try
            {
                if (Directory.Exists(path))
                {
                    Directory.Delete(path, true);
                }
            }
            catch { }
        }

        static void DeleteFile(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch { }
        }

        static void CleanRegistryKeys()
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\com.peluqueria.tpv", false); } catch { }
            try { Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\com.peluqueria.tpv", false); } catch { }
            try { Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\com.peluqueria.tpv", false); } catch { }
        }
    }
}
