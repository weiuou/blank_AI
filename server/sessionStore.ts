import { randomUUID } from 'node:crypto';
import { createInitialPageState } from '../src/shared/defaults';
import type {
  AiMessageResponse,
  ConversationMessage,
  PageState,
  SessionHistoryResponse,
  SessionMessageResponse,
  SessionSnapshot,
  SessionStartResponse,
} from '../src/shared/types';

type SnapshotRecord = SessionSnapshot & {
  pageState: PageState;
};

type SessionRecord = {
  sessionId: string;
  pageState: PageState;
  messages: ConversationMessage[];
  undoStack: PageState[];
  redoStack: PageState[];
  lastResponse: AiMessageResponse | null;
  snapshots: SnapshotRecord[];
  activeSnapshotId: string;
};

const sessions = new Map<string, SessionRecord>();

function createSystemMessage(): ConversationMessage {
  return {
    id: randomUUID(),
    role: 'system',
    content: 'Blank AI session started.',
    timestamp: new Date().toISOString(),
  };
}

function createConversationMessage(role: ConversationMessage['role'], content: string): ConversationMessage {
  return {
    id: randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

function createSnapshot(
  index: number,
  pageState: PageState,
  prompt: string,
  label: string,
  assistantText?: string,
  hasPageChange = true,
): SnapshotRecord {
  return {
    id: `snapshot-${index}`,
    index,
    prompt,
    label,
    createdAt: new Date().toISOString(),
    assistantText,
    hasPageChange,
    pageState: structuredClone(pageState),
  };
}

function serializeSnapshots(snapshots: SnapshotRecord[]): SessionSnapshot[] {
  return snapshots.map(({ pageState: _pageState, ...snapshot }) => snapshot);
}

function responseBase(session: SessionRecord) {
  return {
    sessionId: session.sessionId,
    pageState: session.pageState,
    messages: session.messages,
    snapshots: serializeSnapshots(session.snapshots),
    activeSnapshotId: session.activeSnapshotId,
    canUndo: session.undoStack.length > 0,
    canRedo: session.redoStack.length > 0,
  };
}

export function createSession(): SessionStartResponse {
  const sessionId = randomUUID();
  const pageState = createInitialPageState();
  const messages = [createSystemMessage()];
  const snapshots = [createSnapshot(0, pageState, '空白画布', '开始', undefined, true)];
  sessions.set(sessionId, {
    sessionId,
    pageState,
    messages,
    undoStack: [],
    redoStack: [],
    lastResponse: null,
    snapshots,
    activeSnapshotId: snapshots[0].id,
  });

  return {
    sessionId,
    pageState,
    messages,
    snapshots: serializeSnapshots(snapshots),
    activeSnapshotId: snapshots[0].id,
  };
}

export function getSession(sessionId: string): SessionRecord {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  return session;
}

export function createTransientUserMessage(content: string): ConversationMessage {
  return createConversationMessage('user', content);
}

export function applyAssistantResponse(
  sessionId: string,
  prompt: string,
  response: AiMessageResponse,
  nextPageState: PageState,
): SessionMessageResponse {
  const session = getSession(sessionId);
  session.undoStack.push(structuredClone(session.pageState));
  session.redoStack = [];
  session.pageState = nextPageState;
  session.lastResponse = response;
  const hasPageChange = response.patch.length > 0;
  const nextSnapshot = createSnapshot(
    session.snapshots.length,
    nextPageState,
    prompt,
    `第 ${session.snapshots.length} 轮`,
    response.assistantText,
    hasPageChange,
  );
  session.snapshots.push(nextSnapshot);
  session.activeSnapshotId = nextSnapshot.id;
  session.messages.push(createConversationMessage('user', prompt));
  session.messages.push(createConversationMessage('assistant', response.assistantText));

  return {
    ...responseBase(session),
    lastResponse: response,
  };
}

export function undoSession(sessionId: string): SessionHistoryResponse {
  const session = getSession(sessionId);
  const previous = session.undoStack.pop();
  if (!previous) {
    throw new Error('Nothing to undo');
  }
  session.redoStack.push(structuredClone(session.pageState));
  session.pageState = previous;
  const match = session.snapshots.find((snapshot) => JSON.stringify(snapshot.pageState) === JSON.stringify(session.pageState));
  session.activeSnapshotId = match?.id ?? session.activeSnapshotId;
  return responseBase(session);
}

export function redoSession(sessionId: string): SessionHistoryResponse {
  const session = getSession(sessionId);
  const next = session.redoStack.pop();
  if (!next) {
    throw new Error('Nothing to redo');
  }
  session.undoStack.push(structuredClone(session.pageState));
  session.pageState = next;
  const match = session.snapshots.find((snapshot) => JSON.stringify(snapshot.pageState) === JSON.stringify(session.pageState));
  session.activeSnapshotId = match?.id ?? session.activeSnapshotId;
  return responseBase(session);
}

export function jumpToSnapshot(sessionId: string, snapshotId: string): SessionHistoryResponse {
  const session = getSession(sessionId);
  const snapshot = session.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    throw new Error('Snapshot not found');
  }

  session.undoStack.push(structuredClone(session.pageState));
  session.redoStack = [];
  session.pageState = structuredClone(snapshot.pageState);
  session.activeSnapshotId = snapshot.id;
  return responseBase(session);
}
