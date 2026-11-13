const fields = {
  enabled: document.querySelector('#enabled'),
  statusMark: document.querySelector('#statusMark'),
  statusText: document.querySelector('#statusText'),
  monitorName: document.querySelector('#monitorName'),
  monitorSelect: document.querySelector('#monitorSelect'),
  monitorMeta: document.querySelector('#monitorMeta'),
  refreshMonitors: document.querySelector('#refreshMonitors'),
  scanMonitor: document.querySelector('#scanMonitor'),
  readMonitor: document.querySelector('#readMonitor'),
  readResult: document.querySelector('#readResult'),
  switchNow: document.querySelector('#switchNow'),
  inputSource: document.querySelector('#inputSource'),
  alternateInput: document.querySelector('#alternateInput'),
  sensitivity: document.querySelector('#sensitivity'),
  sensitivityHint: document.querySelector('#sensitivityHint'),
  pointerGateEnabled: document.querySelector('#pointerGateEnabled'),
  triggerDisplay: document.querySelector('#triggerDisplay'),
  pointerGateHint: document.querySelector('#pointerGateHint'),
  pointerDwellSec: document.querySelector('#pointerDwellSec'),
  windowGateEnabled: document.querySelector('#windowGateEnabled'),
  pollMs: document.querySelector('#pollMs'),
  cooldownMs: document.querySelector('#cooldownMs'),
  idleBeforeSwitchSec: document.querySelector('#idleBeforeSwitchSec'),
  launchAtLogin: document.querySelector('#launchAtLogin'),
  hotkeyEnabled: document.querySelector('#hotkeyEnabled'),
  hotkeyAccelerator: document.querySelector('#hotkeyAccelerator'),
  bindHotkey: document.querySelector('#bindHotkey'),
  hotkeyResult: document.querySelector('#hotkeyResult'),
  windowsHardwareId: document.querySelector('#windowsHardwareId'),
  macDisplaySelector: document.querySelector('#macDisplaySelector'),
  save: document.querySelector('#save'),
  openData: document.querySelector('#openData')
};

const SENSITIVITY_PRESETS = {
  high: {
    pollMs: 250,
    cooldownMs: 800,
    hint: '高灵敏度：250 毫秒检测一次，适合希望几乎立即切回的场景。'
  },
  normal: {
    pollMs: 500,
    cooldownMs: 1800,
    hint: '标准灵敏度：响应和稳定性平衡，推荐日常使用。'
  },
  stable: {
    pollMs: 1000,
    cooldownMs: 3500,
    hint: '稳健模式：检测更保守，降低误切换和来回切换。'
  }
};

let currentConfig = null;
let recordingHotkey = false;
let hotkeyConflict = false;

function setStatus(message, tone = 'neutral') {
  fields.statusText.textContent = message;
  fields.statusMark.className = `status-mark ${tone}`;
}

function keyNameFromEvent(event) {
  const aliases = {
    ' ': 'Space',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    Escape: 'Escape'
  };
  if (aliases[event.key]) {
    return aliases[event.key];
  }
  if (/^F\d{1,2}$/.test(event.key)) {
    return event.key.toUpperCase();
  }
  if (event.key.length === 1) {
    return event.key.toUpperCase();
  }
  return event.key;
}

function acceleratorFromEvent(event) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
    return '';
  }
  const parts = [];
  if (event.ctrlKey) {
    parts.push('Control');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  if (event.metaKey) {
    parts.push('Super');
  }
  const key = keyNameFromEvent(event);
  if (!key) {
    return '';
  }
  return [...parts, key].join('+');
}

function renderHotkeyState(config, message = '', tone = 'neutral') {
  if (recordingHotkey) {
    fields.hotkeyResult.textContent = '请按下新的快捷键组合，按 Esc 取消。';
    fields.hotkeyResult.className = 'hint hotkey-warning';
    return;
  }
  if (message) {
    fields.hotkeyResult.textContent = message;
    fields.hotkeyResult.className = `hint ${tone === 'error' ? 'hotkey-error' : 'hotkey-ok'}`;
    return;
  }
  fields.hotkeyResult.className = 'hint';
  if (!config.hotkeyEnabled) {
    fields.hotkeyResult.textContent = '全局快捷键已关闭。';
    return;
  }
  if (config.hotkeyRegistered) {
    fields.hotkeyResult.textContent = `快捷键已生效：${config.hotkeyAccelerator}`;
    return;
  }
  fields.hotkeyResult.textContent = config.hotkeyError
    ? `快捷键不可用：${config.hotkeyError}`
    : '快捷键会在保存后立即生效。';
}

