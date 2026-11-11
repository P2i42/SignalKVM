const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  powerMonitor,
  globalShortcut,
  shell
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const LEGACY_INPUTS = {
  DP: { label: 'DisplayPort 1', value: 0x0f0f, mac: 15 },
  HDMI1: { label: 'HDMI 1', value: 0x1111, mac: 17 },
  HDMI2: { label: 'HDMI 2', value: 0x1212, mac: 18 }
};

function defaultInputSources() {
  return [
    { value: 0x0f0f, hex: '0F0F', label: 'DisplayPort 1' },
    { value: 0x1111, hex: '1111', label: 'HDMI 1' },
    { value: 0x1212, hex: '1212', label: 'HDMI 2' }
  ];
}

function createDefaultProfile() {
  return {
    id: 'DEL41D9',
    hardwareId: 'DEL41D9',
    instanceName: '',
    name: 'DELL S2721DGF',
    manufacturer: 'DEL',
    serial: '',
    connection: '',
    inputSource: '0F0F',
    alternateInput: '1212',
    inputs: defaultInputSources()
  };
}

function createDefaultConfig() {
  return {
    configVersion: 3,
    enabled: true,
    activeMonitorId: 'DEL41D9',
    monitorProfiles: {
      DEL41D9: createDefaultProfile()
    },
    monitors: [],
    inputSource: '0F0F',
    alternateInput: '1212',
    sensitivity: 'normal',
    pollMs: 500,
    cooldownMs: 1800,
    idleBeforeSwitchMs: 0,
    launchAtLogin: false,
    hotkeyEnabled: true,
    hotkeyAccelerator: 'Control+Alt+PageDown',
    windowsHardwareId: 'DEL41D9',
    macDisplaySelector: '',
    lastStatus: '正在启动'
  };
}

const SENSITIVITY_PRESETS = {
  high: { label: '高', pollMs: 250, cooldownMs: 800 },
  normal: { label: '标准', pollMs: 500, cooldownMs: 1800 },
  stable: { label: '稳健', pollMs: 1000, cooldownMs: 3500 }
};

const KNOWN_HOTKEY_CONFLICTS = new Set([
  'Alt+F4',
  'Alt+Space',
  'Alt+Tab',
  'Control+Alt+Delete',
  'Control+Escape',
  'Control+Shift+Escape',
  'Control+Shift+Tab',
  'Control+Tab',
  'Super+D',
  'Super+E',
  'Super+L',
  'Super+R',
  'Super+S'
]);

let tray = null;
let window = null;
let timer = null;
let lastIdleSeconds = 0;
let idlePeakSeconds = 0;
let lastSwitchAt = 0;
let config = null;
let isQuitting = false;
let switching = false;
let registeredHotkey = null;
let hotkeyError = '';

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeInputHex(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(0xffff, Math.round(value))).toString(16).toUpperCase().padStart(4, '0');
  }

  const legacy = LEGACY_INPUTS[String(value || '').toUpperCase()];
  if (legacy) {
    return legacy.value.toString(16).toUpperCase().padStart(4, '0');
  }

  const normalized = String(value || '').replace(/^0x/i, '').trim();
  if (/^[0-9a-f]{1,4}$/i.test(normalized)) {
    return normalized.toUpperCase().padStart(4, '0');
  }
  return '';
}

function inputValue(source) {
  const hex = normalizeInputHex(source);
  return hex ? Number.parseInt(hex, 16) : null;
}

function sourceCode(value) {
  const high = (value >> 8) & 0xff;
  const low = value & 0xff;
  return value <= 0xff || high === low || high === 0x0f
    ? low
    : value & 0xffff;
}

function canonicalInputValue(value, profile) {
  const raw = inputValue(value);
  if (raw === null) {
    return null;
  }
  const match = profile.inputs.find((input) => sourceCode(input.value) === sourceCode(raw));
  return match?.value ?? raw;
}

