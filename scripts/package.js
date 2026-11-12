const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');

const platform = process.argv[2];
const arch = process.argv[3];

if (!platform || !arch) {
  console.error('Usage: node scripts/package.js <platform> <arch>');
  process.exit(1);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const winHelper = path.join(root, 'native', 'windows', 'bin', 'ddc-helper.exe');
  const macHelper = path.join(root, 'third_party', 'm1ddc', 'm1ddc');

  if (!fs.existsSync(winHelper)) {
    throw new Error(`Missing Windows helper: ${winHelper}`);
  }
  if (!fs.existsSync(macHelper)) {
    throw new Error(`Missing macOS helper: ${macHelper}`);
  }

  const buildTemp = path.join(root, '.packager-tmp', `${platform}-${Date.now()}`);
  const buildOut = path.join(buildTemp, 'output');
  fs.mkdirSync(buildTemp, { recursive: true });

  const configuredElectronZipDir = process.env.SIGNKVM_ELECTRON_ZIP_DIR;
  const electronZipDir = configuredElectronZipDir
    ? path.resolve(root, configuredElectronZipDir)
    : path.join(root, '.electron-zips');
  if (configuredElectronZipDir && !fs.existsSync(electronZipDir)) {
    throw new Error(`Configured Electron ZIP directory does not exist: ${electronZipDir}`);
  }

  let paths;
  try {
    paths = await packager({
      dir: root,
      name: 'SignalKVM',
      platform,
      arch,
      out: buildOut,
      overwrite: true,
      asar: true,
      prune: true,
      appBundleId: 'com.signalkvm.app',
      helperBundleId: 'com.signalkvm.helper',
      appCategoryType: 'public.app-category.productivity',
      extendInfo: platform === 'darwin' ? { LSUIElement: true } : undefined,
      icon: platform === 'win32' ? path.join(root, 'assets', 'tray.ico') : undefined,
      tmpdir: buildTemp,
      ...(fs.existsSync(electronZipDir) ? { electronZipDir } : {}),
      extraResource: platform === 'win32' ? [winHelper] : [macHelper],
      ignore: [
        /^\/dist($|\/)/,
        /^\/node_modules($|\/)/,
        /^\/\.electron-zips($|\/)/,
        /^\/\.packager-tmp($|\/)/,
        /^\/work($|\/)/,
        /^\/outputs($|\/)/,
        /^\/native\/windows\/DdcHelper\.cs$/,
        /^\/\.git($|\/)/
      ]
    });
  } catch (error) {
    const stagingRoot = path.join(buildTemp, 'electron-packager');
    const recovered = platform === 'win32' && error.code === 'EPERM' && fs.existsSync(stagingRoot)
      ? fs.readdirSync(stagingRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(stagingRoot, entry.name))
        .find((candidate) => fs.existsSync(path.join(candidate, 'SignalKVM.exe')))
      : null;
    if (!recovered) {
      throw error;
    }
    console.warn(`Recovered Windows package after directory rename failed: ${recovered}`);
    paths = [recovered];
  }

  if (platform === 'win32') {
    const finalDir = path.join(root, 'dist', 'SignalKVM-win32-x64');
    const distRoot = path.resolve(root, 'dist') + path.sep;
    const resolvedFinal = path.resolve(finalDir) + path.sep;
    if (!resolvedFinal.startsWith(distRoot)) {
      throw new Error(`Refusing to replace output outside dist: ${resolvedFinal}`);
    }
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.cpSync(paths[0], finalDir, { recursive: true });
    paths[0] = finalDir;
  }

  if (platform === 'darwin') {
    const appBundle = path.join(paths[0], 'SignalKVM.app');
    const plistPath = path.join(appBundle, 'Contents', 'Info.plist');
    execFileSync('python', [
      '-c',
      [
        'import plistlib, sys',
        'path = sys.argv[1]',
        'with open(path, "rb") as handle:',
        '    data = plistlib.load(handle)',
        'data.pop("ElectronAsarIntegrity", None)',
        'with open(path, "wb") as handle:',
        '    plistlib.dump(data, handle, fmt=plistlib.FMT_XML)'
      ].join('\n'),
      plistPath
    ], { stdio: 'inherit' });

    const rcodesign = process.env.SIGNKVM_RCODESIGN_PATH;
    if (rcodesign) {
      execFileSync(rcodesign, ['sign', '--timestamp-url', 'none', appBundle], { stdio: 'inherit' });
    } else if (process.platform === 'darwin') {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
    } else {
      console.warn('macOS app was not re-signed. Set SIGNKVM_RCODESIGN_PATH to ad-hoc sign it on Windows.');
    }

    execFileSync('python', [
      path.join(root, 'scripts', 'zip-macos.py'),
      appBundle,
      path.join(root, 'dist', 'SignalKVM-mac-arm64.zip')
    ], { stdio: 'inherit' });

    execFileSync('python', [
      path.join(root, 'scripts', 'verify-macos-zip.py'),
      appBundle,
      path.join(root, 'dist', 'SignalKVM-mac-arm64.zip')
    ], { stdio: 'inherit' });
  }

  console.log(paths.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