function activeProfile(config = currentConfig) {
  return config?.monitorProfiles?.[config.activeMonitorId]
    || config?.activeMonitor
    || null;
}

function sourceHex(value) {
  const legacy = { DP: '0F0F', HDMI1: '1111', HDMI2: '1212' };
  if (legacy[value]) {
    return legacy[value];
  }
  if (typeof value === 'number') {
    return value.toString(16).toUpperCase().padStart(4, '0');
  }
  const normalized = String(value || '').replace(/^0x/i, '').trim();
  return /^[0-9a-f]{1,4}$/i.test(normalized)
    ? normalized.toUpperCase().padStart(4, '0')
    : '';
}

function renderInputGroup(container, inputs, selected, disabledSource = '') {
  container.replaceChildren();
  for (const input of inputs || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = input.hex;
    button.textContent = input.label;
    button.title = `${input.label} (0x${input.hex})`;
    button.classList.toggle('active', input.hex === selected);
    button.disabled = input.hex === disabledSource;
    container.appendChild(button);
  }
}

function monitorOptionLabel(monitor) {
  const identity = monitor.serial || monitor.hardwareId;
  return `${monitor.name || monitor.hardwareId || '未知显示器'} · ${identity}`;
}

function displayOptionLabel(display) {
  const bounds = display.bounds || {};
  return `从左到右第 ${display.leftToRightIndex} 块 · ${display.label} · ${bounds.width}×${bounds.height}`;
}

function renderPointerGateSettings(config) {
  const enabled = Boolean(config.pointerGateEnabled);
  const displays = Array.isArray(config.displays) ? config.displays : [];
  const selectedLabel = String(config.triggerDisplayLabel || '').toLowerCase();
  const selectedId = String(config.triggerDisplayId || '');
  const selected = displays.find((display) => display.id === selectedId)
    || displays.find((display) => selectedLabel && display.label.toLowerCase() === selectedLabel)
    || null;

  fields.pointerGateEnabled.checked = enabled;
  fields.pointerDwellSec.value = Math.max(0.3, (config.pointerDwellMs || 800) / 1000).toFixed(1);
  fields.pointerDwellSec.disabled = !enabled;
  fields.windowGateEnabled.checked = config.windowGateEnabled !== false;
  fields.windowGateEnabled.disabled = !enabled;
  fields.idleBeforeSwitchSec.disabled = enabled;
  fields.triggerDisplay.disabled = !enabled || displays.length === 0;
  fields.triggerDisplay.replaceChildren();

  if (displays.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未检测到桌面显示器';
    fields.triggerDisplay.appendChild(option);
  } else {
    for (const display of displays) {
      const option = document.createElement('option');
      option.value = display.id;
      option.textContent = displayOptionLabel(display);
      option.selected = selected?.id === display.id;
      fields.triggerDisplay.appendChild(option);
    }
  }

  fields.triggerDisplay.disabled = !enabled || displays.length === 0;
  if (!enabled) {
    fields.pointerGateHint.textContent = '开启后，只有光标在指定显示器内活动，或窗口进入该显示器时才自动切回。';
    return;
  }
  if (!selected) {
    fields.pointerGateHint.textContent = '请选择承载键鼠意图的显示器；未选择时不会自动切换。';
    return;
  }
  fields.pointerGateHint.textContent = `光标在 ${selected.label} 内移动会累计时间；离开后普通键鼠活动不会触发自动切换。`;
}

