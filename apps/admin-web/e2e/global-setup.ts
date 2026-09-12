import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Starts apps/worker for the duration of the browser suite.
 *
 * It is not a `webServer` entry because it listens on no port, so Playwright has
 * nothing to poll; readiness is taken from its own log line instead.
 */
let worker: ChildProcess | undefined;

export default async function globalSetup(): Promise<() => Promise<void>> {
  const cwd = resolve(process.cwd(), '../worker');
  worker = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks: string[] = [];
  worker.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  worker.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (chunks.join('').includes('Consuming the curriculum import queue')) {
      return async () => {
        await new Promise<void>((done) => {
          if (!worker || worker.exitCode !== null) return done();
          worker.once('exit', () => done());
          worker.kill('SIGTERM');
        });
      };
    }
    if (worker.exitCode !== null) {
      throw new Error(`worker exited early (${worker.exitCode}):\n${chunks.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  worker.kill('SIGKILL');
  throw new Error(`worker did not start:\n${chunks.join('')}`);
}