function normalizeInputSources(inputs, fallbackCurrent = '') {
  const normalized = [];
  if (Array.isArray(inputs)) {
    for (const input of inputs) {
      const hex = normalizeInputHex(input?.hex ?? input?.value ?? input);
      if (!hex || normalized.some((item) => item.hex === hex)) {
        continue;
      }
      const value = Number.parseInt(hex, 16);
      normalized.push({
        value,
        hex,
        label: String(input?.label || `输入 ${hex}`).slice(0, 80)
      });
    }
  }

  const fallbackHex = normalizeInputHex(fallbackCurrent);
  if (fallbackHex && !normalized.some((item) => item.hex === fallbackHex)) {
    normalized.push({
      value: Number.parseInt(fallbackHex, 16),
      hex: fallbackHex,
      label: `输入 ${fallbackHex}`
    });
  }

  if (normalized.length === 0) {
    return defaultInputSources();
  }

  normalized.sort((left, right) => left.value - right.value);
  return normalized;
}

function normalizeProfile(raw, fallback = {}) {
  const source = { ...fallback, ...(raw || {}) };
  const inputs = normalizeInputSources(source.inputs, source.inputSource);
  let inputSource = normalizeInputHex(source.inputSource) || inputs[0].hex;
  if (!inputs.some((item) => item.hex === inputSource)) {
    inputs.push({
      value: Number.parseInt(inputSource, 16),
      hex: inputSource,
      label: `输入 ${inputSource}`
    });
  }

  let alternateInput = normalizeInputHex(source.alternateInput);
  if (!alternateInput || alternateInput === inputSource) {
    alternateInput = inputs.find((item) => item.hex !== inputSource)?.hex || inputSource;
  }

  return {
    id: String(source.id || source.instanceName || source.hardwareId || '').trim(),
    hardwareId: String(source.hardwareId || '').trim().toUpperCase(),
    instanceName: String(source.instanceName || source.id || '').trim(),
    name: String(source.name || '未知显示器').trim(),
    manufacturer: String(source.manufacturer || '').trim(),
    serial: String(source.serial || '').trim(),
    connection: String(source.connection || '').trim(),
    active: source.active !== false,
    ddcOk: source.ddcOk !== false,
    inputSource,
    alternateInput,
    inputs: normalizeInputSources(inputs)
  };
}

function profileKeyForMonitor(monitor) {
  const hardwareId = String(monitor?.hardwareId || '').trim().toUpperCase();
  const serial = String(monitor?.serial || '').trim().toUpperCase();
  const instanceName = String(monitor?.instanceName || monitor?.id || '').trim().toUpperCase();
  const name = String(monitor?.name || 'UNKNOWN').trim().toUpperCase();
  return [hardwareId || 'MONITOR', serial || instanceName || name].join(':');
}

function loadConfig() {
  const defaults = createDefaultConfig();
  try {
    const saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const merged = { ...defaults, ...saved };
    if (!saved.configVersion && saved.hotkeyAccelerator === 'Control+Alt+F10') {
      merged.hotkeyAccelerator = defaults.hotkeyAccelerator;
    }

    merged.monitorProfiles = {};
    if (saved.monitorProfiles && typeof saved.monitorProfiles === 'object') {
      for (const [key, profile] of Object.entries(saved.monitorProfiles)) {
        merged.monitorProfiles[key] = normalizeProfile(profile);
      }
    }

    if (Object.keys(merged.monitorProfiles).length === 0) {
      const legacyKey = String(saved.windowsHardwareId || defaults.windowsHardwareId).trim().toUpperCase();
      const profile = createDefaultProfile();
      profile.id = legacyKey;
      profile.hardwareId = legacyKey;
      profile.inputSource = normalizeInputHex(saved.inputSource) || profile.inputSource;
      profile.alternateInput = normalizeInputHex(saved.alternateInput) || profile.alternateInput;
      merged.monitorProfiles[legacyKey] = normalizeProfile(profile);
      merged.activeMonitorId = legacyKey;
    }

    if (!merged.activeMonitorId || !merged.monitorProfiles[merged.activeMonitorId]) {
      const legacyMatch = Object.entries(merged.monitorProfiles)
        .find(([, profile]) => profile.hardwareId === merged.windowsHardwareId);
      merged.activeMonitorId = legacyMatch?.[0] || Object.keys(merged.monitorProfiles)[0];
    }

    merged.monitors = Array.isArray(saved.monitors) ? saved.monitors : [];
    merged.configVersion = 3;
    return merged;
  } catch {
    return defaults;
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function resourcePath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...parts);
  }
  return path.join(app.getAppPath(), ...parts);
}

function helperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, process.platform === 'win32' ? 'ddc-helper.exe' : 'm1ddc');
  }

  if (process.platform === 'win32') {
    return resourcePath('native', 'windows', 'bin', 'ddc-helper.exe');
  }
  if (process.platform === 'darwin') {
    return resourcePath('third_party', 'm1ddc', 'm1ddc');
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function runHelper(args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(helperPath(), args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function getActiveMonitorProfile() {
  const profiles = config.monitorProfiles || {};
  let key = config.activeMonitorId;
  if (!key || !profiles[key]) {
    const hardwareMatch = Object.entries(profiles)
      .find(([, profile]) => profile.hardwareId === config.windowsHardwareId);
    key = hardwareMatch?.[0] || Object.keys(profiles)[0];
  }

  if (!key || !profiles[key]) {
    const fallback = normalizeProfile(createDefaultProfile());
    profiles.DEL41D9 = fallback;
    key = 'DEL41D9';
  }

  config.activeMonitorId = key;
  return { key, profile: profiles[key] };
}

function syncActiveMonitorToConfig() {
  const { key, profile } = getActiveMonitorProfile();
  config.activeMonitorId = key;
  config.windowsHardwareId = profile.hardwareId || config.windowsHardwareId;
  config.inputSource = profile.inputSource;
  config.alternateInput = profile.alternateInput;
}

function inputLabel(profile, source) {
  const hex = normalizeInputHex(source);
  return profile.inputs.find((item) => item.hex === hex)?.label || `输入 ${hex || '未知'}`;
}

function mergeMonitorDiscovery(monitors) {
  const discoveredProfiles = [];
  for (const monitor of monitors) {
    const key = profileKeyForMonitor(monitor);
    const scan = monitor.inputScan || null;
    const currentHex = normalizeInputHex(scan?.currentHex);
    const existing = config.monitorProfiles[key]
      || Object.values(config.monitorProfiles).find((profile) => (
        profile.hardwareId === monitor.hardwareId
        && (!profile.serial || !monitor.serial || profile.serial === monitor.serial)
      ));
    const inputs = scan?.inputs?.length
      ? normalizeInputSources(scan.inputs)
      : normalizeInputSources(existing?.inputs, existing?.inputSource || currentHex);
    const observedValue = canonicalInputValue(currentHex, { inputs });
    const observedHex = observedValue === null
      ? currentHex
      : observedValue.toString(16).toUpperCase().padStart(4, '0');
    const inputSource = normalizeInputHex(existing?.inputSource)
      || observedHex
      || inputs[0]?.hex;
    const alternateInput = normalizeInputHex(existing?.alternateInput)
      || inputs.find((item) => item.hex !== inputSource)?.hex
      || inputSource;

    const profile = normalizeProfile({
      ...existing,
      ...monitor,
      inputSource,
      alternateInput,
      inputs,
      ddcOk: monitor.ddcOk !== false && Boolean(scan?.ok)
    });
    config.monitorProfiles[key] = profile;
    discoveredProfiles.push({ key, profile });
  }

  const currentActive = getActiveMonitorProfile().profile;
  const currentMatch = discoveredProfiles.find(({ key, profile }) => (
    key === config.activeMonitorId
    || profile.hardwareId === currentActive.hardwareId
    && (!currentActive.serial || !profile.serial || profile.serial === currentActive.serial)
  ));
  const nextActive = currentMatch
    || discoveredProfiles.find(({ profile }) => profile.ddcOk)
    || discoveredProfiles[0];
  if (nextActive) {
    config.activeMonitorId = nextActive.key;
  }

  config.monitors = monitors;
  syncActiveMonitorToConfig();
  saveConfig();
  return getPublicConfig();
}

async function refreshMonitorProfiles() {
  const raw = await runHelper(['discover', '--scan-inputs'], 20000);
  const parsed = JSON.parse(raw);
  if (!parsed.ok || !Array.isArray(parsed.monitors)) {
    throw new Error(parsed.error || '显示器枚举失败');
  }
  const result = mergeMonitorDiscovery(parsed.monitors);
  updateTrayMenu();
  sendConfig();
  return result;
}

async function scanMonitorProfile(key) {
  const profile = config.monitorProfiles[key];
  if (!profile) {
    throw new Error('显示器不存在');
  }

  const selector = profile.instanceName || profile.hardwareId;
  const raw = await runHelper(['scan', '--monitor-id', selector], 10000);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) {
    throw new Error(parsed.error || '输入源扫描失败');
  }

  const inputs = normalizeInputSources(parsed.inputs);
  const observedValue = canonicalInputValue(parsed.currentHex, { inputs });
  const observedHex = observedValue === null
    ? normalizeInputHex(parsed.currentHex)
    : observedValue.toString(16).toUpperCase().padStart(4, '0');
  const inputSource = inputs.some((item) => item.hex === profile.inputSource)
    ? profile.inputSource
    : observedHex || inputs[0].hex;
  const alternateInput = inputs.some((item) => item.hex === profile.alternateInput)
    && profile.alternateInput !== inputSource
    ? profile.alternateInput
    : inputs.find((item) => item.hex !== inputSource)?.hex || inputSource;

  config.monitorProfiles[key] = normalizeProfile({
    ...profile,
    ddcOk: true,
    inputs,
    inputSource,
    alternateInput
  });
  config.monitors = config.monitors.map((monitor) => (
    profileKeyForMonitor(monitor) === key
      ? { ...monitor, ddcOk: true, inputScan: parsed }
      : monitor
  ));
  syncActiveMonitorToConfig();
  saveConfig();
  updateTrayMenu();
  sendConfig();
  return getPublicConfig();
}

async function discoverMacDisplay() {
  if (process.platform !== 'darwin' || config.macDisplaySelector) {
    return config.macDisplaySelector;
  }

  const output = await runHelper(['display', 'list', 'detailed']);
  const blocks = output.split(/\n(?=\[\d+\])/);
  const match = blocks.find((block) => /S2721DGF/i.test(block));
  if (match) {
    const uuid = match.match(/System UUID:\s*([^\n]+)/i);
    if (uuid) {
      config.macDisplaySelector = uuid[1].trim();
      saveConfig();
      return config.macDisplaySelector;
    }
  }
  return '';
}

function macDisplayArgs(command) {
  return config.macDisplaySelector
    ? ['display', config.macDisplaySelector, ...command]
    : command;
}

async function readCurrentInput() {
  if (process.platform === 'win32') {
    const { profile } = getActiveMonitorProfile();
    const selector = profile.instanceName || profile.hardwareId || config.windowsHardwareId;
    const raw = await runHelper(['read', '--monitor-id', selector]);
    const parsed = JSON.parse(raw);
    if (!parsed.ok) {
      throw new Error(parsed.error || 'DDC read failed');
    }
    return canonicalInputValue(parsed.current, profile);
  }

  await discoverMacDisplay();
  const raw = await runHelper(macDisplayArgs(['get', 'input']));
  return Number.parseInt(raw, 10);
}

async function setInput(source) {
  const value = inputValue(source);
  if (value === null) {
    throw new Error(`Unknown input source: ${source}`);
  }

  if (process.platform === 'win32') {
    const { profile } = getActiveMonitorProfile();
    const selector = profile.instanceName || profile.hardwareId || config.windowsHardwareId;
    await runHelper([
      'set',
      '--monitor-id',
      selector,
      '--value',
      value.toString(16).padStart(4, '0')
    ]);
    return;
  }

  await discoverMacDisplay();
  const lowCode = value & 0xff;
  const macValue = Object.values(LEGACY_INPUTS)
    .find((input) => (input.value & 0xff) === lowCode)?.mac;
  if (!macValue) {
    throw new Error(`Unsupported macOS input source: ${source}`);
  }
  await runHelper(macDisplayArgs(['set', 'input', String(macValue)]));
}

function targetValue() {
  const { profile } = getActiveMonitorProfile();
  return inputValue(profile.inputSource);
}

function setStatus(status, tone = 'neutral') {
  config.lastStatus = status;
  saveConfig();
  updateTrayMenu();
  if (window && !window.isDestroyed()) {
    window.webContents.send('status', { message: status, tone });
  }
}

function applyLoginItemSettings() {
  app.setLoginItemSettings({
    openAtLogin: config.launchAtLogin,
    openAsHidden: true,
    args: ['--hidden']
  });
}

function normalizeAccelerator(value) {
  const aliases = {
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
    meta: 'Super',
    win: 'Super',
    super: 'Super',
    cmd: 'Super',
    command: 'Super',
    pagedown: 'PageDown',
    pageup: 'PageUp',
    esc: 'Escape'
  };
  return String(value || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => aliases[part.toLowerCase()] || (part.length === 1 ? part.toUpperCase() : part))
    .join('+');
}

function checkHotkeyAccelerator(accelerator) {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) {
    return { ok: false, reason: '请设置快捷键' };
  }
  if (KNOWN_HOTKEY_CONFLICTS.has(normalized)) {
    return { ok: false, reason: '该组合是 Windows 或常见应用快捷键' };
  }
  if (registeredHotkey && normalizeAccelerator(registeredHotkey) === normalized) {
    return { ok: true, current: true };
  }

  let probeRegistered = false;
  try {
    probeRegistered = globalShortcut.register(normalized, () => {});
    if (!probeRegistered) {
      return { ok: false, reason: '该组合已被其他程序占用' };
    }
    return { ok: true, current: false };
  } catch (error) {
    return { ok: false, reason: `快捷键格式无效：${error.message}` };
  } finally {
    if (probeRegistered) {
      globalShortcut.unregister(normalized);
    }
  }
}

function registerSwitchHotkey() {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }
  hotkeyError = '';

  if (!config.hotkeyEnabled) {
    return true;
  }

  const accelerator = String(config.hotkeyAccelerator || '').trim();
  const conflict = checkHotkeyAccelerator(accelerator);
  if (!conflict.ok) {
    hotkeyError = conflict.reason;
    return false;
  }

  try {
    const registered = globalShortcut.register(accelerator, () => toggleManual());
    if (!registered) {
      hotkeyError = `快捷键 ${accelerator} 已被其他程序占用`;
      return false;
    }
    registeredHotkey = accelerator;
    return true;
  } catch (error) {
    hotkeyError = `快捷键格式无效：${error.message}`;
    return false;
  }
}