function renderConfig(config) {
  currentConfig = config;
  const profile = activeProfile(config);
  recordingHotkey = false;
  fields.bindHotkey.textContent = '重新绑定';
  fields.enabled.checked = config.enabled;
  fields.pollMs.value = config.pollMs;
  fields.cooldownMs.value = config.cooldownMs;
  fields.idleBeforeSwitchSec.value = Math.round((config.idleBeforeSwitchMs || 0) / 1000);
  renderPointerGateSettings(config);
  fields.launchAtLogin.checked = config.launchAtLogin;
  fields.hotkeyEnabled.checked = config.hotkeyEnabled;
  fields.hotkeyAccelerator.value = config.hotkeyAccelerator || '';
  hotkeyConflict = Boolean(config.hotkeyEnabled && !config.hotkeyRegistered && config.hotkeyError);
  renderHotkeyState(config);
  fields.save.disabled = hotkeyConflict;
  fields.windowsHardwareId.value = profile?.hardwareId || config.windowsHardwareId || '';
  fields.macDisplaySelector.value = config.macDisplaySelector || '';

  fields.monitorName.textContent = profile?.name || '未发现显示器';
  fields.monitorMeta.textContent = profile
    ? [
      profile.manufacturer || '未知厂商',
      profile.connection || '未知连接',
      `Hardware ID ${profile.hardwareId || '未知'}`,
      profile.serial ? `SN ${profile.serial}` : ''
    ].filter(Boolean).join(' · ')
    : '尚未扫描到支持 DDC/CI 的显示器。';

  fields.monitorSelect.replaceChildren();
  const monitorOptions = Array.isArray(config.monitors) && config.monitors.length > 0
    ? config.monitors
    : profile
      ? [profile]
      : [];
  for (const monitor of monitorOptions) {
    const option = document.createElement('option');
    const hardwareId = String(monitor.hardwareId || 'MONITOR').toUpperCase();
    const identity = String(
      monitor.serial || monitor.instanceName || monitor.id || monitor.name || 'UNKNOWN'
    ).toUpperCase();
    const key = `${hardwareId}:${identity}`;
    option.value = key;
    option.textContent = monitorOptionLabel(monitor);
    option.selected = key === config.activeMonitorId;
    option.disabled = monitor.ddcOk === false;
    fields.monitorSelect.appendChild(option);
  }

  const inputOptions = profile?.inputs || config.inputSources || [];
  renderInputGroup(fields.inputSource, inputOptions, profile?.inputSource || config.inputSource);
  renderInputGroup(
    fields.alternateInput,
    inputOptions,
    profile?.alternateInput || config.alternateInput,
    profile?.inputSource || config.inputSource
  );

  document.querySelectorAll('#sensitivity button').forEach((button) => {
    button.classList.toggle('active', button.dataset.value === config.sensitivity);
  });
  fields.sensitivityHint.textContent = SENSITIVITY_PRESETS[config.sensitivity]?.hint
    || '自定义时序：检测间隔和切换冷却按高级设置执行。';

  document.querySelectorAll('.mac-only').forEach((element) => {
    element.hidden = config.platform !== 'darwin';
  });
}

function readForm() {
  const profile = activeProfile();
  const selectedDisplay = currentConfig.displays?.find(
    (display) => display.id === fields.triggerDisplay.value
  );
  return {
    enabled: fields.enabled.checked,
    activeMonitorId: currentConfig.activeMonitorId,
    monitorProfiles: currentConfig.monitorProfiles,
    inputSource: profile?.inputSource || currentConfig.inputSource,
    alternateInput: profile?.alternateInput || currentConfig.alternateInput,
    sensitivity: currentConfig.sensitivity,
    pollMs: Number(fields.pollMs.value),
    cooldownMs: Number(fields.cooldownMs.value),
    idleBeforeSwitchMs: Math.max(0, Number(fields.idleBeforeSwitchSec.value) || 0) * 1000,
    pointerGateEnabled: fields.pointerGateEnabled.checked,
    pointerDwellMs: Math.max(0.3, Number(fields.pointerDwellSec.value) || 0.8) * 1000,
    windowGateEnabled: fields.windowGateEnabled.checked,
    triggerDisplayId: fields.triggerDisplay.value,
    triggerDisplayLabel: selectedDisplay?.label || '',
    triggerDisplayBounds: selectedDisplay?.bounds || null,
    launchAtLogin: fields.launchAtLogin.checked,
    hotkeyEnabled: fields.hotkeyEnabled.checked,
    hotkeyAccelerator: fields.hotkeyAccelerator.value,
    windowsHardwareId: profile?.hardwareId || fields.windowsHardwareId.value,
    macDisplaySelector: fields.macDisplaySelector.value
  };
}

function formatInput(value, config = currentConfig) {
  const numeric = Number(value);
  const high = (numeric >> 8) & 0xff;
  const low = numeric & 0xff;
  const code = numeric <= 0xff || high === low || high === 0x0f ? low : numeric & 0xffff;
  const source = activeProfile(config)?.inputs?.find((input) => {
    const inputHigh = (input.value >> 8) & 0xff;
    const inputLow = input.value & 0xff;
    const inputCode = input.value <= 0xff || inputHigh === inputLow || inputHigh === 0x0f
      ? inputLow
      : input.value & 0xffff;
    return inputCode === code;
  });
  const hex = `0x${Number(value).toString(16).toUpperCase().padStart(4, '0')}`;
  return `${source?.label || '未知输入'} (${hex})`;
}

