using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                Console.WriteLine("{\"ok\":false,\"error\":\"Missing command\"}");
                return 2;
            }

            if (string.Equals(args[0], "discover", StringComparison.OrdinalIgnoreCase))
            {
                Console.WriteLine(DiscoverMonitors(ContainsOption(args, "--scan-inputs")));
                return 0;
            }

            if (string.Equals(args[0], "read", StringComparison.OrdinalIgnoreCase))
            {
                string monitorSelector = GetMonitorSelector(args);
                if (string.IsNullOrWhiteSpace(monitorSelector))
                {
                    throw new ArgumentException("--monitor-id or --hardware-id is required");
                }

                MonitorInputState state = Ddc.ReadInput(monitorSelector);
                if (state == null)
                {
                    throw new InvalidOperationException("Matching monitor was not found");
                }
                if (!state.ReadOk)
                {
                    throw new Win32Exception(state.ErrorCode, "DDC read failed");
                }

                Console.WriteLine(
                    "{\"ok\":true,\"current\":" + state.CurrentValue +
                    ",\"currentHex\":\"" + state.CurrentValue.ToString("X4") +
                    "\",\"max\":" + state.MaximumValue +
                    ",\"maxHex\":\"" + state.MaximumValue.ToString("X4") + "\"}");
                return 0;
            }

            if (string.Equals(args[0], "scan", StringComparison.OrdinalIgnoreCase))
            {
                string monitorSelector = GetMonitorSelector(args);
                if (string.IsNullOrWhiteSpace(monitorSelector))
                {
                    throw new ArgumentException("--monitor-id or --hardware-id is required");
                }

                MonitorScanState state = Ddc.ScanInput(monitorSelector);
                if (state == null)
                {
                    throw new InvalidOperationException("Matching monitor was not found");
                }
                if (!state.ReadOk)
                {
                    throw new Win32Exception(state.ErrorCode, "DDC read failed");
                }

                Console.WriteLine(BuildScanJson(state));
                return 0;
            }

            if (string.Equals(args[0], "set", StringComparison.OrdinalIgnoreCase))
            {
                string monitorSelector = GetMonitorSelector(args);
                string valueText = GetOption(args, "--value");
                if (string.IsNullOrWhiteSpace(monitorSelector))
                {
                    throw new ArgumentException("--monitor-id or --hardware-id is required");
                }
                if (string.IsNullOrWhiteSpace(valueText))
                {
                    throw new ArgumentException("--value is required");
                }

                string normalized = valueText.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                    ? valueText.Substring(2)
                    : valueText;
                uint value = uint.Parse(normalized, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                MonitorInputResult result = Ddc.SetInput(monitorSelector, value);
                if (result == null)
                {
                    throw new InvalidOperationException("Matching monitor was not found");
                }
                if (!result.SetOk)
                {
                    throw new Win32Exception(result.ErrorCode, "DDC write failed");
                }

                Console.WriteLine("{\"ok\":true}");
                return 0;
            }

            throw new ArgumentException("Unknown command: " + args[0]);
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}");
            return 1;
        }
    }

    private static string GetOption(string[] args, string name)
    {
        for (int i = 1; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }
        return null;
    }

    private static bool ContainsOption(string[] args, string name)
    {
        for (int i = 1; i < args.Length; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static string GetMonitorSelector(string[] args)
    {
        string monitorId = GetOption(args, "--monitor-id");
        if (!string.IsNullOrWhiteSpace(monitorId))
        {
            return monitorId;
        }
        return GetOption(args, "--hardware-id");
    }

    private static string DiscoverMonitors(bool scanInputs)
    {
        var parts = new List<string>();
        var activeStates = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        var outputTechnologies = new Dictionary<string, uint>(StringComparer.OrdinalIgnoreCase);
        ManagementObjectSearcher searcher = null;
        ManagementObjectCollection results = null;
        ManagementObjectSearcher stateSearcher = null;
        ManagementObjectCollection stateResults = null;
        ManagementObjectSearcher outputSearcher = null;
        ManagementObjectCollection outputResults = null;

        try
        {
            stateSearcher = new ManagementObjectSearcher(
                "root\\WMI",
                "SELECT InstanceName, Active FROM WmiMonitorBasicDisplayParams");
            stateResults = stateSearcher.Get();
            foreach (ManagementObject monitor in stateResults)
            {
                string instanceName = Convert.ToString(monitor["InstanceName"]);
                activeStates[instanceName] = Convert.ToBoolean(monitor["Active"]);
            }

            outputSearcher = new ManagementObjectSearcher(
                "root\\WMI",
                "SELECT InstanceName, VideoOutputTechnology FROM WmiMonitorConnectionParams");
            outputResults = outputSearcher.Get();
            foreach (ManagementObject monitor in outputResults)
            {
                string instanceName = Convert.ToString(monitor["InstanceName"]);
                outputTechnologies[instanceName] = Convert.ToUInt32(monitor["VideoOutputTechnology"]);
            }

            searcher = new ManagementObjectSearcher(
                "root\\WMI",
                "SELECT InstanceName, UserFriendlyName, ManufacturerName, SerialNumberID FROM WmiMonitorID");
            results = searcher.Get();

            foreach (ManagementObject monitor in results)
            {
                string instanceName = Convert.ToString(monitor["InstanceName"]);
                string[] idParts = instanceName.Split('\\');
                string hardwareId = idParts.Length >= 2 ? idParts[1] : string.Empty;
                string name = DecodeId(monitor["UserFriendlyName"]);
                string manufacturer = DecodeId(monitor["ManufacturerName"]);
                string serial = DecodeId(monitor["SerialNumberID"]);
                bool active = activeStates.ContainsKey(instanceName) && activeStates[instanceName];
                uint outputTechnology = outputTechnologies.ContainsKey(instanceName)
                    ? outputTechnologies[instanceName]
                    : 0;

                var monitorJson = new StringBuilder();
                monitorJson.Append(
                    "{\"id\":\"" + JsonEscape(instanceName) +
                    "\",\"name\":\"" + JsonEscape(name) +
                    "\",\"manufacturer\":\"" + JsonEscape(manufacturer) +
                    "\",\"serial\":\"" + JsonEscape(serial) +
                    "\",\"hardwareId\":\"" + JsonEscape(hardwareId) +
                    "\",\"instanceName\":\"" + JsonEscape(instanceName) +
                    "\",\"active\":" + (active ? "true" : "false") +
                    ",\"videoOutputTechnology\":" + outputTechnology +
                    ",\"connection\":\"" + JsonEscape(ConnectionLabel(outputTechnology)) + "\"");

                if (scanInputs)
                {
                    try
                    {
                        MonitorScanState state = Ddc.ScanInput(instanceName);
                        if (state == null)
                        {
                            monitorJson.Append(",\"ddcOk\":false,\"ddcError\":\"Matching physical monitor was not found\"");
                        }
                        else if (!state.ReadOk)
                        {
                            monitorJson.Append(
                                ",\"ddcOk\":false,\"ddcError\":\"" +
                                JsonEscape(new Win32Exception(state.ErrorCode, "DDC read failed").Message) +
                                "\"");
                        }
                        else
                        {
                            monitorJson.Append(",\"ddcOk\":true,\"inputScan\":" + BuildScanJson(state));
                        }
                    }
                    catch (Exception ex)
                    {
                        monitorJson.Append(",\"ddcOk\":false,\"ddcError\":\"" + JsonEscape(ex.Message) + "\"");
                    }
                }
                monitorJson.Append("}");
                parts.Add(monitorJson.ToString());
            }
        }
        finally
        {
            if (results != null) results.Dispose();
            if (searcher != null) searcher.Dispose();
            if (stateResults != null) stateResults.Dispose();
            if (stateSearcher != null) stateSearcher.Dispose();
            if (outputResults != null) outputResults.Dispose();
            if (outputSearcher != null) outputSearcher.Dispose();
        }

        return "{\"ok\":true,\"monitors\":[" + string.Join(",", parts.ToArray()) + "]}";
    }

    private static string BuildScanJson(MonitorScanState state)
    {
        var inputs = new List<string>();
        foreach (uint value in state.InputValues)
        {
            inputs.Add(
                "{\"value\":" + value +
                ",\"hex\":\"" + value.ToString("X4") +
                "\",\"label\":\"" + JsonEscape(InputLabel(value)) + "\"}");
        }

        return
            "{\"ok\":true,\"current\":" + state.CurrentValue +
            ",\"currentHex\":\"" + state.CurrentValue.ToString("X4") +
            "\",\"max\":" + state.MaximumValue +
            ",\"maxHex\":\"" + state.MaximumValue.ToString("X4") +
            "\",\"capabilitiesAvailable\":" + (state.CapabilitiesAvailable ? "true" : "false") +
            ",\"inputScanSource\":\"" + JsonEscape(state.InputScanSource) +
            "\",\"inputs\":[" + string.Join(",", inputs.ToArray()) + "]}";
    }

    private static string ConnectionLabel(uint value)
    {
        switch (value)
        {
            case 0: return "Uninitialized";
            case 1: return "VGA";
            case 2: return "S-Video";
            case 3: return "Composite";
            case 4: return "Component";
            case 5: return "DVI";
            case 6: return "HDMI";
            case 10: return "DisplayPort External";
            case 11: return "DisplayPort Embedded";
            case 12: return "UDI External";
            case 13: return "UDI Embedded";
            case 14: return "SDTV Dongle";
            case 15: return "Miracast";
            case 16: return "Indirect Wired";
            case 17: return "Indirect Virtual";
            case 18: return "Internal";
            default: return "Unknown";
        }
    }

    private static string InputLabel(uint value)
    {
        byte high = (byte)((value >> 8) & 0xFF);
        byte low = (byte)(value & 0xFF);
        uint code = value <= 0xFF || high == low || high == 0x0F
            ? low
            : value & 0xFFFF;

        switch (code)
        {
            case 0x01: return "Analog 1";
            case 0x02: return "Analog 2";
            case 0x03: return "DVI 1";
            case 0x04: return "DVI 2";
            case 0x05: return "Composite 1";
            case 0x06: return "Composite 2";
            case 0x07: return "S-Video 1";
            case 0x08: return "S-Video 2";
            case 0x09: return "Tuner 1";
            case 0x0A: return "Tuner 2";
            case 0x0B: return "Tuner 3";
            case 0x0F: return "DisplayPort 1";
            case 0x10: return "DisplayPort 2";
            case 0x11: return "HDMI 1";
            case 0x12: return "HDMI 2";
            case 0x13: return "HDMI 3";
            default: return "Input 0x" + code.ToString("X2");
        }
    }

    private static string DecodeId(object value)
    {
        ushort[] chars = value as ushort[];
        if (chars == null)
        {
            return string.Empty;
        }

        var decoded = new char[chars.Length];
        for (int i = 0; i < chars.Length; i++)
        {
            decoded[i] = chars[i] == 0 ? ' ' : (char)chars[i];
        }
        return new string(decoded).Trim();
    }

    private static string JsonEscape(string value)
    {
        if (value == null)
        {
            return string.Empty;
        }

        return value
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\r", "\\r")
            .Replace("\n", "\\n")
            .Replace("\t", "\\t");
    }
}

internal sealed class MonitorInputState
{
    public string Description;
    public bool ReadOk;
    public int ErrorCode;
    public uint CurrentValue;
    public uint MaximumValue;
}

internal sealed class MonitorInputResult
{
    public string Description;
    public bool SetOk;
    public int ErrorCode;
}

internal sealed class MonitorScanState
{
    public string Description;
    public bool ReadOk;
    public int ErrorCode;
    public uint CurrentValue;
    public uint MaximumValue;
    public bool CapabilitiesAvailable;
    public string InputScanSource;
    public List<uint> InputValues;
}

internal static class Ddc
{
    private delegate bool MonitorEnumDelegate(
        IntPtr hMonitor,
        IntPtr hdcMonitor,
        ref Rect lprcMonitor,
        IntPtr dwData);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public int cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public int dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int cb;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceString;

        public int StateFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceID;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PhysicalMonitor
    {
        public IntPtr hPhysicalMonitor;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szPhysicalMonitorDescription;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayConfigPathSourceInfo
    {
        public Luid adapterId;
        public uint id;
        public uint modeInfoIdx;
        public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayConfigPathTargetInfo
    {
        public Luid adapterId;
        public uint id;
        public uint modeInfoIdx;
        public uint outputTechnology;
        public uint rotation;
        public uint scaling;
        public uint refreshRateNumerator;
        public uint refreshRateDenominator;
        public uint scanLineOrdering;

        [MarshalAs(UnmanagedType.Bool)]
        public bool targetAvailable;

        public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayConfigPathInfo
    {
        public DisplayConfigPathSourceInfo sourceInfo;
        public DisplayConfigPathTargetInfo targetInfo;
        public uint flags;
    }

    [StructLayout(LayoutKind.Explicit, Size = 48)]
    private struct DisplayConfigModeUnion
    {
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayConfigModeInfo
    {
        public uint infoType;
        public uint id;
        public Luid adapterId;
        public DisplayConfigModeUnion mode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayConfigDeviceInfoHeader
    {
        public uint type;
        public uint size;
        public Luid adapterId;
        public uint id;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayConfigSourceDeviceName
    {
        public DisplayConfigDeviceInfoHeader header;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string viewGdiDeviceName;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayConfigTargetDeviceName
    {
        public DisplayConfigDeviceInfoHeader header;
        public uint flags;
        public uint outputTechnology;
        public ushort edidManufactureId;
        public ushort edidProductCodeId;
        public uint connectorInstance;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string monitorFriendlyDeviceName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string monitorDevicePath;
    }

    public enum VcpCodeType
    {
        Momentary,
        SetParameter
    }

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(
        IntPtr hdc,
        IntPtr lprcClip,
        MonitorEnumDelegate lpfnEnum,
        IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetMonitorInfo(
        IntPtr hMonitor,
        ref MonitorInfoEx lpmi);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumDisplayDevices(
        string lpDevice,
        uint iDevNum,
        ref DisplayDevice lpDisplayDevice,
        uint dwFlags);

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(
        uint flags,
        out uint numPathArrayElements,
        out uint numModeInfoArrayElements);

    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(
        uint flags,
        ref uint numPathArrayElements,
        [Out] DisplayConfigPathInfo[] pathInfoArray,
        ref uint numModeInfoArrayElements,
        [Out] DisplayConfigModeInfo[] modeInfoArray,
        IntPtr currentTopologyId);

    [DllImport("user32.dll")]
    private static extern int DisplayConfigGetDeviceInfo(
        ref DisplayConfigSourceDeviceName requestPacket);

    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")]
    private static extern int DisplayConfigGetTargetDeviceInfo(
        ref DisplayConfigTargetDeviceName requestPacket);

    [DllImport("dxva2.dll", SetLastError = true)]
    private static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(
        IntPtr hMonitor,
        out uint pdwNumberOfPhysicalMonitors);

    [DllImport("dxva2.dll", SetLastError = true)]
    private static extern bool GetPhysicalMonitorsFromHMONITOR(
        IntPtr hMonitor,
        uint dwPhysicalMonitorArraySize,
        [Out] PhysicalMonitor[] pPhysicalMonitorArray);

    [DllImport("dxva2.dll", SetLastError = true)]
    private static extern bool DestroyPhysicalMonitors(
        uint dwPhysicalMonitorArraySize,
        [In] PhysicalMonitor[] pPhysicalMonitorArray);

    [DllImport("dxva2.dll", SetLastError = true)]
    private static extern bool GetVCPFeatureAndVCPFeatureReply(
        IntPtr hMonitor,
        byte bVCPCode,
        out VcpCodeType pvct,
        out uint pdwCurrentValue,
        out uint pdwMaximumValue);

    [DllImport("dxva2.dll", SetLastError = true)]
    private static extern bool GetCapabilitiesStringLength(
        IntPtr hMonitor,
        out uint pdwCapabilitiesStringLengthInCharacters);

    [DllImport("dxva2.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    private static extern bool CapabilitiesRequestAndCapabilitiesReply(
        IntPtr hMonitor,
        StringBuilder pszASCIICapabilitiesString,
        uint dwCapabilitiesStringLengthInCharacters);

    [DllImport("dxva2.dll", SetLastError = true)]
    private static extern bool SetVCPFeature(
        IntPtr hMonitor,
        byte bVCPCode,
        uint dwNewValue);

    public static MonitorInputState ReadInput(string hardwareId)
    {
        MonitorInputState found = null;

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
            delegate(IntPtr hMonitor, IntPtr hdcMonitor, ref Rect rect, IntPtr data)
            {
                uint count;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count))
                {
                    return true;
                }

                PhysicalMonitor[] monitors = new PhysicalMonitor[count];
                if (!GetPhysicalMonitorsFromHMONITOR(hMonitor, count, monitors))
                {
                    return true;
                }

                try
                {
                    foreach (PhysicalMonitor monitor in monitors)
                    {
                        if (!MatchesTarget(hMonitor, monitor.szPhysicalMonitorDescription, hardwareId))
                        {
                            continue;
                        }

                        VcpCodeType codeType;
                        uint current;
                        uint maximum;
                        bool ok = GetVCPFeatureAndVCPFeatureReply(
                            monitor.hPhysicalMonitor,
                            0x60,
                            out codeType,
                            out current,
                            out maximum);

                        found = new MonitorInputState
                        {
                            Description = monitor.szPhysicalMonitorDescription,
                            ReadOk = ok,
                            ErrorCode = ok ? 0 : Marshal.GetLastWin32Error(),
                            CurrentValue = current,
                            MaximumValue = maximum
                        };
                    }
                }
                finally
                {
                    DestroyPhysicalMonitors(count, monitors);
                }

                return true;
            },
            IntPtr.Zero);

        return found;
    }

    public static MonitorScanState ScanInput(string monitorSelector)
    {
        MonitorScanState found = null;

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
            delegate(IntPtr hMonitor, IntPtr hdcMonitor, ref Rect rect, IntPtr data)
            {
                if (found != null)
                {
                    return true;
                }

                uint count;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count))
                {
                    return true;
                }

                PhysicalMonitor[] monitors = new PhysicalMonitor[count];
                if (!GetPhysicalMonitorsFromHMONITOR(hMonitor, count, monitors))
                {
                    return true;
                }

                try
                {
                    foreach (PhysicalMonitor monitor in monitors)
                    {
                        if (!MatchesTarget(hMonitor, monitor.szPhysicalMonitorDescription, monitorSelector))
                        {
                            continue;
                        }

                        VcpCodeType codeType;
                        uint current;
                        uint maximum;
                        bool ok = GetVCPFeatureAndVCPFeatureReply(
                            monitor.hPhysicalMonitor,
                            0x60,
                            out codeType,
                            out current,
                            out maximum);

                        string capabilities = ok
                            ? ReadCapabilities(monitor.hPhysicalMonitor)
                            : null;
                        List<uint> inputs = ParseInputSources(capabilities, current, maximum);

                        found = new MonitorScanState
                        {
                            Description = monitor.szPhysicalMonitorDescription,
                            ReadOk = ok,
                            ErrorCode = ok ? 0 : Marshal.GetLastWin32Error(),
                            CurrentValue = current,
                            MaximumValue = maximum,
                            CapabilitiesAvailable = !string.IsNullOrEmpty(capabilities),
                            InputScanSource = !string.IsNullOrEmpty(capabilities) && inputs.Count > 0
                                ? "capabilities"
                                : "fallback",
                            InputValues = inputs
                        };
                        break;
                    }
                }
                finally
                {
                    DestroyPhysicalMonitors(count, monitors);
                }

                return true;
            },
            IntPtr.Zero);

        return found;
    }

    public static MonitorInputResult SetInput(string hardwareId, uint value)
    {
        MonitorInputResult found = null;

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero,
            delegate(IntPtr hMonitor, IntPtr hdcMonitor, ref Rect rect, IntPtr data)
            {
                uint count;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count))
                {
                    return true;
                }

                PhysicalMonitor[] monitors = new PhysicalMonitor[count];
                if (!GetPhysicalMonitorsFromHMONITOR(hMonitor, count, monitors))
                {
                    return true;
                }

                try
                {
                    foreach (PhysicalMonitor monitor in monitors)
                    {
                        if (!MatchesTarget(hMonitor, monitor.szPhysicalMonitorDescription, hardwareId))
                        {
                            continue;
                        }

                        bool ok = SetVCPFeature(monitor.hPhysicalMonitor, 0x60, value);
                        found = new MonitorInputResult
                        {
                            Description = monitor.szPhysicalMonitorDescription,
                            SetOk = ok,
                            ErrorCode = ok ? 0 : Marshal.GetLastWin32Error()
                        };
                    }
                }
                finally
                {
                    DestroyPhysicalMonitors(count, monitors);
                }

                return true;
            },
            IntPtr.Zero);

        return found;
    }

    private static string ReadCapabilities(IntPtr monitorHandle)
    {
        uint length;
        if (!GetCapabilitiesStringLength(monitorHandle, out length) || length == 0)
        {
            return null;
        }

        var buffer = new StringBuilder((int)length + 1);
        if (!CapabilitiesRequestAndCapabilitiesReply(monitorHandle, buffer, length))
        {
            return null;
        }

        return buffer.ToString().TrimEnd('\0');
    }

    private static List<uint> ParseInputSources(string capabilities, uint currentValue, uint maximumValue)
    {
        var values = new List<uint>();
        bool duplicatedBytes = IsRepeatedByteValue(currentValue) || IsRepeatedByteValue(maximumValue);

        if (!string.IsNullOrEmpty(capabilities))
        {
            int marker = capabilities.IndexOf("60(", StringComparison.OrdinalIgnoreCase);
            if (marker >= 0)
            {
                int start = marker + 3;
                int depth = 1;
                int end = start;
                while (end < capabilities.Length && depth > 0)
                {
                    char character = capabilities[end];
                    if (character == '(') depth++;
                    if (character == ')') depth--;
                    end++;
                }

                if (depth == 0)
                {
                    string content = capabilities.Substring(start, Math.Max(0, end - start - 1));
                    string[] tokens = content.Split(
                        new[] { ' ', '\t', '\r', '\n', ',', ';' },
                        StringSplitOptions.RemoveEmptyEntries);
                    foreach (string token in tokens)
                    {
                        string normalized = token.Trim();
                        if (normalized.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                        {
                            normalized = normalized.Substring(2);
                        }
                        if (normalized.Length == 0 || normalized.Length > 4)
                        {
                            continue;
                        }

                        uint parsed;
                        if (!uint.TryParse(normalized, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out parsed))
                        {
                            continue;
                        }

                        if (duplicatedBytes && parsed <= 0xFF)
                        {
                            parsed = parsed * 0x101;
                        }
                        if (!values.Contains(parsed))
                        {
                            values.Add(parsed);
                        }
                    }
                }
            }
        }

        if (values.Count == 0)
        {
            byte[] common = new byte[] { 0x0F, 0x11, 0x12 };
            foreach (byte code in common)
            {
                uint value = duplicatedBytes ? (uint)(code * 0x101) : code;
                if (!values.Contains(value))
                {
                    values.Add(value);
                }
            }
        }

        if (currentValue > 0 && values.Count == 0 && !values.Contains(currentValue))
        {
            values.Add(currentValue);
        }

        values.Sort();
        return values;
    }

    private static bool IsRepeatedByteValue(uint value)
    {
        return value > 0xFF && (value >> 8) == (value & 0xFF);
    }

    private static bool MatchesTarget(
        IntPtr hMonitor,
        string physicalMonitorDescription,
        string monitorSelector)
    {
        string selectorUid = ExtractUid(monitorSelector);
        string activeUid = MonitorUidFromHMonitor(hMonitor);
        if (!string.IsNullOrEmpty(selectorUid) && !string.IsNullOrEmpty(activeUid))
        {
            return string.Equals(selectorUid, activeUid, StringComparison.OrdinalIgnoreCase);
        }

        string hardwareId = HardwareIdFromSelector(monitorSelector);
        MonitorInfoEx monitorInfo = new MonitorInfoEx();
        monitorInfo.cbSize = Marshal.SizeOf(typeof(MonitorInfoEx));

        if (GetMonitorInfo(hMonitor, ref monitorInfo))
        {
            DisplayDevice displayDevice = new DisplayDevice();
            displayDevice.cb = Marshal.SizeOf(typeof(DisplayDevice));

            if (EnumDisplayDevices(monitorInfo.szDevice, 0, ref displayDevice, 0) &&
                displayDevice.DeviceID.IndexOf(hardwareId, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return true;
            }
        }

        return physicalMonitorDescription.IndexOf(
            monitorSelector,
            StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static string HardwareIdFromSelector(string monitorSelector)
    {
        if (string.IsNullOrWhiteSpace(monitorSelector))
        {
            return string.Empty;
        }

        string[] parts = monitorSelector.Split('\\');
        if (parts.Length >= 2 && string.Equals(parts[0], "DISPLAY", StringComparison.OrdinalIgnoreCase))
        {
            return parts[1];
        }
        return monitorSelector;
    }

    private static string MonitorUidFromHMonitor(IntPtr hMonitor)
    {
        MonitorInfoEx monitorInfo = new MonitorInfoEx();
        monitorInfo.cbSize = Marshal.SizeOf(typeof(MonitorInfoEx));
        if (!GetMonitorInfo(hMonitor, ref monitorInfo))
        {
            return string.Empty;
        }

        uint pathCount;
        uint modeCount;
        if (GetDisplayConfigBufferSizes(2, out pathCount, out modeCount) != 0)
        {
            return string.Empty;
        }

        var paths = new DisplayConfigPathInfo[pathCount];
        var modes = new DisplayConfigModeInfo[modeCount];
        if (QueryDisplayConfig(2, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero) != 0)
        {
            return string.Empty;
        }

        for (int i = 0; i < pathCount; i++)
        {
            DisplayConfigPathInfo path = paths[i];
            var sourceName = new DisplayConfigSourceDeviceName();
            sourceName.header.type = 1;
            sourceName.header.size = (uint)Marshal.SizeOf(typeof(DisplayConfigSourceDeviceName));
            sourceName.header.adapterId = path.sourceInfo.adapterId;
            sourceName.header.id = path.sourceInfo.id;
            if (DisplayConfigGetDeviceInfo(ref sourceName) != 0 ||
                !string.Equals(
                    sourceName.viewGdiDeviceName,
                    monitorInfo.szDevice,
                    StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var targetName = new DisplayConfigTargetDeviceName();
            targetName.header.type = 2;
            targetName.header.size = (uint)Marshal.SizeOf(typeof(DisplayConfigTargetDeviceName));
            targetName.header.adapterId = path.targetInfo.adapterId;
            targetName.header.id = path.targetInfo.id;
            if (DisplayConfigGetTargetDeviceInfo(ref targetName) != 0)
            {
                continue;
            }

            string uid = ExtractUid(targetName.monitorDevicePath);
            if (!string.IsNullOrEmpty(uid))
            {
                return uid;
            }
        }

        return string.Empty;
    }

    private static string ExtractUid(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        int marker = value.IndexOf("UID", StringComparison.OrdinalIgnoreCase);
        if (marker < 0)
        {
            return string.Empty;
        }

        int start = marker + 3;
        int end = start;
        while (end < value.Length && Uri.IsHexDigit(value[end]))
        {
            end++;
        }
        return end > start ? value.Substring(start, end - start) : string.Empty;
    }
}
