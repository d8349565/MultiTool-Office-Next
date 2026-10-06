import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
try {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const cli = JSON.parse(read('node_modules/@tauri-apps/cli/package.json'));
  const template = read(`src-tauri/${config.bundle.windows.nsis.template}`);
  const supportedCli = template.match(/^; Tauri CLI: ([\d.]+)$/m)?.[1];
  if (supportedCli !== cli.version) throw new Error(`安装模板适配 ${supportedCli}，当前命令工具为 ${cli.version}；升级工具后请先对照官方模板评审并更新适配版本。`);
  if (!read(resolve(root, 'src-tauri', config.bundle.licenseFile)).trim()) throw new Error('安装须知为空。');
  if (config.bundle.windows.allowDowngrades !== false) throw new Error('安装配置必须禁止降级，避免旧程序破坏新版数据。');
  if (config.bundle.windows.nsis.installMode !== 'currentUser') throw new Error('安装范围应为当前用户。');
  if (!template.trimEnd().endsWith('FunctionEnd') || template.includes('\uFFFD')) throw new Error('安装模板包含损坏或尾部杂质。');
  console.log(`安装配置检查通过，模板适配版本：${supportedCli}`);
} catch (error) {
  console.error(`安装配置检查失败：${error.message}`);
  process.exitCode = 1;
}
