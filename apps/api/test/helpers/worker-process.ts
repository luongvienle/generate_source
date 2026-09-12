import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Runs apps/worker as a real child process.
 *
 * §11 makes api and worker separate deployables and neither may import the
 * other, so an end-to-end import test drives the worker the way production
 * does: as its own process, bound only by the queue name and Redis.
 */
export interface RunningWorker {
  readonly process: ChildProcess;
  readonly output: () => string;
  stop(): Promise<void>;
}

export async function startWorker(env: NodeJS.ProcessEnv): Promise<RunningWorker> {
  const cwd = resolve(process.cwd(), '../worker');
  const child = spawn('node', ['--import', 'tsx', 'src/main.ts'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const output = () => chunks.join('');

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (output().includes('Consuming the curriculum import queue')) {
      return {
        process: child,
        output,
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            child.once('exit', () => done());
            child.kill('SIGTERM');
          }),
      };
    }
    if (child.exitCode !== null) {
      throw new Error(`worker exited early (${child.exitCode}):\n${output()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  child.kill('SIGKILL');
  throw new Error(`worker did not become ready:\n${output()}`);
}
