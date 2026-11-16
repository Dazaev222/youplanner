import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test','tests/*.test.mjs'], { encoding:'utf8',maxBuffer:32*1024*1024,cwd:process.cwd() });
const lines = (result.stdout || '').split('\n');
let reporting = false;
for (const line of lines) {
  if (line.startsWith('not ok ')) reporting = true;
  if (reporting || /^# (tests|pass|fail|duration_ms)/.test(line)) console.log(line);
  if (reporting && line.trim() === '...') reporting = false;
}
if(result.stderr) console.error(result.stderr);
process.exit(result.status ?? 1);
