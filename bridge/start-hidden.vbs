' Starts BuildHall Bridge with no console window.
' If it is already running, the server notices and just opens the panel.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & here & "ridge-run.cmd""", 0, False
