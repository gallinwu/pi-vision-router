// pi-vision-router Windows installer -- a single-file WinForms wizard.
//
// Compiled with the C# compiler that ships with Windows (.NET Framework 4.x),
// so building it needs no SDK, no NuGet, no Node. The goal is a double-clickable
// installer that works on a clean Windows box: it finds or installs Pi, installs
// the extension, and verifies it loads.
//
// Compiled by tools/build-installer.ps1 into dist/pi-vision-router-setup.exe.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PiVisionRouterSetup
{
    internal static class Program
    {
        internal const string AppTitle = "pi-vision-router Setup";
        internal const string RepoSlug = "gallinwu/pi-vision-router";
        internal const string RepoSource = "git:github.com/" + RepoSlug;
        internal const string Version = "0.1.0";

        [STAThread]
        private static void Main(string[] rawArgs)
        {
            // --dry-run reports what the wizard would do without changing anything;
            // --silent runs install (or --dry-run) headless and prints to stdout so
            // CI and the build script can verify the installer end to end.
            var args = rawArgs ?? new string[0];
            var dryRun = Array.Exists(args, a => a.Equals("--dry-run", StringComparison.OrdinalIgnoreCase));
            var silent = Array.Exists(args, a => a.Equals("--silent", StringComparison.OrdinalIgnoreCase));
            var uninstall = Array.Exists(args, a => a.Equals("--uninstall", StringComparison.OrdinalIgnoreCase));

            if (silent)
            {
                Environment.ExitCode = SilentRunner.Run(dryRun, uninstall);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm(dryRun));
        }
    }

    /// <summary>Headless mode: same steps, printed to stdout, exit code 0/1.</summary>
    internal static class SilentRunner
    {
        internal static int Run(bool dryRun, bool uninstall)
        {
            var tools = Toolchain.Discover();
            Console.WriteLine("pi-vision-router setup " + Program.Version + (dryRun ? " (dry-run)" : ""));
            Console.WriteLine("node  : " + (tools.HasNode ? tools.NodePath : "NOT FOUND"));
            Console.WriteLine("npm   : " + (tools.HasNpm ? tools.NpmPath : "NOT FOUND"));
            Console.WriteLine("pi    : " + (tools.HasPi ? tools.PiDisplay : "NOT FOUND"));
            Console.WriteLine("action: " + (uninstall ? "remove" : "install") + " " + Program.RepoSource);

            if (dryRun)
            {
                Console.WriteLine("dry-run: nothing was changed");
                if (!tools.HasNode) { Console.WriteLine("BLOCKER: Node.js not found"); return 1; }
                if (!uninstall && !tools.HasPi) Console.WriteLine("note   : Pi will be installed via npm on a real run");
                return 0;
            }

            if (!tools.HasNode)
            {
                Console.WriteLine("FAILED: Node.js is required (https://nodejs.org)");
                return 1;
            }

            if (!tools.HasPi && !uninstall)
            {
                Console.WriteLine("installing Pi via npm...");
                var npm = new ProcessRunner(Console.WriteLine);
                var result = npm.Run("cmd.exe",
                    "/c \"\"" + tools.NpmPath + "\" install -g @earendil-works/pi-coding-agent\"",
                    null, 1800000);
                if (result.ExitCode != 0) { Console.WriteLine("FAILED: npm install pi (exit " + result.ExitCode + ")"); return 1; }
                tools = Toolchain.Discover();
                if (!tools.HasPi) { Console.WriteLine("FAILED: Pi still not found"); return 1; }
            }

            var verb = uninstall ? "remove" : "install";
            var runner = new ProcessRunner(Console.WriteLine);

            // Clear a stale registration of this same package first: two entries for
            // one extension make Pi fail to load both with "Tool ... conflicts".
            if (!uninstall)
            {
                var prior = RemovePriorForSilent(tools);
                if (prior > 0) Console.WriteLine("cleared " + prior + " previous registration(s)");
            }

            var full = string.IsNullOrEmpty(tools.PiPrefixArgs)
                ? verb + " " + Program.RepoSource
                : tools.PiPrefixArgs + " " + verb + " " + Program.RepoSource;
            var run = runner.Run(tools.PiPath, full, null, 1800000);
            Console.WriteLine(run.ExitCode == 0 ? "OK" : "FAILED: exit " + run.ExitCode);
            return run.ExitCode == 0 ? 0 : 1;
        }

        /// <summary>Headless twin of SetupForm.RemovePriorRegistration.</summary>
        private static int RemovePriorForSilent(Toolchain tools)
        {
            var runner = new ProcessRunner(Console.WriteLine);
            var prefix = string.IsNullOrEmpty(tools.PiPrefixArgs) ? "" : tools.PiPrefixArgs + " ";
            var removed = 0;

            // Best effort through Pi first (it also cleans git checkouts and npm
            // installs), then unconditionally fix up settings -- `pi remove` cannot
            // match a relative local entry, which is exactly the leftover that breaks
            // loading.
            foreach (var entry in SettingsReader.RegisteredPackages())
            {
                if (entry == Program.RepoSource) continue;
                if (entry.IndexOf("pi-vision-router", StringComparison.OrdinalIgnoreCase) < 0) continue;
                Console.WriteLine("removing previous registration: " + entry);
                runner.Run(tools.PiPath, prefix + "remove " + Toolchain.Quote(entry), null, 300000);
            }

            removed = SettingsReader.DropMatching(delegate(string value)
            {
                if (value == Program.RepoSource) return false;
                return value.IndexOf("pi-vision-router", StringComparison.OrdinalIgnoreCase) >= 0;
            });
            return removed;
        }
    }

    /// <summary>Reads the raw package list out of Pi's settings.json without a JSON library.</summary>
    internal static class SettingsReader
    {
        private static string SettingsPath
        {
            get
            {
                var agentDir = Environment.GetEnvironmentVariable("PI_CODING_AGENT_DIR");
                if (string.IsNullOrEmpty(agentDir))
                    agentDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        @".pi\agent");
                return Path.Combine(agentDir, "settings.json");
            }
        }

        internal static List<string> RegisteredPackages()
        {
            var result = new List<string>();
            try
            {
                var path = SettingsPath;
                if (!File.Exists(path)) return result;
                var text = File.ReadAllText(path);

                var key = text.IndexOf("\"packages\"", StringComparison.Ordinal);
                if (key < 0) return result;
                var open = text.IndexOf('[', key);
                if (open < 0) return result;
                var close = text.IndexOf(']', open);
                if (close < 0) return result;

                var array = text.Substring(open + 1, close - open - 1);
                foreach (var piece in array.Split(','))
                {
                    var value = Unescape(piece.Trim());
                    if (!string.IsNullOrEmpty(value)) result.Add(value);
                }
            }
            catch
            {
                // A malformed settings file must never stop the installer.
            }
            return result;
        }

        /// <summary>
        /// Drops entries matching <paramref name="predicate"/> from the user settings
        /// file, editing the JSON text in place.
        ///
        /// This exists because `pi remove` cannot do it: Pi resolves a local source to
        /// an absolute path for identity matching, so an entry stored as a relative
        /// path (what `pi install ..\..\somewhere` writes) never matches and Pi
        /// reports "No matching package found" while the entry stays put. Two entries
        /// for one extension then break loading entirely, so the installer has to
        /// clean the file itself. Returns how many entries were dropped.
        /// </summary>
        internal static int DropMatching(Func<string, bool> predicate)
        {
            try
            {
                var path = SettingsPath;
                if (!File.Exists(path)) return 0;
                var text = File.ReadAllText(path);

                var key = text.IndexOf("\"packages\"", StringComparison.Ordinal);
                if (key < 0) return 0;
                var open = text.IndexOf('[', key);
                if (open < 0) return 0;
                var close = text.IndexOf(']', open);
                if (close < 0) return 0;

                var array = text.Substring(open + 1, close - open - 1);
                var kept = new List<string>();
                var dropped = 0;
                foreach (var piece in array.Split(','))
                {
                    var trimmed = piece.Trim();
                    if (trimmed.Length == 0) continue;
                    var value = Unescape(trimmed);
                    if (value.Length == 0) continue;
                    if (predicate(value)) { dropped++; continue; }
                    kept.Add(trimmed);
                }
                if (dropped == 0) return 0;

                var rebuilt = kept.Count == 0
                    ? "[]"
                    : "[\n" + string.Join(",\n", kept.ToArray()) + "\n  ]";
                var output = text.Substring(0, open) + rebuilt + text.Substring(close + 1);

                // Write beside the original and swap, so a crash cannot truncate it.
                var tmp = path + ".tmp";
                File.WriteAllText(tmp, output);
                if (File.Exists(path)) File.Delete(path);
                File.Move(tmp, path);
                return dropped;
            }
            catch
            {
                return 0;
            }
        }

        /// <summary>Undoes JSON string escaping for the subset Pi writes.</summary>
        private static string Unescape(string quoted)
        {
            if (quoted.Length < 2 || quoted[0] != '"') return "";
            var body = quoted.Substring(1, quoted.Length - 2);
            var sb = new StringBuilder(body.Length);
            for (var i = 0; i < body.Length; i++)
            {
                var c = body[i];
                if (c != '\\' || i + 1 >= body.Length) { sb.Append(c); continue; }
                var n = body[++i];
                switch (n)
                {
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case '"': sb.Append('"'); break;
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    default: sb.Append(n); break;
                }
            }
            return sb.ToString();
        }
    }

    /// <summary>Runs child processes and streams their output to the UI.</summary>
    internal sealed class ProcessRunner
    {
        private readonly Action<string> _log;

        internal ProcessRunner(Action<string> log)
        {
            _log = log;
        }

        internal sealed class Result
        {
            internal int ExitCode;
            internal string Output;
            internal bool Started;
        }

        internal Result Run(string fileName, string arguments, string workingDirectory = null, int timeoutMs = 0)
        {
            var result = new Result();
            var output = new StringBuilder();

            var info = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            if (!string.IsNullOrEmpty(workingDirectory)) info.WorkingDirectory = workingDirectory;

            try
            {
                using (var process = new Process())
                {
                    process.StartInfo = info;
                    process.OutputDataReceived += (s, e) =>
                    {
                        if (e.Data == null) return;
                        output.AppendLine(e.Data);
                        _log(e.Data);
                    };
                    process.ErrorDataReceived += (s, e) =>
                    {
                        if (e.Data == null) return;
                        output.AppendLine(e.Data);
                        _log(e.Data);
                    };

                    if (!process.Start()) return result;
                    result.Started = true;
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();

                    if (timeoutMs > 0)
                    {
                        if (!process.WaitForExit(timeoutMs))
                        {
                            try { process.Kill(); } catch { }
                            output.AppendLine("(timed out after " + (timeoutMs / 1000) + "s)");
                            result.ExitCode = -1;
                        }
                        else
                        {
                            result.ExitCode = process.ExitCode;
                        }
                    }
                    else
                    {
                        process.WaitForExit();
                        result.ExitCode = process.ExitCode;
                    }
                }
            }
            catch (Exception ex)
            {
                output.AppendLine(ex.Message);
                result.ExitCode = -1;
            }

            result.Output = output.ToString();
            return result;
        }

        /// <summary>Captures output without streaming. Used for discovery probes.</summary>
        internal static string Capture(string fileName, string arguments, int timeoutMs = 20000)
        {
            try
            {
                var info = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                using (var process = Process.Start(info))
                {
                    if (process == null) return "";
                    var stdout = process.StandardOutput.ReadToEnd();
                    var stderr = process.StandardError.ReadToEnd();
                    if (!process.WaitForExit(timeoutMs))
                    {
                        try { process.Kill(); } catch { }
                        return stdout;
                    }
                    return (stdout + "\n" + stderr).Trim();
                }
            }
            catch
            {
                return "";
            }
        }
    }

    /// <summary>Finds the tools this installer drives: node, npm and the Pi CLI.</summary>
    internal sealed class Toolchain
    {
        internal string NodePath;
        internal string NpmPath;
        internal string PiPath;
        internal string PiPrefixArgs;
        internal string PiDisplay;

        internal bool HasNode { get { return !string.IsNullOrEmpty(NodePath); } }
        internal bool HasNpm { get { return !string.IsNullOrEmpty(NpmPath); } }
        internal bool HasPi { get { return !string.IsNullOrEmpty(PiPath); } }

        internal static Toolchain Discover()
        {
            var t = new Toolchain();

            t.NodePath = ResolveOnPath("node.exe") ?? ResolveOnPath("node");
            t.NpmPath = ResolveOnPath("npm.cmd") ?? ResolveOnPath("npm");

            // A `pi` shim is not enough: .ps1/.cmd shims break under restricted
            // ExecutionPolicy, and this installer exists partly to avoid that.
            // Prefer the shim when it is a real .exe, else drive the CLI with node.
            var piCmd = ResolveOnPath("pi.cmd");
            var piExe = ResolveOnPath("pi.exe");

            if (!string.IsNullOrEmpty(piExe))
            {
                t.PiPath = piExe;
                t.PiPrefixArgs = "";
                t.PiDisplay = piExe;
                return t;
            }

            var cli = FindPiCli();
            if (!string.IsNullOrEmpty(cli) && t.HasNode)
            {
                t.PiPath = t.NodePath;
                t.PiPrefixArgs = Quote(cli);
                t.PiDisplay = "node " + cli;
                return t;
            }

            if (!string.IsNullOrEmpty(piCmd))
            {
                t.PiPath = piCmd;
                t.PiPrefixArgs = "";
                t.PiDisplay = piCmd;
            }
            return t;
        }

        /// <summary>Locates @earendil-works/pi-coding-agent/dist/cli.js under the npm prefixes.</summary>
        internal static string FindPiCli()
        {
            var candidates = new List<string>();
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var programFiles = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
            var programFilesX86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");

            if (!string.IsNullOrEmpty(appData))
                candidates.Add(Path.Combine(appData, @"npm\node_modules"));
            candidates.Add(Path.Combine(programFiles, @"nodejs\node_modules"));
            if (!string.IsNullOrEmpty(programFilesX86))
                candidates.Add(Path.Combine(programFilesX86, @"nodejs\node_modules"));

            // npm's own global root, when npm is available.
            var npmRoot = ProcessRunner.Capture("cmd.exe", "/c npm root -g");
            if (!string.IsNullOrEmpty(npmRoot))
            {
                foreach (var line in npmRoot.Split('\n'))
                {
                    var trimmed = line.Trim();
                    if (trimmed.Length > 3 && Directory.Exists(trimmed)) candidates.Add(trimmed);
                }
            }

            foreach (var root in candidates)
            {
                var cli = Path.Combine(root, @"@earendil-works\pi-coding-agent\dist\cli.js");
                if (File.Exists(cli)) return cli;
            }
            return null;
        }

        internal static string ResolveOnPath(string fileName)
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var dir in path.Split(';'))
            {
                if (string.IsNullOrEmpty(dir)) continue;
                try
                {
                    var full = Path.Combine(dir.Trim('"'), fileName);
                    if (File.Exists(full)) return full;
                }
                catch { }
            }
            return null;
        }

        internal static string Quote(string value)
        {
            if (string.IsNullOrEmpty(value)) return "\"\"";
            return value.IndexOf(' ') >= 0 ? "\"" + value + "\"" : value;
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly Label _status;
        private readonly TextBox _log;
        private readonly ProgressBar _progress;
        private readonly Button _installButton;
        private readonly Button _uninstallButton;
        private readonly Button _checkButton;
        private readonly Button _openFolderButton;
        private readonly CheckBox _verify;
        private readonly Toolchain _tools;
        private const int TotalSteps = 4;

        internal SetupForm(bool dryRun = false)
        {
            Text = Program.AppTitle + " " + Program.Version;
            ClientSize = new Size(760, 560);
            MinimumSize = new Size(680, 500);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9f);
            BackColor = Color.FromArgb(250, 250, 252);

            _tools = Toolchain.Discover();

            var header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 92,
                BackColor = Color.FromArgb(24, 26, 33),
            };
            var title = new Label
            {
                Text = "pi-vision-router",
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 17f),
                AutoSize = true,
                Location = new Point(20, 16),
            };
            var subtitle = new Label
            {
                Text = "Give a text-only Pi model eyes -- vision tools over a free, keyless chain.",
                ForeColor = Color.FromArgb(168, 174, 190),
                AutoSize = true,
                Location = new Point(22, 52),
            };
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            Controls.Add(header);

            var envBox = new GroupBox
            {
                Text = "Environment",
                Location = new Point(18, 106),
                Size = new Size(724, 104),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            };
            Controls.Add(envBox);

            var envText = new Label
            {
                Location = new Point(12, 22),
                Size = new Size(700, 72),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                Text =
                    "Node.js : " + (string.IsNullOrEmpty(_tools.NodePath) ? "NOT FOUND" : _tools.NodePath) + "\r\n" +
                    "npm     : " + (string.IsNullOrEmpty(_tools.NpmPath) ? "NOT FOUND" : _tools.NpmPath) + "\r\n" +
                    "Pi CLI  : " + (string.IsNullOrEmpty(_tools.PiDisplay) ? "NOT FOUND" : _tools.PiDisplay),
            };
            envText.ForeColor = _tools.HasNode && _tools.HasPi
                ? Color.FromArgb(22, 110, 60)
                : Color.FromArgb(170, 60, 40);
            envBox.Controls.Add(envText);

            _verify = new CheckBox
            {
                Text = "Verify the extension loads after installing (recommended)",
                Checked = true,
                Location = new Point(20, 220),
                AutoSize = true,
            };
            Controls.Add(_verify);

            _progress = new ProgressBar
            {
                Location = new Point(18, 246),
                Size = new Size(724, 8),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                Maximum = TotalSteps,
                Style = ProgressBarStyle.Continuous,
            };
            Controls.Add(_progress);

            _status = new Label
            {
                Location = new Point(18, 260),
                Size = new Size(724, 22),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                Text = "Ready.",
                ForeColor = Color.FromArgb(60, 64, 76),
            };
            Controls.Add(_status);

            _log = new TextBox
            {
                Location = new Point(18, 288),
                Size = new Size(724, 196),
                Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.FromArgb(28, 30, 38),
                ForeColor = Color.FromArgb(206, 212, 226),
                Font = new Font("Consolas", 8.5f),
                WordWrap = false,
            };
            Controls.Add(_log);

            var buttonPanel = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 56,
                BackColor = Color.FromArgb(242, 243, 247),
            };
            Controls.Add(buttonPanel);

            _installButton = MakeButton("Install", 20, Color.FromArgb(38, 104, 214), Color.White);
            _installButton.Click += delegate { StartInstall(); };
            buttonPanel.Controls.Add(_installButton);

            _uninstallButton = MakeButton("Uninstall", 132, Color.FromArgb(232, 234, 240), Color.FromArgb(40, 44, 54));
            _uninstallButton.Click += delegate { StartUninstall(); };
            buttonPanel.Controls.Add(_uninstallButton);

            _checkButton = MakeButton("Check", 244, Color.FromArgb(232, 234, 240), Color.FromArgb(40, 44, 54));
            _checkButton.Click += delegate { StartCheck(); };
            buttonPanel.Controls.Add(_checkButton);

            _openFolderButton = MakeButton("Open settings folder", 336, Color.FromArgb(232, 234, 240), Color.FromArgb(40, 44, 54));
            _openFolderButton.Size = new Size(150, 32);
            _openFolderButton.Click += delegate { OpenSettingsFolder(); };
            buttonPanel.Controls.Add(_openFolderButton);

            var close = MakeButton("Close", 700, Color.FromArgb(232, 234, 240), Color.FromArgb(40, 44, 54));
            close.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            close.Click += delegate { Close(); };
            buttonPanel.Controls.Add(close);

            Append("pi-vision-router Setup " + Program.Version);
            Append("Source: " + Program.RepoSource);
            Append("");
            if (!_tools.HasNode)
                Append("Node.js was not found on PATH. Install Node 20+ first: https://nodejs.org");
            else if (!_tools.HasPi)
                Append("Pi was not found. Press Install and this wizard will add it via npm.");
            else
                Append("Pi found. Press Install to add the extension.");
        }

        private Button MakeButton(string text, int x, Color back, Color fore)
        {
            return new Button
            {
                Text = text,
                Location = new Point(x, 12),
                Size = new Size(104, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = back,
                ForeColor = fore,
                FlatAppearance = { BorderSize = 0 },
                Cursor = Cursors.Hand,
            };
        }

        private void Append(string line)
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action)(() => Append(line)));
                return;
            }
            _log.AppendText(line + "\r\n");
        }

        private void SetStatus(string text)
        {
            if (InvokeRequired)
            {
                BeginInvoke((Action)(() => SetStatus(text)));
                return;
            }
            _status.Text = text;
        }

        private void Advance()
        {
            if (InvokeRequired) { BeginInvoke((Action)Advance); return; }
            if (_progress.Value < _progress.Maximum) _progress.Value++;
        }

        private void SetBusy(bool busy)
        {
            if (InvokeRequired) { BeginInvoke((Action)(() => SetBusy(busy))); return; }
            _installButton.Enabled = !busy;
            _uninstallButton.Enabled = !busy;
            _checkButton.Enabled = !busy;
            Cursor = busy ? Cursors.WaitCursor : Cursors.Default;
        }

        private void StartInstall()
        {
            _progress.Value = 0;
            _log.Clear();
            var worker = new Thread(InstallWorker) { IsBackground = true };
            worker.Start();
        }

        private void StartUninstall()
        {
            _progress.Value = 0;
            _log.Clear();
            var worker = new Thread(UninstallWorker) { IsBackground = true };
            worker.Start();
        }

        private void StartCheck()
        {
            _progress.Value = 0;
            _log.Clear();
            var worker = new Thread(CheckWorker) { IsBackground = true };
            worker.Start();
        }

        private ProcessRunner.Result Pi(string arguments, int timeoutMs = 0)
        {
            var runner = new ProcessRunner(Append);
            var full = string.IsNullOrEmpty(_tools.PiPrefixArgs)
                ? arguments
                : _tools.PiPrefixArgs + " " + arguments;
            return runner.Run(_tools.PiPath, full, null, timeoutMs);
        }

        private void InstallWorker()
        {
            SetBusy(true);
            try
            {
                // Step 1: Pi itself.
                SetStatus("Step 1/4  Checking Pi...");
                var tools = Toolchain.Discover();
                if (!tools.HasPi)
                {
                    if (!tools.HasNode)
                    {
                        Append("Node.js is required and was not found.");
                        Append("Install Node 20+ from https://nodejs.org and run this installer again.");
                        SetStatus("Stopped: Node.js missing.");
                        return;
                    }
                    Append("Pi not found -- installing it with npm.");
                    var npm = new ProcessRunner(Append);
                    var npmResult = npm.Run("cmd.exe",
                        "/c \"\"" + tools.NpmPath + "\" install -g @earendil-works/pi-coding-agent\"",
                        null, 900000);
                    if (npmResult.ExitCode != 0)
                    {
                        Append("npm install failed (exit " + npmResult.ExitCode + ").");
                        SetStatus("Stopped: could not install Pi.");
                        return;
                    }
                    tools = Toolchain.Discover();
                    if (!tools.HasPi)
                    {
                        Append("Pi still not found after npm install.");
                        SetStatus("Stopped: Pi not found.");
                        return;
                    }
                }
                Append("Pi: " + tools.PiDisplay);
                _tools.NodePath = tools.NodePath;
                _tools.NpmPath = tools.NpmPath;
                _tools.PiPath = tools.PiPath;
                _tools.PiPrefixArgs = tools.PiPrefixArgs;
                _tools.PiDisplay = tools.PiDisplay;
                Advance();

                // Step 2: the extension.
                SetStatus("Step 2/4  Installing the extension...");
                Append("");
                // A second entry pointing at the same extension makes Pi fail to
                // load BOTH copies ("Tool vision_describe conflicts with ..."), so
                // clear any prior registration of this package before installing.
                RemovePriorRegistration();
                Append("Running: pi install " + Program.RepoSource);
                Append("Pi clones the repo and installs sharp + potrace; this downloads a native");
                Append("binary and can take a few minutes on a slow connection.");
                var install = Pi("install " + Program.RepoSource, 1200000);
                if (install.ExitCode != 0)
                {
                    Append("");
                    Append("pi install failed (exit " + install.ExitCode + ").");
                    Append("If this is a network problem, retry. If Pi reports the package is");
                    Append("already installed, use Check instead.");
                    SetStatus("Stopped: pi install failed.");
                    return;
                }
                Advance();

                // Step 3: confirm it is registered.
                SetStatus("Step 3/4  Checking installed extensions...");
                Append("");
                var list = Pi("list", 120000);
                if (!list.Output.Contains("pi-vision-router"))
                {
                    Append("Warning: pi list does not mention pi-vision-router yet.");
                }
                Advance();

                // Step 4: optional end-to-end probe.
                if (_verify.Checked)
                {
                    SetStatus("Step 4/4  Verifying the extension loads...");
                    Append("");
                    Append("Running a load probe (needs a configured model to answer).");
                    var probe = Pi("-p \"reply with the single word: loaded\"", 600000);
                    if (probe.Output.IndexOf("loaded", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        Append("");
                        Append("Probe OK -- extension loaded without warnings.");
                    }
                    else
                    {
                        Append("");
                        Append("Probe did not return 'loaded'. The extension may still be fine:");
                        Append("a probe also needs a working model configured in Pi.");
                    }
                    Advance();
                }
                else
                {
                    SetStatus("Step 4/4  Verification skipped.");
                    Advance();
                }

                Append("");
                Append("Done.");
                Append("");
                Append("Restart Pi, then:");
                Append("  /vision                    status of the vision chain");
                Append("  /see <image> <question>     ask the chain directly");
                Append("  <drop an image into pi>     the model sees it via vision_describe");
                SetStatus("Finished. Restart Pi to use it.");
            }
            catch (Exception ex)
            {
                Append("Unexpected error: " + ex.Message);
                SetStatus("Failed: " + ex.Message);
            }
            finally
            {
                SetBusy(false);
            }
        }

        /// <summary>
        /// Removes any already-registered copy of this package before installing.
        /// Pi keys tool names per extension, so two entries for the same extension
        /// (a stale local path plus the git source, say) make BOTH fail to load
        /// with "Tool vision_describe conflicts with ...". Re-installing must not
        /// leave that state behind.
        /// </summary>
        private void RemovePriorRegistration()
        {
            // Try Pi's own remove first (it also cleans a git checkout or npm install),
            // then fix settings directly: `pi remove` cannot match a relative local
            // entry, and that leftover is what makes BOTH copies fail to load.
            foreach (var entry in SettingsReader.RegisteredPackages())
            {
                if (entry == Program.RepoSource) continue;
                if (entry.IndexOf("pi-vision-router", StringComparison.OrdinalIgnoreCase) < 0) continue;
                Append("Removing previous registration: " + entry);
                Pi("remove " + Toolchain.Quote(entry), 300000);
            }

            var dropped = SettingsReader.DropMatching(delegate(string value)
            {
                if (value == Program.RepoSource) return false;
                return value.IndexOf("pi-vision-router", StringComparison.OrdinalIgnoreCase) >= 0;
            });
            if (dropped > 0) Append("Cleaned " + dropped + " stale entr" + (dropped == 1 ? "y" : "ies") + " from settings.json");
        }

        private void UninstallWorker()
        {
            SetBusy(true);
            try
            {
                SetStatus("Removing the extension...");
                Append("Running: pi remove " + Program.RepoSource);
                var result = Pi("remove " + Program.RepoSource, 300000);
                if (result.ExitCode == 0)
                {
                    Append("Removed.");
                    SetStatus("Removed. Restart Pi.");
                }
                else
                {
                    Append("pi remove exited with " + result.ExitCode + ".");
                    SetStatus("Remove failed -- see the log.");
                }
            }
            finally
            {
                SetBusy(false);
            }
        }

        private void CheckWorker()
        {
            SetBusy(true);
            try
            {
                SetStatus("Checking installed extensions...");
                var list = Pi("list", 120000);
                Append(list.Output);
                if (list.Output.Contains("pi-vision-router"))
                {
                    Append("");
                    Append("pi-vision-router appears to be installed.");
                    SetStatus("Installed.");
                }
                else
                {
                    Append("");
                    Append("pi-vision-router was not found in the installed package list.");
                    SetStatus("Not installed.");
                }
            }
            finally
            {
                SetBusy(false);
            }
        }

        private void OpenSettingsFolder()
        {
            try
            {
                var dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    @".pi\agent");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Process.Start("explorer.exe", Toolchain.Quote(dir));
            }
            catch (Exception ex)
            {
                Append("Could not open the folder: " + ex.Message);
            }
        }
    }
}
