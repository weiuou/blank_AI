import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import {
  apiErrorResponseSchema,
  debugTraceRecordSchema,
  debugTraceSummarySchema,
  sessionHistoryResponseSchema,
  sessionJumpRequestSchema,
  sessionMessageRequestSchema,
  sessionMessageResponseSchema,
  sessionStartResponseSchema,
} from '../src/shared/types';
import { validateAndApplyAiResponse, generateAssistantResponse } from './ai';
import {
  applyAssistantResponse,
  createSession,
  createTransientUserMessage,
  getSession,
  jumpToSnapshot,
  redoSession,
  undoSession,
} from './sessionStore';
import {
  finishTrace,
  getTraceRecord,
  listTraceSummaries,
  logEvent,
  readLogLines,
  runWithLogContext,
  startTrace,
} from './logger';

function shouldLogServerRequests(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.AI_DEBUG_REQUESTS !== 'false';
}

function previewPrompt(prompt: string, maxLength = 800): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...[truncated ${normalized.length - maxLength}]` : normalized;
}

function logMessageRequest(requestId: string, event: string, data: Record<string, unknown>): void {
  if (!shouldLogServerRequests()) {
    return;
  }
  logEvent({
    event: `server.message.${event}`,
    requestId,
    status: event === 'start' ? 'start' : event === 'success' ? 'success' : event === 'error' ? 'error' : 'info',
    ...data,
  });
}

function isDebugApiEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.AI_DEBUG_API === 'true';
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/debug/traces', (_req, res) => {
    if (!isDebugApiEnabled()) {
      res.status(404).json({ error: 'Debug API disabled' });
      return;
    }

    res.json({
      traces: debugTraceSummarySchema.array().parse(listTraceSummaries()),
    });
  });

  app.get('/api/debug/traces/:requestId', (req, res) => {
    if (!isDebugApiEnabled()) {
      res.status(404).json({ error: 'Debug API disabled' });
      return;
    }

    const trace = getTraceRecord(req.params.requestId);
    if (!trace) {
      res.status(404).json({ error: 'Trace not found' });
      return;
    }

    res.json(debugTraceRecordSchema.parse(trace));
  });

  app.get('/api/debug/logs', (req, res) => {
    if (!isDebugApiEnabled()) {
      res.status(404).json({ error: 'Debug API disabled' });
      return;
    }

    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    res.json({
      lines: readLogLines({ requestId, limit }),
    });
  });

  app.post('/api/session/start', (_req, res) => {
    const response = createSession();
    res.json(sessionStartResponseSchema.parse(response));
  });

  app.post('/api/session/message', async (req, res) => {
    const requestId = randomUUID().slice(0, 8);
    const startedAt = Date.now();
    let sessionId = '<unparsed>';
    await runWithLogContext({ requestId }, async () => {
      try {
        const body = sessionMessageRequestSchema.parse(req.body);
        sessionId = body.sessionId;
        startTrace(requestId, {
          sessionId,
          prompt: previewPrompt(body.prompt),
        });
        logMessageRequest(requestId, 'start', {
          sessionId,
          promptLength: body.prompt.length,
          prompt: previewPrompt(body.prompt),
        });
        const session = getSession(body.sessionId);
        const transientUserMessage = createTransientUserMessage(body.prompt);
        const aiResponse = await generateAssistantResponse(
          body.prompt,
          session.pageState,
          [...session.messages, transientUserMessage],
          { requestId },
        );
        if (aiResponse.error) {
          throw new Error(aiResponse.error);
        }
        const nextPageState = validateAndApplyAiResponse(session.pageState, aiResponse);
        const response = applyAssistantResponse(body.sessionId, body.prompt, aiResponse, nextPageState);
        finishTrace(requestId, 'success', undefined, Date.now() - startedAt);
        logMessageRequest(requestId, 'success', {
          sessionId,
          durationMs: Date.now() - startedAt,
          patchCount: aiResponse.patch.length,
          changeSummary: aiResponse.changeSummary,
        });
        res.json(sessionMessageResponseSchema.parse(response));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown server error';
        finishTrace(requestId, 'error', message, Date.now() - startedAt);
        logMessageRequest(requestId, 'error', {
          sessionId,
          durationMs: Date.now() - startedAt,
          error: message,
        });
        res.status(400).json(apiErrorResponseSchema.parse({
          error: message,
          requestId,
          retryable: true,
        }));
      }
    });
  });

  app.post('/api/session/undo', (req, res) => {
    try {
      const sessionId = String(req.body?.sessionId ?? '');
      const response = undoSession(sessionId);
      res.json(sessionHistoryResponseSchema.parse(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to undo';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/session/redo', (req, res) => {
    try {
      const sessionId = String(req.body?.sessionId ?? '');
      const response = redoSession(sessionId);
      res.json(sessionHistoryResponseSchema.parse(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to redo';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/session/jump', (req, res) => {
    try {
      const body = sessionJumpRequestSchema.parse(req.body);
      const response = jumpToSnapshot(body.sessionId, body.snapshotId);
      res.json(sessionHistoryResponseSchema.parse(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to switch timeline point';
      res.status(400).json({ error: message });
    }
  });

  return app;
}