async function switchOnActivity(force = false) {
  if ((!config.enabled && !force) || switching) {
    return { ok: false, skipped: true };
  }

  const now = Date.now();
  if (now - lastSwitchAt < config.cooldownMs) {
    return { ok: false, skipped: true };
  }

  switching = true;
  try {
    const { profile } = getActiveMonitorProfile();
    const current = await readCurrentInput().catch(() => null);
    if (current === targetValue()) {
      return { ok: true, changed: false, current };
    }

    await setInput(profile.inputSource);
    lastSwitchAt = Date.now();
    setStatus(`已切换到 ${inputLabel(profile, profile.inputSource)}`, 'ok');
    return { ok: true, changed: true };
  } catch (error) {
    setStatus(`切换失败：${error.message}`, 'error');
    return { ok: false, changed: false, error: error.message };
  } finally {
    switching = false;
  }
}

function pollIdle() {
  if (!config.enabled) {
    return;
  }

  const idle = powerMonitor.getSystemIdleTime();
  if (idle > lastIdleSeconds) {
    idlePeakSeconds = Math.max(idlePeakSeconds, idle);
  }

  if (idle < lastIdleSeconds) {
    const idleBeforeActivityMs = idlePeakSeconds * 1000;
    if (idleBeforeActivityMs >= config.idleBeforeSwitchMs) {
      switchOnActivity();
    }
    idlePeakSeconds = idle;
  }
  lastIdleSeconds = idle;
}

function restartPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (config.enabled) {
    lastIdleSeconds = powerMonitor.getSystemIdleTime();
    idlePeakSeconds = lastIdleSeconds;
    timer = setInterval(pollIdle, config.pollMs);
  }
}

function trayImage() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.ico';
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file));
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  return image;
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const { profile } = getActiveMonitorProfile();
  const inputItems = profile.inputs.map((input) => ({
    label: input.label,
    type: 'radio',
    checked: profile.inputSource === input.hex,
    click: () => {
      profile.inputSource = input.hex;
      if (profile.alternateInput === input.hex) {
        profile.alternateInput = profile.inputs.find((item) => item.hex !== input.hex)?.hex
          || input.hex;
      }
      syncActiveMonitorToConfig();
      saveConfig();
      updateTrayMenu();
      sendConfig();
      setStatus(`本机输入已设为 ${input.label}`, 'ok');
    }
  }));

  const alternateInputItems = profile.inputs.map((input) => ({
    label: input.label,
    type: 'radio',
    checked: profile.alternateInput === input.hex,
    enabled: input.hex !== profile.inputSource,
    click: () => {
      profile.alternateInput = input.hex;
      syncActiveMonitorToConfig();
      saveConfig();
      updateTrayMenu();
      sendConfig();
      setStatus(`另一台电脑端口已设为 ${input.label}`, 'ok');
    }
  }));

  const monitorItems = (config.monitors || []).map((monitor) => {
    const key = profileKeyForMonitor(monitor);
    return {
      label: `${monitor.name || monitor.hardwareId}${monitor.serial ? ` · ${monitor.serial}` : ''}`,
      type: 'radio',
      checked: config.activeMonitorId === key,
      enabled: monitor.ddcOk !== false,
      click: () => {
        config.activeMonitorId = key;
        syncActiveMonitorToConfig();
        saveConfig();
        updateTrayMenu();
        sendConfig();
        setStatus(`目标显示器已设为 ${monitor.name || monitor.hardwareId}`, 'ok');
      }
    };
  });

  const hotkeyLabel = config.hotkeyEnabled && config.hotkeyAccelerator
    ? `一键切换本机 / 另一台电脑  (${config.hotkeyAccelerator})`
    : '一键切换本机 / 另一台电脑';

  const menu = Menu.buildFromTemplate([
    { label: 'SignalKVM', enabled: false },
    {
      label: config.enabled ? '自动切换已开启' : '自动切换已暂停',
      type: 'checkbox',
      checked: config.enabled,
      click: (item) => setEnabled(item.checked)
    },
    { type: 'separator' },
    {
      label: monitorItems.length > 0 ? '目标显示器' : `目标显示器：${profile.name}`,
      submenu: monitorItems.length > 0 ? monitorItems : undefined,
      enabled: monitorItems.length > 0
    },
    { label: '本机连接的显示器输入', submenu: inputItems },
    { label: '另一台电脑连接的显示器输入', submenu: alternateInputItems },
    {
      label: `切换灵敏度：${SENSITIVITY_PRESETS[config.sensitivity]?.label || '自定义'}`,
      enabled: false
    },
    {
      label: config.idleBeforeSwitchMs > 0
        ? `空闲 ${Math.round(config.idleBeforeSwitchMs / 1000)} 秒后允许自动切换`
        : '任意键鼠活动均可触发自动切换',
      enabled: false
    },
    { type: 'separator' },
    { label: config.lastStatus || '就绪', enabled: false },
    { label: '设置...', click: showWindow },
    { label: hotkeyLabel, click: () => toggleManual() },
    { type: 'separator' },
    { label: '退出 SignalKVM', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('SignalKVM');
  tray.setContextMenu(menu);
}

function setEnabled(enabled) {
  config.enabled = enabled;
  saveConfig();
  restartPolling();
  updateTrayMenu();
  sendConfig();
  setStatus(enabled ? '自动切换已开启' : '自动切换已暂停', enabled ? 'ok' : 'neutral');
}

async function toggleManual() {
  if (switching) {
    return { ok: false, skipped: true };
  }

  switching = true;
  try {
    const { profile } = getActiveMonitorProfile();
    const current = await readCurrentInput().catch(() => null);
    const destination = current === targetValue() ? profile.alternateInput : profile.inputSource;
    await setInput(destination);
    lastSwitchAt = Date.now();
    setStatus(`已切换到 ${inputLabel(profile, destination)}`, 'ok');
    return { ok: true, changed: true, destination, current };
  } catch (error) {
    setStatus(`切换失败：${error.message}`, 'error');
    return { ok: false, changed: false, error: error.message };
  } finally {
    switching = false;
  }
}

function sendConfig() {
  if (window && !window.isDestroyed()) {
    window.webContents.send('config', getPublicConfig());
  }
}

function getPublicConfig() {
  const { key, profile } = getActiveMonitorProfile();
  return {
    enabled: config.enabled,
    activeMonitorId: key,
    activeMonitor: profile,
    inputSources: profile.inputs,
    monitors: config.monitors || [],
    monitorProfiles: config.monitorProfiles,
    inputSource: profile.inputSource,
    alternateInput: profile.alternateInput,
    sensitivity: config.sensitivity,
    pollMs: config.pollMs,
    cooldownMs: config.cooldownMs,
    idleBeforeSwitchMs: config.idleBeforeSwitchMs,
    launchAtLogin: config.launchAtLogin,
    hotkeyEnabled: config.hotkeyEnabled,
    hotkeyAccelerator: config.hotkeyAccelerator,
    hotkeyRegistered: Boolean(registeredHotkey),
    hotkeyError,
    windowsHardwareId: profile.hardwareId || config.windowsHardwareId,
    macDisplaySelector: config.macDisplaySelector,
    lastStatus: config.lastStatus,
    platform: process.platform
  };
}

function showWindow() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }

  window = new BrowserWindow({
    width: 560,
    height: 780,
    minWidth: 500,
    minHeight: 620,
    show: false,
    title: 'SignalKVM',
    backgroundColor: '#f4f5f2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => {
    window.show();
    sendConfig();
  });
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
}

