import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { PageRenderer } from './components/PageRenderer';
import { PromptComposer } from './components/PromptComposer';
import { jumpToSnapshot, sendMessage, startSession, undoMessage } from './lib/api';
import { createInitialPageState } from './shared/defaults';
import type { PageNode, PageState, SessionSnapshot } from './shared/types';
import type { ConversationState } from './types/ui';

const initialConversation: ConversationState = {
  sessionId: null,
  messages: [],
  snapshots: [],
  activeSnapshotId: null,
  lastResponse: null,
  canUndo: false,
  canRedo: false,
};

function mergeConversation(
  previous: ConversationState,
  next: Partial<ConversationState> & Pick<ConversationState, 'messages'>,
): ConversationState {
  return {
    ...previous,
    ...next,
  };
}

function TimelineRail({
  activeSnapshotId,
  busy,
  node,
  onSelectSnapshot,
  snapshots,
}: {
  activeSnapshotId: string | null;
  busy: boolean;
  node?: PageNode;
  onSelectSnapshot: (snapshotId: string) => void;
  snapshots: SessionSnapshot[];
}) {
  const layout = node?.props.layout && typeof node.props.layout === 'object' ? (node.props.layout as Record<string, unknown>) : {};
  const visual = node?.props.visual && typeof node.props.visual === 'object' ? (node.props.visual as Record<string, unknown>) : {};
  const position = String(layout.position ?? 'right');
  const orientation = String(layout.orientation ?? 'vertical');
  const showLabels = node?.props.showLabels !== false;
  const opacity = Number(visual.opacity ?? 1);
  const safeSnapshots =
    snapshots.length > 0
      ? snapshots
      : [
          {
            id: 'initial',
            index: 0,
            prompt: '空白画布',
            label: '开始',
            createdAt: '',
          },
        ];
  const safeTurnCount = Math.max(1, safeSnapshots.length + (busy ? 1 : 0));
  const denominator = Math.max(1, safeTurnCount - 1);

  return (
    <aside
      className={[
        'timeline-rail',
        `timeline-rail--${position}`,
        `timeline-rail--${orientation}`,
      ].join(' ')}
      style={{ '--timeline-opacity': opacity } as CSSProperties}
      aria-label="历史时间轴"
    >
      {showLabels ? <span className="timeline-rail__label timeline-rail__label--top">最新</span> : null}
      <span className="timeline-rail__line" />
      {Array.from({ length: safeTurnCount }, (_, index) => {
        const newestFirstIndex = safeTurnCount - index - 1;
        const progress = safeTurnCount === 1 ? 0 : newestFirstIndex / denominator;
        const snapshot = safeSnapshots[index];
        const isPending = !snapshot;
        const isLatest = index === safeTurnCount - 1;
        return (
          <button
            aria-label={snapshot ? `切换到${snapshot.label}: ${snapshot.prompt}` : '正在生成这一轮'}
            className={[
              'timeline-rail__node',
              activeSnapshotId === snapshot?.id ? 'timeline-rail__node--active' : '',
              isLatest ? 'timeline-rail__node--latest' : '',
              isPending ? 'timeline-rail__node--busy' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={isPending}
            key={index}
            onClick={() => snapshot && onSelectSnapshot(snapshot.id)}
            style={{ '--node-progress': progress } as CSSProperties}
            type="button"
          >
            <span className="timeline-rail__tooltip">{snapshot?.prompt ?? 'AI生成中...'}</span>
          </button>
        );
      })}
      {showLabels ? <span className="timeline-rail__label timeline-rail__label--bottom">最早</span> : null}
    </aside>
  );
}

function findNodeByType(node: PageNode, type: PageNode['type']): PageNode | undefined {
  if (node.type === type) {
    return node;
  }
  for (const child of node.children) {
    const match = findNodeByType(child, type);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function hasUserCanvasContent(pageState: PageState): boolean {
  return pageState.root.children.some((node) => node.type !== 'system_prompt' && node.type !== 'system_timeline');
}

function getPromptStageStyle(node?: PageNode): CSSProperties {
  const layout = node?.props.layout && typeof node.props.layout === 'object' ? (node.props.layout as Record<string, unknown>) : {};
  const visual = node?.props.visual && typeof node.props.visual === 'object' ? (node.props.visual as Record<string, unknown>) : {};
  return {
    '--prompt-width': String(layout.width ?? 'min(760px, 100%)'),
    '--prompt-max-width': String(layout.maxWidth ?? 'min(760px, 100%)'),
    '--prompt-opacity': String(visual.opacity ?? 0.42),
    '--prompt-radius': String(visual.radius ?? '32px'),
  } as CSSProperties;
}

export default function App() {
  const [pageState, setPageState] = useState<PageState>(createInitialPageState());
  const [conversation, setConversation] = useState<ConversationState>(initialConversation);
  const [busy, setBusy] = useState(false);
  const [flyingPrompt, setFlyingPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedTextSnapshotId, setDismissedTextSnapshotId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await startSession();
        setPageState(response.pageState);
        setConversation((current) =>
          mergeConversation(current, {
            sessionId: response.sessionId,
            messages: response.messages,
            snapshots: response.snapshots,
            activeSnapshotId: response.activeSnapshotId,
          }),
        );
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Failed to start session');
      }
    })();
  }, []);

  async function handlePromptSubmit(prompt: string) {
    if (!conversation.sessionId) {
      return;
    }
    setBusy(true);
    setFlyingPrompt(prompt);
    setError(null);
    try {
      const response = await sendMessage(conversation.sessionId, prompt);
      setPageState(response.pageState);
      setDismissedTextSnapshotId(null);
      setConversation((current) =>
        mergeConversation(current, {
          sessionId: response.sessionId,
          messages: response.messages,
          snapshots: response.snapshots,
          activeSnapshotId: response.activeSnapshotId,
          lastResponse: response.lastResponse,
          canUndo: response.canUndo,
          canRedo: response.canRedo,
        }),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to send prompt');
    } finally {
      setBusy(false);
    }
  }

  async function handleExportCanvas() {
    const canvas = document.querySelector('.page-renderer') as HTMLElement | null;
    if (!canvas) {
      setError('No canvas to export yet');
      return;
    }

    try {
      const width = Math.max(1, canvas.offsetWidth);
      const height = Math.max(1, canvas.offsetHeight);
      const payload = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(canvas.cloneNode(true))}</foreignObject>
      </svg>`;
      const svgUrl = URL.createObjectURL(new Blob([payload], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      image.decoding = 'async';
      image.src = svgUrl;
      await image.decode();
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      output.getContext('2d')?.drawImage(image, 0, 0);
      URL.revokeObjectURL(svgUrl);
      const pngUrl = output.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = 'blank-ai-canvas.png';
      link.click();
    } catch {
      setError('Unable to export the canvas');
    }
  }

  async function handleUndo() {
    if (!conversation.sessionId || !conversation.canUndo || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await undoMessage(conversation.sessionId);
      setPageState(response.pageState);
      setDismissedTextSnapshotId(null);
      setConversation((current) =>
        mergeConversation(current, {
          messages: response.messages,
          snapshots: response.snapshots,
          activeSnapshotId: response.activeSnapshotId,
          canUndo: response.canUndo,
          canRedo: response.canRedo,
        }),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to undo');
    } finally {
      setBusy(false);
    }
  }

  function handleGeneratedComponentError(message: string) {
    setError(message);
    if (conversation.canUndo && !busy) {
      void handleUndo();
    }
  }

  async function handleSnapshotSelect(snapshotId: string) {
    if (!conversation.sessionId || busy || snapshotId === conversation.activeSnapshotId) {
      return;
    }

    setError(null);
    try {
      const response = await jumpToSnapshot(conversation.sessionId, snapshotId);
      setPageState(response.pageState);
      setDismissedTextSnapshotId(null);
      setConversation((current) =>
        mergeConversation(current, {
          messages: response.messages,
          snapshots: response.snapshots,
          activeSnapshotId: response.activeSnapshotId,
          canUndo: response.canUndo,
          canRedo: response.canRedo,
        }),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to switch timeline point');
    }
  }

  const hasCanvasContent = hasUserCanvasContent(pageState);
  const promptNode = findNodeByType(pageState.root, 'system_prompt');
  const timelineNode = findNodeByType(pageState.root, 'system_timeline');
  const promptLayout =
    promptNode?.props.layout && typeof promptNode.props.layout === 'object' ? (promptNode.props.layout as Record<string, unknown>) : {};
  const promptPosition = String(promptLayout.position ?? 'center');
  const promptPlaceholder = String(promptNode?.props.placeholder ?? 'Describe the page you want to create...');
  const activeSnapshot = conversation.snapshots.find((snapshot) => snapshot.id === conversation.activeSnapshotId);
  const activeTextResponse =
    activeSnapshot?.assistantText && !activeSnapshot.hasPageChange && dismissedTextSnapshotId !== activeSnapshot.id
      ? activeSnapshot.assistantText
      : null;

  function handleMainClick(event: MouseEvent<HTMLElement>) {
    if (!activeSnapshot || !activeTextResponse) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('.prompt-composer') || target.closest('.timeline-rail') || target.closest('.text-response')) {
      return;
    }

    setDismissedTextSnapshotId(activeSnapshot.id);
  }

  return (
    <main className={hasCanvasContent ? 'app-shell app-shell--canvas' : 'app-shell'} onClick={handleMainClick}>
      {hasCanvasContent ? (
        <div className="canvas-background">
          <PageRenderer
            activeSnapshotId={conversation.activeSnapshotId}
            onExportCanvas={handleExportCanvas}
            onGeneratedComponentError={handleGeneratedComponentError}
            onSelectSnapshot={(snapshotId) => void handleSnapshotSelect(snapshotId)}
            onSendPrompt={(prompt) => void handlePromptSubmit(prompt)}
            pageState={pageState}
            snapshots={conversation.snapshots}
          />
        </div>
      ) : null}
      <TimelineRail
        activeSnapshotId={conversation.activeSnapshotId}
        busy={busy}
        node={timelineNode}
        onSelectSnapshot={(snapshotId) => void handleSnapshotSelect(snapshotId)}
        snapshots={conversation.snapshots}
      />
      <section className={hasCanvasContent ? 'interaction-stage interaction-stage--canvas' : 'interaction-stage'}>
        {!hasCanvasContent ? (
          <div className="blank-stage__inner">
            <p className="blank-stage__eyebrow">Blank AI</p>
          </div>
        ) : null}
        <div
          className={[
            'composer-stage',
            hasCanvasContent ? 'composer-stage--canvas' : '',
            `composer-stage--${promptPosition}`,
          ]
            .filter(Boolean)
            .join(' ')}
          style={getPromptStageStyle(promptNode)}
        >
          <PromptComposer
            busy={busy}
            canUndo={conversation.canUndo}
            onSubmit={handlePromptSubmit}
            onUndo={handleUndo}
            placeholder={promptPlaceholder}
          />
        </div>
        {flyingPrompt ? (
          <div
            className="prompt-flight"
            data-testid="prompt-flight"
            key={flyingPrompt}
            onAnimationEnd={() => setFlyingPrompt(null)}
          >
            {flyingPrompt}
          </div>
        ) : null}
        {activeTextResponse ? (
          <div className="text-response" key={activeSnapshot?.id}>
            <p>{activeTextResponse}</p>
          </div>
        ) : null}
      </section>
      {busy ? (
        <div className="generation-status" role="status" aria-live="polite">
          <span className="generation-status__ring" />
          <span>AI生成中...</span>
        </div>
      ) : null}
      {error ? <div className="error-toast">{error}</div> : null}
    </main>
  );
}
