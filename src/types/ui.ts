import type { AiMessageResponse, ConversationMessage, PageState, SessionSnapshot } from '../shared/types';

export type ConversationState = {
  sessionId: string | null;
  messages: ConversationMessage[];
  snapshots: SessionSnapshot[];
  activeSnapshotId: string | null;
  lastResponse: AiMessageResponse | null;
  canUndo: boolean;
  canRedo: boolean;
};

export type SessionEnvelope = {
  pageState: PageState;
  conversation: ConversationState;
};
