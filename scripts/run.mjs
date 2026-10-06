// Runs a Riftjack entry point for an instance directory: the one holding .env, data/ and
// .connector-history/. npm runs scripts inside the package, so the instance is taken from
// RIFTJACK_HOME or the directory npm was started in: `npm --prefix riftjack start`.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [entry, ...rest] = process.argv.slice(2);
if (entry !== 'supervisor' && entry !== 'main') throw new Error('Usage: node scripts/run.mjs supervisor|main [arguments]');
const home = realpathSync(process.env.RIFTJACK_HOME || process.env.INIT_CWD || process.cwd());
const code = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
if (home === code || !existsSync(join(home, '.env'))) {
  console.error(`No .env in ${home}. Run from the instance directory (npm --prefix riftjack …) or set RIFTJACK_HOME.`);
  process.exit(78);
}
// The supervisor never reads .env itself: each connector it starts loads the current file.
const args = [...(entry === 'main' ? ['--env-file-if-exists=.env'] : []), '--import', fileURLToPath(import.meta.resolve('tsx')),
  fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url)), ...rest];
const child = entry === 'supervisor'
  ? spawn('sh', [join(code, 'scripts/start-connector.sh'), '--foreground'],
    { cwd: home, stdio: 'inherit', env: { ...process.env, RIFTJACK_HOME: home } })
  : spawn(process.execPath, args, { cwd: home, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
