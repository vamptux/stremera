import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(import.meta.dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCargoVersion() {
  const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  const match = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);

  if (!match) {
    fail('Unable to locate the package version in src-tauri/Cargo.toml.');
  }

  return match[1];
}

function writeCargoVersion(nextVersion) {
  const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  const nextCargoToml = cargoToml.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(".*)$/m,
    `$1${nextVersion}$3`,
  );

  if (nextCargoToml === cargoToml) {
    fail('Unable to update the package version in src-tauri/Cargo.toml.');
  }

  fs.writeFileSync(cargoTomlPath, nextCargoToml);
}

function readVersions() {
  const packageJson = readJson(packageJsonPath);
  const tauriConfig = readJson(tauriConfigPath);

  return {
    cargo: readCargoVersion(),
    packageJson: packageJson.version,
    tauriConfig: tauriConfig.version,
  };
}

function validateVersion(nextVersion) {
  if (!versionPattern.test(nextVersion)) {
    fail(
      `Invalid version \"${nextVersion}\". Use semantic versions like 0.4.0, 0.4.0-beta.1, or 1.0.0-rc.1.`,
    );
  }
}

function checkVersions(tagName) {
  const versions = readVersions();
  const uniqueVersions = [...new Set(Object.values(versions))];

  if (uniqueVersions.length !== 1) {
    fail(
      `Version mismatch detected. package.json=${versions.packageJson}, Cargo.toml=${versions.cargo}, tauri.conf.json=${versions.tauriConfig}`,
    );
  }

  const version = uniqueVersions[0];
  validateVersion(version);

  if (tagName) {
    const normalizedTagName = tagName.startsWith('refs/tags/')
      ? tagName.slice('refs/tags/'.length)
      : tagName;

    if (normalizedTagName !== `v${version}`) {
      fail(`Tag ${normalizedTagName} does not match version v${version}.`);
    }
  }

  console.log(`Release version verified: ${version}`);
}

function setVersion(nextVersion) {
  validateVersion(nextVersion);

  const packageJson = readJson(packageJsonPath);
  packageJson.version = nextVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const tauriConfig = readJson(tauriConfigPath);
  tauriConfig.version = nextVersion;
  fs.writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

  writeCargoVersion(nextVersion);

  console.log(`Release version set to ${nextVersion}`);
}

const [mode, value] = process.argv.slice(2);

if (mode === 'check') {
  checkVersions(value);
} else if (mode === 'set') {
  if (!value) {
    fail('Provide a version to set, for example: bun run release:version:set -- 0.4.0-beta.1');
  }

  setVersion(value);
} else {
  fail('Usage: bun ./scripts/release-version.mjs <check|set> [value]');
}