function registerIpc() {
  ipcMain.handle('config:get', () => getPublicConfig());
  ipcMain.handle('config:save', (_event, next) => {
    const sensitivity = SENSITIVITY_PRESETS[next.sensitivity] ? next.sensitivity : 'custom';
    const preset = SENSITIVITY_PRESETS[sensitivity];
    if (next.monitorProfiles && typeof next.monitorProfiles === 'object') {
      for (const [key, profile] of Object.entries(next.monitorProfiles)) {
        config.monitorProfiles[key] = normalizeProfile(profile, config.monitorProfiles[key]);
      }
    }

    if (next.activeMonitorId && config.monitorProfiles[next.activeMonitorId]) {
      config.activeMonitorId = next.activeMonitorId;
    }
    const { profile } = getActiveMonitorProfile();
    const inputSource = normalizeInputHex(next.inputSource) || profile.inputSource;
    let alternateInput = normalizeInputHex(next.alternateInput) || profile.alternateInput;
    if (alternateInput === inputSource) {
      alternateInput = profile.inputs.find((item) => item.hex !== inputSource)?.hex || inputSource;
    }
    profile.inputSource = inputSource;
    profile.alternateInput = alternateInput;
    profile.inputs = normalizeInputSources(profile.inputs, inputSource);

    config = {
      ...config,
      enabled: Boolean(next.enabled),
      sensitivity,
      pollMs: preset ? preset.pollMs : Math.min(2000, Math.max(250, Number(next.pollMs) || config.pollMs)),
      cooldownMs: preset ? preset.cooldownMs : Math.min(10000, Math.max(500, Number(next.cooldownMs) || config.cooldownMs)),
      idleBeforeSwitchMs: Math.min(
        600000,
        Math.max(0, Math.round((Number(next.idleBeforeSwitchMs) || 0) / 1000) * 1000)
      ),
      launchAtLogin: Boolean(next.launchAtLogin),
      hotkeyEnabled: Boolean(next.hotkeyEnabled),
      hotkeyAccelerator: normalizeAccelerator(next.hotkeyAccelerator) || config.hotkeyAccelerator,
      macDisplaySelector: String(next.macDisplaySelector || '').trim()
    };
    syncActiveMonitorToConfig();
    saveConfig();
    applyLoginItemSettings();
    const hotkeyReady = registerSwitchHotkey();
    restartPolling();
    updateTrayMenu();
    setStatus(
      hotkeyReady ? '设置已保存' : `设置已保存，但一键切换快捷键不可用：${hotkeyError}`,
      hotkeyReady ? 'ok' : 'error'
    );
    return getPublicConfig();
  });
  ipcMain.handle('monitors:refresh', async () => {
    try {
      const nextConfig = await refreshMonitorProfiles();
      return { ok: true, config: nextConfig };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('monitors:select', (_event, monitorId) => {
    if (!config.monitorProfiles[monitorId]) {
      return { ok: false, error: '显示器不存在' };
    }
    config.activeMonitorId = monitorId;
    syncActiveMonitorToConfig();
    saveConfig();
    updateTrayMenu();
    sendConfig();
    return { ok: true, config: getPublicConfig() };
  });
  ipcMain.handle('monitors:scan', async (_event, monitorId) => {
    try {
      const nextConfig = await scanMonitorProfile(monitorId);
      return { ok: true, config: nextConfig };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('ddc:read', async () => {
    try {
      return { ok: true, current: await readCurrentInput() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('ddc:set', async (_event, source) => {
    try {
      await setInput(source);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('ddc:toggle-now', async (_event, selection) => {
    if (selection?.monitorId && config.monitorProfiles[selection.monitorId]) {
      config.activeMonitorId = selection.monitorId;
    }
    const { profile } = getActiveMonitorProfile();
    const inputSource = normalizeInputHex(selection?.inputSource);
    if (inputSource) {
      profile.inputSource = inputSource;
    }
    const alternateInput = normalizeInputHex(selection?.alternateInput);
    if (alternateInput && alternateInput !== profile.inputSource) {
      profile.alternateInput = alternateInput;
    }
    if (profile.alternateInput === profile.inputSource) {
      profile.alternateInput = profile.inputs.find((item) => item.hex !== profile.inputSource)?.hex
        || profile.inputSource;
    }
    if (selection) {
      syncActiveMonitorToConfig();
      saveConfig();
      updateTrayMenu();
      sendConfig();
    }
    return toggleManual();
  });
  ipcMain.handle('hotkey:check', (_event, accelerator) => checkHotkeyAccelerator(accelerator));
  ipcMain.handle('app:open-data-folder', () => shell.openPath(app.getPath('userData')));
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.signalkvm.app');
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
  config = loadConfig();
  applyLoginItemSettings();
  if (process.platform === 'darwin') {
    try {
      fs.chmodSync(helperPath(), 0o755);
    } catch (error) {
      console.error('Failed to mark m1ddc executable:', error);
    }
  }
  registerIpc();
  const hotkeyReady = registerSwitchHotkey();
  tray = new Tray(trayImage());
  tray.on('double-click', showWindow);
  updateTrayMenu();
  restartPolling();
  setStatus(
    hotkeyReady ? '就绪' : `一键切换快捷键不可用：${hotkeyError}`,
    hotkeyReady ? 'ok' : 'error'
  );
  if (process.platform === 'win32') {
    refreshMonitorProfiles().catch((error) => {
      console.error('Monitor discovery failed:', error);
    });
  }

  const hidden = process.argv.includes('--hidden');
  if (!hidden) {
    showWindow();
  }
});

app.on('second-instance', () => {
  showWindow();
});

app.on('window-all-closed', () => {
  // Tray app: keep running until Quit is selected.
});

app.on('activate', () => {
  showWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
