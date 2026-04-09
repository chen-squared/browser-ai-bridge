import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
  const rawPort = process.argv[2];
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0) {
    console.error('Usage: node scripts/kill-port.mjs <port>');
    process.exit(1);
  }

  const { stdout } = await execFileAsync('lsof', ['-ti', `tcp:${port}`]);
  const pids = stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  if (pids.length === 0) {
    console.log(`No process is listening on port ${port}.`);
    return;
  }

  for (const pid of pids) {
    process.kill(Number(pid), 'SIGTERM');
    console.log(`Sent SIGTERM to PID ${pid} on port ${port}.`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});