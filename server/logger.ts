import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

const defaultLogPath = path.resolve(process.cwd(), 'logs', 'blank-ai.log');
const logContext = new AsyncLocalStorage<{ requestId?: string }>();

function shouldWriteFileLog(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.AI_LOG_TO_FILE !== 'false';
}

function getLogPath(): string {
  return path.resolve(process.env.AI_LOG_FILE ?? defaultLogPath);
}

function appendLine(line: string): void {
  if (!shouldWriteFileLog()) {
    return;
  }

  try {
    const logPath = getLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[logger:error] Unable to write log file: ${message}`);
  }
}

export function logLine(line: string): void {
  const stampedLine = `${new Date().toISOString()} ${line}`;
  console.log(stampedLine);
  appendLine(stampedLine);
}

export function getActiveLogPath(): string {
  return getLogPath();
}

export function getLogContext(): { requestId?: string } {
  return logContext.getStore() ?? {};
}

export function runWithLogContext<T>(context: { requestId?: string }, callback: () => T): T {
  return logContext.run(context, callback);
}
