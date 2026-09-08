param([Parameter(Mandatory = $true)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('SMOKE_CONTROLLER=compiling')

# Suspended creation closes the spawn/assign race: every descendant belongs to
# this job. Controller stdin EOF (including a crash) closes the job, not a
# process-name match that could terminate somebody else's desktop.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class SmokeJob {
    [StructLayout(LayoutKind.Sequential)]
    struct Startup {
        public int size;
        public IntPtr reserved, desktop, title;
        public int x, y, width, height, xChars, yChars, fill, flags;
        public short show, reservedSize;
        public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcesses;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit {
        public BasicLimit basic;
        public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static Win32Exception LastError(string operation) {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + " failed (Win32 " + code + "): " +
            new Win32Exception(code).Message);
    }

    public static int Run(string executable, string command, string cwd) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError("CreateJobObject");
        ProcessInfo process = new ProcessInfo();
        try {
            ExtendedLimit limits = new ExtendedLimit();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)))
                throw LastError("SetInformationJobObject");
            Startup startup = new Startup();
            startup.size = Marshal.SizeOf(startup);
            startup.flags = 0x100; // STARTF_USESTDHANDLES
            startup.stdin = GetStdHandle(-10);
            startup.stdout = GetStdHandle(-11);
            startup.stderr = GetStdHandle(-12);
            if (!CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                true, 4, IntPtr.Zero, cwd, ref startup, out process))
                throw LastError("CreateProcess");
            if (!AssignProcessToJobObject(job, process.process))
                throw LastError("AssignProcessToJobObject");
            if (ResumeThread(process.thread) == UInt32.MaxValue)
                throw LastError("ResumeThread");
            Console.WriteLine("SMOKE_PID=" + process.pid);
            Console.Out.Flush();
            Task<string> input = Task.Run(() => Console.ReadLine());
            Stopwatch lifetime = Stopwatch.StartNew();
            while (!input.IsCompleted && lifetime.ElapsedMilliseconds < 90000) {
                uint status = WaitForSingleObject(process.process, 50);
                if (status == UInt32.MaxValue)
                    throw LastError("WaitForSingleObject");
                if (status != 0) continue;
                uint code;
                if (!GetExitCodeProcess(process.process, out code))
                    throw LastError("GetExitCodeProcess");
                Console.Error.WriteLine("SMOKE_EXIT=" + code);
                return unchecked((int)code);
            }
            return 0;
        } finally {
            if (process.process != IntPtr.Zero) TerminateProcess(process.process, 0);
            CloseHandle(job);
            if (process.process != IntPtr.Zero) {
                WaitForSingleObject(process.process, 5000);
                CloseHandle(process.process);
                CloseHandle(process.thread);
            }
        }
    }
}
'@

$launch = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
[Console]::Error.WriteLine('SMOKE_CONTROLLER=launching')
exit [SmokeJob]::Run($launch.executable, $launch.commandLine, $launch.cwd)
