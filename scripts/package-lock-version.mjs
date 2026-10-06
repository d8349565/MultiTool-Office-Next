import { readFileSync } from 'node:fs';

// 输出待保存内容；调用方完成全部版本文件校验后才写入。
const [file, version, name] = process.argv.slice(2);
const lock = JSON.parse(readFileSync(file, 'utf8'));
if (lock.name !== name || lock.packages?.['']?.name !== name) {
  throw new Error('前端锁文件缺少当前项目条目。');
}
lock.version = version;
lock.packages[''].version = version;
process.stdout.write(JSON.stringify(lock, null, 2) + '\n');
