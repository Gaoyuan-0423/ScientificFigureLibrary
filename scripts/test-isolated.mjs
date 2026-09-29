#!/usr/bin/env node
// Each Node test worker gets its own user/config roots. Windows APPDATA matters
// independently of XDG_CONFIG_HOME; otherwise tests can read real proxy/overlay state.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const parent = await fs.realpath(os.tmpdir());
const root = await fs.mkdtemp(path.join(parent, 'sfl-test-user-state-'));
const preload = `
import fs from 'node:fs'; import path from 'node:path';
const home = path.join(process.env.SFL_TEST_USER_STATE_ROOT, 'worker-' + process.pid);
fs.mkdirSync(home, { recursive: true });
for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME']) process.env[key] = home;
for (const key of ['FIGURE_LIBRARY_DIR','FIGURE_WORKSPACE_DIR']) delete process.env[key];
`;
try {
  const files = (await fs.readdir('tests')).filter(f => f.endsWith('.test.ts')).map(f => path.join('tests', f));
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    '--test', ...process.argv.slice(2), ...files], {
    env: { ...process.env, SFL_TEST_USER_STATE_ROOT: root }, stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  // Only the exact scratch directory created above is eligible for cleanup.
  if (path.dirname(await fs.realpath(root)) !== parent) throw new Error('test cleanup escaped scratch parent');
  await fs.rm(root, { recursive: true, force: true });
}
