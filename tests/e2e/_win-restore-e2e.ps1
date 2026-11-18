# Restore + foreground the e2e Obsidian window (Win32 ShowWindow, SW_RESTORE).
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
'@
$p = Get-Process Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*logseq-e2e-vault*' } | Select-Object -First 1
if (-not $p) { Write-Output 'NO WINDOW'; exit 1 }
$h = $p.MainWindowHandle
[void][W.U]::ShowWindow($h, 9)      # SW_RESTORE
[void][W.U]::SetForegroundWindow($h)
Write-Output ("RESTORED pid=" + $p.Id)
