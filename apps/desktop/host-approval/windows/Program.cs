using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Windows.Security.Credentials.UI;

internal static class Program
{
    private const int UserObjectName = 2;
    private const uint ReadDesktopObjects = 1;
    private const uint NoConsoleSession = uint.MaxValue;

    [STAThread]
    private static int Main(string[] args)
    {
        string title;
        string target;
        if (args is ["--remote-server", string server] && !string.IsNullOrWhiteSpace(server))
        {
            title = "Change the YuGo Pi remote connection";
            target = server;
        }
        else if (args is [string device] && device != "--remote-server")
        {
            title = "Pair a new YuGo Pi device";
            target = string.IsNullOrWhiteSpace(device) ? "New device" : device;
        }
        else
        {
            return 1;
        }

        if (target.Length > 300 || target.Any(char.IsControl) || !IsUnlockedConsole())
            return 1;

        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        using var window = new Form
        {
            Text = "YuGo Pi",
            StartPosition = FormStartPosition.CenterScreen,
            ClientSize = new Size(370, 130),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MinimizeBox = false,
            MaximizeBox = false,
        };
        window.Controls.Add(new Label
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            Text = $"{title}\r\n\r\n{target}\r\nConfirm with Windows Hello.",
        });
        var approved = false;
        window.Shown += async (_, _) =>
        {
            try
            {
                if (IsUnlockedConsole() &&
                    await UserConsentVerifier.CheckAvailabilityAsync() == UserConsentVerifierAvailability.Available &&
                    await UserConsentVerifierInterop.RequestVerificationForWindowAsync(window.Handle, $"{title} ({target})") ==
                        UserConsentVerificationResult.Verified &&
                    IsUnlockedConsole())
                {
                    approved = true;
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"Windows Hello could not verify the local user ({error.HResult:X8}).");
            }
            finally
            {
                if (!window.IsDisposed)
                    window.Close();
            }
        };
        Application.Run(window);
        if (!approved)
            return 1;
        using var output = Console.OpenStandardOutput();
        output.Write("approved\n"u8);
        return 0;
    }

    private static bool IsUnlockedConsole()
    {
        using var process = Process.GetCurrentProcess();
        var console = WTSGetActiveConsoleSessionId();
        if (console == NoConsoleSession || console == 0 || (uint)process.SessionId != console)
            return false;

        var inputDesktop = OpenInputDesktop(0, false, ReadDesktopObjects);
        if (inputDesktop == IntPtr.Zero)
            return false;
        try
        {
            var name = new StringBuilder(32);
            return GetUserObjectInformation(inputDesktop, UserObjectName, name, name.Capacity * sizeof(char), out _) &&
                string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            CloseDesktop(inputDesktop);
        }
    }

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);

    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int size, out int required);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);
}
