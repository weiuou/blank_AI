import type {
  SessionHistoryResponse,
  SessionMessageResponse,
  SessionStartResponse,
} from '../shared/types';
import {
  sessionHistoryResponseSchema,
  sessionMessageResponseSchema,
  sessionStartResponseSchema,
} from '../shared/types';

const API_BASE = 'http://localhost:8787';

async function request<T>(path: string, init: RequestInit, parser: { parse: (value: unknown) => T }): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? 'Request failed');
  }
  return parser.parse(payload);
}

export function startSession(): Promise<SessionStartResponse> {
  return request('/api/session/start', { method: 'POST' }, sessionStartResponseSchema);
}

export function sendMessage(sessionId: string, prompt: string): Promise<SessionMessageResponse> {
  return request(
    '/api/session/message',
    {
      method: 'POST',
      body: JSON.stringify({ sessionId, prompt }),
    },
    sessionMessageResponseSchema,
  );
}

export function undoMessage(sessionId: string): Promise<SessionHistoryResponse> {
  return request(
    '/api/session/undo',
    {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    },
    sessionHistoryResponseSchema,
  );
}

export function redoMessage(sessionId: string): Promise<SessionHistoryResponse> {
  return request(
    '/api/session/redo',
    {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    },
    sessionHistoryResponseSchema,
  );
}

export function jumpToSnapshot(sessionId: string, snapshotId: string): Promise<SessionHistoryResponse> {
  return request(
    '/api/session/jump',
    {
      method: 'POST',
      body: JSON.stringify({ sessionId, snapshotId }),
    },
    sessionHistoryResponseSchema,
  );
}