fields.inputSource.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button || !currentConfig) {
    return;
  }
  const profile = activeProfile();
  profile.inputSource = button.dataset.value;
  currentConfig.inputSource = profile.inputSource;
  if (profile.alternateInput === profile.inputSource) {
    const fallback = profile.inputs
      .find((item) => item.hex !== profile.inputSource);
    if (fallback) {
      profile.alternateInput = fallback.hex;
    }
  }
  currentConfig.alternateInput = profile.alternateInput;
  document.querySelectorAll('#inputSource button').forEach((item) => {
    item.classList.toggle('active', item === button);
  });
  document.querySelectorAll('#alternateInput button').forEach((item) => {
    item.classList.toggle('active', item.dataset.value === profile.alternateInput);
    item.disabled = item.dataset.value === profile.inputSource;
  });
});

fields.alternateInput.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button || !currentConfig) {
    return;
  }
  const profile = activeProfile();
  if (button.dataset.value === profile.inputSource) {
    setStatus('另一台电脑端口不能与本机端口相同', 'error');
    return;
  }
  profile.alternateInput = button.dataset.value;
  currentConfig.alternateInput = profile.alternateInput;
  document.querySelectorAll('#alternateInput button').forEach((item) => {
    item.classList.toggle('active', item === button);
  });
});

fields.sensitivity.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button || !currentConfig) {
    return;
  }
  const preset = SENSITIVITY_PRESETS[button.dataset.value];
  if (!preset) {
    return;
  }
  currentConfig.sensitivity = button.dataset.value;
  fields.pollMs.value = preset.pollMs;
  fields.cooldownMs.value = preset.cooldownMs;
  fields.sensitivityHint.textContent = preset.hint;
  document.querySelectorAll('#sensitivity button').forEach((item) => {
    item.classList.toggle('active', item === button);
  });
});

function markCustomSensitivity() {
  if (!currentConfig) {
    return;
  }
  currentConfig.sensitivity = 'custom';
  fields.sensitivityHint.textContent = '自定义时序：检测间隔和切换冷却按高级设置执行。';
  document.querySelectorAll('#sensitivity button').forEach((item) => {
    item.classList.remove('active');
  });
}

fields.pollMs.addEventListener('input', markCustomSensitivity);
fields.cooldownMs.addEventListener('input', markCustomSensitivity);

