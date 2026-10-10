// 把控制台入口页拷进 dist。
//
// server.ts 在运行时按自身路径解析 console/index.html，而 tsc 不会拷贝 .html。
// 少了这一步，`npm run build && npm start` 会因为读不到文件直接 404。
// 所以 package.json 的 build 脚本末尾显式调了这个文件。
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'src/console/index.html');
const toDir = resolve(root, 'dist/console');
const to = resolve(toDir, 'index.html');

mkdirSync(toDir, { recursive: true });
copyFileSync(from, to);

// 会议页是独立入口（/meeting），同样要拷过去
copyFileSync(resolve(root, 'src/console/meeting.html'), resolve(toDir, 'meeting.html'));

console.log(`控制台入口页 → ${to}`);