import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import {
  sessionHistoryResponseSchema,
  sessionJumpRequestSchema,
  sessionMessageRequestSchema,
  sessionMessageResponseSchema,
  sessionStartResponseSchema,
} from '../src/shared/types';
import { validateAndApplyAiResponse, generateAssistantResponse } from './ai';
import {
  addUserMessage,
  applyAssistantResponse,
  createSession,
  getSession,
  jumpToSnapshot,
  redoSession,
  undoSession,
} from './sessionStore';
import { logLine, runWithLogContext } from './logger';

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
  logLine(`[server:message:${requestId}] ${event} ${JSON.stringify(data)}`);
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
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
        logMessageRequest(requestId, 'start', {
          sessionId,
          promptLength: body.prompt.length,
          prompt: previewPrompt(body.prompt),
        });
        addUserMessage(body.sessionId, body.prompt);
        const session = getSession(body.sessionId);
        const aiResponse = await generateAssistantResponse(body.prompt, session.pageState, session.messages, { requestId });
        if (aiResponse.error) {
          throw new Error(aiResponse.error);
        }
        const nextPageState = validateAndApplyAiResponse(session.pageState, aiResponse);
        const response = applyAssistantResponse(body.sessionId, aiResponse, nextPageState);
        logMessageRequest(requestId, 'success', {
          sessionId,
          durationMs: Date.now() - startedAt,
          patchCount: aiResponse.patch.length,
          changeSummary: aiResponse.changeSummary,
        });
        res.json(sessionMessageResponseSchema.parse(response));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown server error';
        logMessageRequest(requestId, 'error', {
          sessionId,
          durationMs: Date.now() - startedAt,
          error: message,
        });
        res.status(400).json({
          error: message,
        });
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