async function runMonitorAction(action, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '扫描中...';
  try {
    const result = await action();
    if (!result.ok) {
      setStatus(`显示器扫描失败：${result.error}`, 'error');
      return;
    }
    renderConfig(result.config);
    setStatus('显示器与输入源已更新', 'ok');
  } catch (error) {
    setStatus(`显示器扫描失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

fields.refreshMonitors.addEventListener('click', () => {
  runMonitorAction(() => window.signalKvm.refreshMonitors(), fields.refreshMonitors);
});

fields.scanMonitor.addEventListener('click', () => {
  const monitorId = currentConfig?.activeMonitorId;
  if (!monitorId) {
    setStatus('请先选择显示器', 'error');
    return;
  }
  runMonitorAction(() => window.signalKvm.scanMonitor(monitorId), fields.scanMonitor);
});

fields.monitorSelect.addEventListener('change', async () => {
  const monitorId = fields.monitorSelect.value;
  if (!monitorId) {
    return;
  }
  fields.monitorSelect.disabled = true;
  try {
    const result = await window.signalKvm.selectMonitor(monitorId);
    if (!result.ok) {
      setStatus(`切换显示器失败：${result.error}`, 'error');
      return;
    }
    renderConfig(result.config);
  } catch (error) {
    setStatus(`切换显示器失败：${error.message}`, 'error');
  } finally {
    fields.monitorSelect.disabled = false;
  }
});

fields.enabled.addEventListener('change', () => {
  if (currentConfig) {
    currentConfig.enabled = fields.enabled.checked;
  }
});

fields.pointerGateEnabled.addEventListener('change', () => {
  if (!currentConfig) {
    return;
  }
  currentConfig.pointerGateEnabled = fields.pointerGateEnabled.checked;
  renderPointerGateSettings(currentConfig);
});

fields.bindHotkey.addEventListener('click', () => {
  recordingHotkey = true;
  fields.bindHotkey.textContent = '请按键...';
  fields.hotkeyAccelerator.value = '';
  renderHotkeyState(currentConfig);
});

fields.hotkeyEnabled.addEventListener('change', () => {
  if (!currentConfig) {
    return;
  }
  currentConfig.hotkeyEnabled = fields.hotkeyEnabled.checked;
  hotkeyConflict = false;
  fields.save.disabled = false;
  renderHotkeyState(currentConfig);
});

window.addEventListener('keydown', async (event) => {
  if (!recordingHotkey || event.repeat) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    recordingHotkey = false;
    fields.bindHotkey.textContent = '重新绑定';
    fields.hotkeyAccelerator.value = currentConfig.hotkeyAccelerator || '';
    renderHotkeyState(currentConfig);
    return;
  }

  const accelerator = acceleratorFromEvent(event);
  if (!accelerator) {
    return;
  }
  if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    fields.hotkeyResult.textContent = '快捷键至少需要包含 Ctrl、Alt、Shift 或 Win。';
    fields.hotkeyResult.className = 'hint hotkey-error';
    return;
  }

  recordingHotkey = false;
  fields.bindHotkey.textContent = '重新绑定';
  fields.hotkeyAccelerator.value = accelerator;
  fields.hotkeyResult.textContent = '正在检测快捷键冲突...';
  fields.hotkeyResult.className = 'hint';
  currentConfig.hotkeyAccelerator = accelerator;

  try {
    const result = await window.signalKvm.checkHotkey(accelerator);
    if (result.ok) {
      hotkeyConflict = false;
      fields.save.disabled = false;
      renderHotkeyState(currentConfig, `快捷键可用：${accelerator}，保存后生效`, 'ok');
      return;
    }
    hotkeyConflict = true;
    fields.save.disabled = true;
    renderHotkeyState(currentConfig, `快捷键冲突：${result.reason}`, 'error');
  } catch (error) {
    hotkeyConflict = true;
    fields.save.disabled = true;
    renderHotkeyState(currentConfig, `冲突检测失败：${error.message}`, 'error');
  }
});

fields.switchNow.addEventListener('click', async () => {
  fields.switchNow.disabled = true;
  fields.switchNow.textContent = '正在切换...';
  setStatus('正在切换显示器输入...', 'neutral');
  try {
    const profile = activeProfile();
    const result = await window.signalKvm.toggleNow({
      monitorId: currentConfig.activeMonitorId,
      inputSource: profile?.inputSource || currentConfig.inputSource,
      alternateInput: profile?.alternateInput || currentConfig.alternateInput
    });
    if (!result.ok && result.error) {
      setStatus(`切换失败：${result.error}`, 'error');
    } else if (result.changed === false) {
      fields.readResult.textContent = '显示器已经在本机输入，无需切换。';
      setStatus('显示器已经在本机输入', 'ok');
    }
  } catch (error) {
    setStatus(`切换失败：${error.message}`, 'error');
  } finally {
    fields.switchNow.disabled = false;
    fields.switchNow.textContent = '一键切换本机 / 另一台电脑';
  }
});

fields.readMonitor.addEventListener('click', async () => {
  fields.readResult.textContent = '正在读取显示器...';
  const result = await window.signalKvm.readMonitor();
  if (result.ok) {
    fields.readResult.textContent = `当前输入：${formatInput(result.current)}`;
  } else {
    fields.readResult.textContent = `读取失败：${result.error}`;
  }
});

fields.save.addEventListener('click', async () => {
  fields.save.disabled = true;
  try {
    const saved = await window.signalKvm.saveConfig(readForm());
    renderConfig(saved);
  } catch (error) {
    setStatus(`保存失败：${error.message}`, 'error');
  } finally {
    fields.save.disabled = hotkeyConflict;
  }
});

fields.openData.addEventListener('click', () => {
  window.signalKvm.openDataFolder();
});

window.signalKvm.onConfig((config) => renderConfig(config));
window.signalKvm.onStatus(({ message, tone }) => setStatus(message, tone));

window.signalKvm.getConfig().then(async (config) => {
  renderConfig(config);
  setStatus(config.lastStatus || '就绪', 'neutral');
  if (config.platform === 'win32' && (!config.monitors || config.monitors.length === 0)) {
    const result = await window.signalKvm.refreshMonitors();
    if (result.ok) {
      renderConfig(result.config);
    }
  }
});
