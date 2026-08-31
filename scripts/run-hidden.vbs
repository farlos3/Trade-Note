' Run a console program with no window, for Task Scheduler.
'
' New-ScheduledTaskSettingsSet -Hidden hides the TASK ROW in the Task Scheduler
' UI. It says nothing about the child process, and bash.exe is a console program:
' every fire allocated a console, so a black window flashed on the desktop once a
' minute, forever. (The hand-rolled tasks this replaced ran pythonw.exe, which has
' no console subsystem at all -- hence no flashing before.)
'
' wscript.exe has no console of its own, and Shell.Run(cmd, 0, True) starts the
' child hidden and waits for it, so the task's Last Result still reports what the
' job actually returned instead of always 0.
'
' Usage: wscript.exe run-hidden.vbs <exe> [arg ...]
Option Explicit

Dim sh, cmd, i
If WScript.Arguments.Count = 0 Then WScript.Quit 64

Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
    ' Re-quote every argument: WScript strips the quotes the scheduler passed, and
    ' both the Git install path and the bash -lc command contain spaces.
    cmd = cmd & """" & WScript.Arguments(i) & """"
    If i < WScript.Arguments.Count - 1 Then cmd = cmd & " "
Next

WScript.Quit sh.Run(cmd, 0, True)
