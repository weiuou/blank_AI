import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import type { DebugTraceRecord, DebugTraceSummary, WorkflowTraceStep } from '../src/shared/types';

const defaultLogPath = path.resolve(process.cwd(), 'logs', 'blank-ai.log');
const logContext = new AsyncLocalStorage<{ requestId?: string }>();
const traceLimit = 100;
const traceRecords = new Map<string, DebugTraceRecord>();

type LogEvent = {
  event: string;
  requestId?: string;
  sessionId?: string;
  status?: 'start' | 'success' | 'error' | 'info';
  durationMs?: number;
  model?: string;
  provider?: string;
  tool?: string;
  error?: string;
  [key: string]: unknown;
};

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

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(value)) {
      return `[image-data-url length=${value.length}]`;
    }
    return value.length > 800 ? `${value.slice(0, 800)}...[truncated ${value.length - 800}]` : value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForLog);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/api[_-]?key|authorization|token|secret/i.test(key))
        .map(([key, nestedValue]) => [key, sanitizeForLog(nestedValue)]),
    );
  }

  return value;
}

export function logEvent(event: LogEvent): void {
  const sanitizedEvent = sanitizeForLog(event) as Record<string, unknown>;
  const payload = {
    timestamp: new Date().toISOString(),
    ...sanitizedEvent,
  };
  const line = JSON.stringify(payload);
  console.log(line);
  appendLine(line);
}

export function logLine(line: string): void {
  logEvent({
    event: 'legacy_log',
    status: 'info',
    message: line,
  });
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

function trimTraceRecords(): void {
  while (traceRecords.size > traceLimit) {
    const oldestKey = traceRecords.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    traceRecords.delete(oldestKey);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function startTrace(requestId: string, data: { sessionId?: string; prompt?: string } = {}): void {
  const timestamp = nowIso();
  traceRecords.set(requestId, {
    requestId,
    sessionId: data.sessionId,
    prompt: typeof data.prompt === 'string' ? String(sanitizeForLog(data.prompt)) : undefined,
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    stepCount: 0,
    steps: [],
  });
  trimTraceRecords();
}

export function addTraceStep(step: Omit<WorkflowTraceStep, 'timestamp' | 'requestId'> & { requestId?: string }): void {
  const requestId = step.requestId ?? getLogContext().requestId;
  if (!requestId) {
    return;
  }

  const record =
    traceRecords.get(requestId) ??
    ({
      requestId,
      status: 'running',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      stepCount: 0,
      steps: [],
    } satisfies DebugTraceRecord);
  const nextStep: WorkflowTraceStep = {
    timestamp: nowIso(),
    requestId,
    type: step.type,
    name: step.name,
    status: step.status,
    durationMs: step.durationMs,
    model: step.model,
    provider: step.provider,
    inputSummary: sanitizeForLog(step.inputSummary),
    outputSummary: sanitizeForLog(step.outputSummary),
    error: step.error,
  };
  record.steps.push(nextStep);
  record.stepCount = record.steps.length;
  record.updatedAt = nextStep.timestamp;
  traceRecords.set(requestId, record);
  trimTraceRecords();
}

export function finishTrace(requestId: string, status: 'success' | 'error', error?: string, durationMs?: number): void {
  const record = traceRecords.get(requestId);
  if (!record) {
    return;
  }

  record.status = status;
  record.error = error;
  record.durationMs = durationMs;
  record.updatedAt = nowIso();
}

export function listTraceSummaries(): DebugTraceSummary[] {
  return [...traceRecords.values()]
    .map(({ steps: _steps, ...summary }) => summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTraceRecord(requestId: string): DebugTraceRecord | undefined {
  const record = traceRecords.get(requestId);
  return record ? structuredClone(record) : undefined;
}

export function readLogLines(options: { requestId?: string; limit?: number } = {}): string[] {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) {
    return [];
  }

  const limit = Math.max(1, Math.min(500, options.limit ?? 200));
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const filtered = options.requestId ? lines.filter((line) => line.includes(options.requestId as string)) : lines;
  return filtered.slice(-limit);
}
