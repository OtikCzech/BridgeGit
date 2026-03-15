Option Explicit

Dim shell
Dim fso
Dim scriptDir
Dim launcherPath
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fso.GetAbsolutePathName(fso.BuildPath(scriptDir, "launch-app.cmd"))
command = "cmd.exe /c """ & launcherPath & """"

shell.Run command, 0, False
