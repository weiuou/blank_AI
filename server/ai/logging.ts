import { addTraceStep, getLogContext, logEvent } from '../logger';

export function shouldLogAiHttp(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.AI_DEBUG_HTTP !== 'false';
}

export function shouldLogAiWorkflow(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.AI_DEBUG_WORKFLOW !== 'false';
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return `[image-data-url length=${value.length}]`;
    }
    return value.length > 800 ? `${value.slice(0, 800)}...[truncated ${value.length - 800}]` : value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForLog);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, sanitizeForLog(nestedValue)]));
  }

  return value;
}

export function previewOutput(value: string, maxLength = 800): string {
  const sanitized = sanitizeForLog(value);
  const text = typeof sanitized === 'string' ? sanitized : String(sanitized);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated ${text.length - maxLength}]` : text;
}

export function logWorkflow(workflowId: string, event: string, data: Record<string, unknown> = {}): void {
  if (!shouldLogAiWorkflow()) {
    return;
  }
  const toolName = typeof data.tool === 'string' ? data.tool : event;
  const status =
    event === 'tool_call' || event === 'start'
      ? 'start'
      : data.ok === false || event.includes('failed')
        ? 'error'
        : event === 'tool_result' || event === 'final_patch'
          ? 'success'
          : 'info';
  const error = typeof data.error === 'string' ? data.error : undefined;
  const durationMs = typeof data.durationMs === 'number' ? data.durationMs : undefined;
  const model = typeof data.model === 'string' ? data.model : undefined;
  const provider = typeof data.provider === 'string' ? data.provider : undefined;
  const sanitizedData = sanitizeForLog(data);

  logEvent({
    event: `ai.workflow.${event}`,
    requestId: workflowId,
    status,
    durationMs,
    model,
    provider,
    tool: toolName,
    error,
    data: sanitizedData,
  });
  addTraceStep({
    requestId: workflowId,
    type: 'workflow',
    name: toolName,
    status,
    durationMs,
    model,
    provider,
    inputSummary: event === 'tool_call' ? sanitizedData : undefined,
    outputSummary: event !== 'tool_call' ? sanitizedData : undefined,
    error,
  });
}

export function currentRequestId(): string {
  return getLogContext().requestId ?? 'noctx';
}
