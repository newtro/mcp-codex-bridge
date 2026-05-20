import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof makeKill>;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function makeKill(child: FakeChild) {
  return (signal?: NodeJS.Signals | number) => {
    child.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    setImmediate(() => child.emit('close', null, child.signalCode));
    return true;
  };
}

/**
 * Builds a controllable fake child that the test harness can drive: push
 * stdout/stderr chunks, emit close/error, and observe stdin writes.
 */
export function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 99999;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = makeKill(child);
  return child;
}

export interface SpawnRecord {
  command: string;
  args: readonly string[];
  child: FakeChild;
}

export interface ProgrammableSpawn {
  /** Last recorded call. Use to assert args. */
  lastCall(): SpawnRecord | null;
  /** All recorded calls. */
  calls(): SpawnRecord[];
  /** Drive the next spawn outcome. Called BEFORE the spawn is invoked. */
  next(outcome: (child: FakeChild, stdinReader: () => string) => void): void;
  /** The mock spawn function to install via vi.mocked(spawn). */
  spawnFn: (command: string, args: readonly string[]) => FakeChild;
  /** Force the next spawn to throw synchronously (rare). */
  throwOnNextSpawn(err: NodeJS.ErrnoException): void;
}

export function programmableSpawn(): ProgrammableSpawn {
  const recorded: SpawnRecord[] = [];
  const outcomes: ((child: FakeChild, getStdin: () => string) => void)[] = [];
  let throwNext: NodeJS.ErrnoException | null = null;

  const spawnFn = (command: string, args: readonly string[]): FakeChild => {
    if (throwNext) {
      const err = throwNext;
      throwNext = null;
      throw err;
    }
    const child = makeFakeChild();
    let stdinBuf = '';
    child.stdin.on('data', (chunk: Buffer) => {
      stdinBuf += chunk.toString('utf8');
    });
    recorded.push({ command, args, child });
    const outcome = outcomes.shift();
    if (outcome) {
      // Run outcome on the next tick so the caller has time to attach listeners.
      setImmediate(() => outcome(child, () => stdinBuf));
    }
    return child;
  };

  return {
    spawnFn,
    lastCall: () => (recorded.length === 0 ? null : (recorded[recorded.length - 1] ?? null)),
    calls: () => recorded.slice(),
    next: (outcome) => {
      outcomes.push(outcome);
    },
    throwOnNextSpawn: (err) => {
      throwNext = err;
    },
  };
}
