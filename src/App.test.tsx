import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { createInitialPageState } from './shared/defaults';
import type { PageNode } from './shared/types';

function getGeneratedIframe(name: string): HTMLIFrameElement {
  return screen.getByTitle(name) as HTMLIFrameElement;
}

function dispatchSandboxMessage(iframe: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        source: iframe.contentWindow,
      }),
    );
  });
}

const sessionStartPayload = {
  sessionId: 'session-1',
  pageState: createInitialPageState(),
  messages: [],
  snapshots: [
    {
      id: 'snapshot-0',
      index: 0,
      prompt: '空白画布',
      label: '开始',
      createdAt: '2026-06-16T00:00:00.000Z',
      hasPageChange: true,
    },
  ],
  activeSnapshotId: 'snapshot-0',
};

const sessionMessagePayload = {
  sessionId: 'session-1',
  pageState: {
    ...sessionStartPayload.pageState,
    root: {
      ...sessionStartPayload.pageState.root,
      children: [
        ...sessionStartPayload.pageState.root.children,
        {
          id: 'card-1',
          type: 'card',
          props: { title: 'A generated layout', subtitle: 'Created from your prompt.' },
          styleTokens: { padding: '32px', radius: '28px' },
          children: [],
        },
      ],
    },
  },
  messages: [
    {
      id: 'user-1',
      role: 'user',
      content: 'Build a portfolio page',
      timestamp: '2026-06-16T00:00:00.000Z',
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'I created a first layout.',
      timestamp: '2026-06-16T00:00:01.000Z',
    },
  ],
  snapshots: [
    ...sessionStartPayload.snapshots,
    {
      id: 'snapshot-1',
      index: 1,
      prompt: 'Build a portfolio page',
      label: '第 1 轮',
      createdAt: '2026-06-16T00:00:01.000Z',
      assistantText: 'I created a first layout.',
      hasPageChange: true,
    },
  ],
  activeSnapshotId: 'snapshot-1',
  lastResponse: {
    assistantText: 'I created a first layout.',
    changeSummary: 'Created a card.',
    patch: [],
  },
  canUndo: true,
  canRedo: false,
};

const textOnlyPayload = {
  sessionId: 'session-1',
  pageState: sessionStartPayload.pageState,
  messages: [
    {
      id: 'user-text-1',
      role: 'user',
      content: '你是谁',
      timestamp: '2026-06-16T00:00:02.000Z',
    },
    {
      id: 'assistant-text-1',
      role: 'assistant',
      content: '你好，我是 Blank AI。你想如何构建你的页面？',
      timestamp: '2026-06-16T00:00:03.000Z',
    },
  ],
  snapshots: [
    ...sessionStartPayload.snapshots,
    {
      id: 'snapshot-text-1',
      index: 1,
      prompt: '你是谁',
      label: '第 1 轮',
      createdAt: '2026-06-16T00:00:03.000Z',
      assistantText: '你好，我是 Blank AI。你想如何构建你的页面？',
      hasPageChange: false,
    },
  ],
  activeSnapshotId: 'snapshot-text-1',
  lastResponse: {
    assistantText: '你好，我是 Blank AI。你想如何构建你的页面？',
    changeSummary: 'Answered with text only.',
    patch: [],
  },
  canUndo: true,
  canRedo: false,
};

const generatedComponentPayload = {
  ...sessionMessagePayload,
  pageState: {
    ...sessionStartPayload.pageState,
    root: {
      ...sessionStartPayload.pageState.root,
      children: [
        ...sessionStartPayload.pageState.root.children,
        {
          id: 'generated-component-1',
          type: 'generated_react_component',
          props: {
            name: 'LiveWidget',
            code: "return React.createElement('div', null, 'Live generated widget')",
            mountProps: {},
            capabilities: ['sendPrompt'],
          },
          styleTokens: { width: 'min(520px, calc(100vw - 48px))', minHeight: '180px' },
          children: [],
        },
      ],
    },
  },
  snapshots: [
    ...sessionStartPayload.snapshots,
    {
      id: 'snapshot-generated-1',
      index: 1,
      prompt: '生成一个组件',
      label: '第 1 轮',
      createdAt: '2026-06-16T00:00:01.000Z',
      assistantText: 'I generated a sandboxed component.',
      hasPageChange: true,
    },
  ],
  activeSnapshotId: 'snapshot-generated-1',
  lastResponse: {
    assistantText: 'I generated a sandboxed component.',
    changeSummary: 'Added generated component.',
    patch: [],
  },
};

const generatedHooksComponentPayload = {
  ...generatedComponentPayload,
  pageState: {
    ...sessionStartPayload.pageState,
    root: {
      ...sessionStartPayload.pageState.root,
      children: [
        ...sessionStartPayload.pageState.root.children,
        {
          id: 'generated-hooks-component-1',
          type: 'generated_react_component',
          props: {
            name: 'HookTimer',
            code:
              "const state = useState(7);\nconst titleRef = useRef('Hook timer');\nconst seconds = state[0];\nreturn createElement('div', null, titleRef.current + ': ' + seconds);",
            mountProps: {},
            capabilities: [],
          },
          styleTokens: { width: 'min(520px, calc(100vw - 48px))', minHeight: '180px' },
          children: [],
        },
      ],
    },
  },
  snapshots: [
    ...sessionStartPayload.snapshots,
    {
      id: 'snapshot-hooks-1',
      index: 1,
      prompt: '生成一个计时器组件',
      label: '第 1 轮',
      createdAt: '2026-06-16T00:00:01.000Z',
      assistantText: 'I generated a hook component.',
      hasPageChange: true,
    },
  ],
  activeSnapshotId: 'snapshot-hooks-1',
  lastResponse: {
    assistantText: 'I generated a hook component.',
    changeSummary: 'Added generated hook component.',
    patch: [],
  },
};

const generatedBackgroundComponentPayload = {
  ...generatedComponentPayload,
  pageState: {
    ...sessionStartPayload.pageState,
    root: {
      ...sessionStartPayload.pageState.root,
      children: [
        ...sessionStartPayload.pageState.root.children,
        {
          id: 'generated-background-component-1',
          type: 'generated_react_component',
          props: {
            name: 'BackgroundWidget',
            code: "return React.createElement('div', null, 'Widget with host background')",
            mountProps: { backgroundImage: 'data:image/png;base64,abc123' },
            capabilities: [],
          },
          styleTokens: { width: 'min(520px, calc(100vw - 48px))', minHeight: '180px' },
          children: [],
        },
      ],
    },
  },
  snapshots: [
    ...sessionStartPayload.snapshots,
    {
      id: 'snapshot-background-component-1',
      index: 1,
      prompt: '给组件加背景',
      label: '第 1 轮',
      createdAt: '2026-06-16T00:00:01.000Z',
      assistantText: 'I updated the component background.',
      hasPageChange: true,
    },
  ],
  activeSnapshotId: 'snapshot-background-component-1',
};

const generatedInteractiveComponentPayload = {
  ...generatedComponentPayload,
  pageState: {
    ...sessionStartPayload.pageState,
    root: {
      ...sessionStartPayload.pageState.root,
      children: [
        ...sessionStartPayload.pageState.root.children,
        {
          id: 'generated-interactive-component-1',
          type: 'generated_react_component',
          props: {
            name: 'InteractiveWidget',
            code:
              "const state = React.useState(0);\nconst count = state[0];\nconst setCount = state[1];\nreturn React.createElement('button', { type: 'button', onClick: function () { setCount(count + 1); } }, 'Clicked ' + count);",
            mountProps: {},
            capabilities: [],
          },
          styleTokens: { width: 'min(520px, calc(100vw - 48px))', minHeight: '180px' },
          children: [],
        },
      ],
    },
  },
  snapshots: [
    ...sessionStartPayload.snapshots,
    {
      id: 'snapshot-interactive-1',
      index: 1,
      prompt: '生成一个可以点击的组件',
      label: '第 1 轮',
      createdAt: '2026-06-16T00:00:01.000Z',
      assistantText: 'I generated an interactive component.',
      hasPageChange: true,
    },
  ],
  activeSnapshotId: 'snapshot-interactive-1',
  lastResponse: {
    assistantText: 'I generated an interactive component.',
    changeSummary: 'Added generated interactive component.',
    patch: [],
  },
};

const generatedTwoComponentsPayload = {
  ...generatedComponentPayload,
  pageState: {
    ...sessionStartPayload.pageState,
    root: {
      ...sessionStartPayload.pageState.root,
      children: [
        ...sessionStartPayload.pageState.root.children,
        {
          id: 'generated-component-1',
          type: 'generated_react_component',
          props: {
            name: 'LiveWidget',
            code: "return React.createElement('div', null, 'Live generated widget')",
            mountProps: {},
            capabilities: [],
          },
          styleTokens: { width: 'min(520px, calc(100vw - 48px))', minHeight: '180px' },
          children: [],
        },
        {
          id: 'generated-component-2',
          type: 'generated_react_component',
          props: {
            name: 'SecondWidget',
            code: "return React.createElement('div', null, 'Second generated widget')",
            mountProps: {},
            capabilities: [],
          },
          styleTokens: { width: 'min(720px, calc(100vw - 48px))', minHeight: '280px' },
          children: [],
        },
      ],
    },
  },
  snapshots: [
    ...sessionStartPayload.snapshots,
    {
      id: 'snapshot-generated-2',
      index: 1,
      prompt: '生成两个组件',
      label: '第 1 轮',
      createdAt: '2026-06-16T00:00:01.000Z',
      assistantText: 'I generated two sandboxed components.',
      hasPageChange: true,
    },
  ],
  activeSnapshotId: 'snapshot-generated-2',
};

describe('App', () => {
  it('renders the blank prompt first and then opens the canvas flow', async () => {
    let resolveMessage: (value: unknown) => void = () => {};
    const pendingMessage = new Promise((resolve) => {
      resolveMessage = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockReturnValueOnce(pendingMessage);

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByPlaceholderText(/describe the page you want to create/i)).toBeInTheDocument());
    expect(document.querySelectorAll('.timeline-rail__node')).toHaveLength(1);
    await user.type(screen.getByLabelText(/prompt input/i), 'Build a portfolio page');
    await user.keyboard('{Enter}');

    expect(screen.getByRole('status')).toHaveTextContent('AI生成中...');
    expect(screen.getByTestId('prompt-flight')).toHaveTextContent('Build a portfolio page');
    expect(document.querySelectorAll('.timeline-rail__node')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /空白画布/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /正在生成这一轮/i })).toBeDisabled();

    resolveMessage({
      ok: true,
      json: async () => sessionMessagePayload,
    });

    await waitFor(() => expect(screen.getByText(/a generated layout/i)).toBeInTheDocument());
    expect(document.querySelectorAll('.timeline-rail__node')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /build a portfolio page/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe the page you want to create/i)).toBeInTheDocument();
  });

  it('uses ctrl+z to undo the last AI interaction', async () => {
    const undoPayload = {
      sessionId: 'session-1',
      pageState: sessionStartPayload.pageState,
      messages: sessionMessagePayload.messages,
      snapshots: sessionMessagePayload.snapshots,
      activeSnapshotId: 'snapshot-0',
      canUndo: false,
      canRedo: true,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionMessagePayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => undoPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), 'Build a portfolio page');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByText(/a generated layout/i)).toBeInTheDocument());
    await user.click(screen.getByLabelText(/prompt input/i));
    await user.keyboard('{Control>}z{/Control}');

    await waitFor(() => expect(screen.queryByText(/a generated layout/i)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('switches the canvas when a timeline point is clicked', async () => {
    const jumpPayload = {
      sessionId: 'session-1',
      pageState: sessionStartPayload.pageState,
      messages: sessionMessagePayload.messages,
      snapshots: sessionMessagePayload.snapshots,
      activeSnapshotId: 'snapshot-0',
      canUndo: true,
      canRedo: false,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionMessagePayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => jumpPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), 'Build a portfolio page');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByText(/a generated layout/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /空白画布/i }));

    await waitFor(() => expect(screen.queryByText(/a generated layout/i)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://localhost:8787/api/session/jump',
      expect.objectContaining({
        body: JSON.stringify({ sessionId: 'session-1', snapshotId: 'snapshot-0' }),
        method: 'POST',
      }),
    );
  });

  it('shows text-only AI replies, hides them on page click, and restores them from history', async () => {
    const jumpToStartPayload = {
      sessionId: 'session-1',
      pageState: sessionStartPayload.pageState,
      messages: textOnlyPayload.messages,
      snapshots: textOnlyPayload.snapshots,
      activeSnapshotId: 'snapshot-0',
      canUndo: true,
      canRedo: false,
    };
    const jumpToTextPayload = {
      sessionId: 'session-1',
      pageState: textOnlyPayload.pageState,
      messages: textOnlyPayload.messages,
      snapshots: textOnlyPayload.snapshots,
      activeSnapshotId: 'snapshot-text-1',
      canUndo: true,
      canRedo: false,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => textOnlyPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => jumpToStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => jumpToTextPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '你是谁');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByText(/你好，我是 Blank AI/i)).toBeInTheDocument());
    await user.click(screen.getByRole('main'));
    await waitFor(() => expect(screen.queryByText(/你好，我是 Blank AI/i)).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /空白画布/i }));
    await user.click(screen.getByRole('button', { name: /你是谁/i }));

    await waitFor(() => expect(screen.getByText(/你好，我是 Blank AI/i)).toBeInTheDocument());
  });

  it('applies system component layout changes while keeping the prompt usable', async () => {
    const movedPromptPayload = {
      ...sessionMessagePayload,
      pageState: {
        ...sessionStartPayload.pageState,
        root: {
          ...sessionStartPayload.pageState.root,
          children: sessionStartPayload.pageState.root.children.map((node: PageNode) =>
            node.id === 'system-prompt'
              ? {
                  ...node,
                  props: {
                    ...node.props,
                    layout: { position: 'bottom', width: 'min(720px, calc(100vw - 48px))' },
                    visual: { variant: 'glass', opacity: 0.5 },
                  },
                }
              : node,
          ),
        },
      },
      activeSnapshotId: 'snapshot-1',
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => movedPromptPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '把输入框挪到底部');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(document.querySelector('.composer-stage--bottom')).toBeInTheDocument());
    expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument();
  });

  it('mounts generated React components in the canvas', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => generatedComponentPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '生成一个组件');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('group', { name: 'LiveWidget' })).toBeInTheDocument());
    const iframe = getGeneratedIframe('LiveWidget');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.srcdoc).toContain('INIT_COMPONENT');
    expect(screen.queryByText('Live generated widget')).not.toBeInTheDocument();
    expect(document.querySelector('.generated-component-shell')).toBeInTheDocument();
    expect(document.querySelector('.composer-stage--dock')).toBeInTheDocument();
    expect(document.querySelector('.composer-stage--center')).not.toBeInTheDocument();
    expect(document.querySelector('.canvas-background')?.contains(document.querySelector('.composer-stage--dock'))).toBe(true);
    expect(document.querySelector('.page-renderer')?.contains(document.querySelector('.composer-stage--dock'))).toBe(false);
    expect(document.querySelector('.interaction-stage--canvas')?.contains(document.querySelector('.composer-stage--dock'))).toBe(true);
  });

  it('keeps generated canvas content and prompt dock in the same canvas without mixing render layers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => generatedTwoComponentsPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '生成两个组件');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('group', { name: 'SecondWidget' })).toBeInTheDocument());
    expect(document.querySelectorAll('.generated-component-shell')).toHaveLength(2);
    expect(document.querySelector('.canvas-background')?.contains(document.querySelector('.composer-stage--dock'))).toBe(true);
    expect(document.querySelector('.page-renderer')?.contains(document.querySelector('.composer-stage--dock'))).toBe(false);
    expect(document.querySelector('.app-shell--canvas')).toBeInTheDocument();
    expect(document.querySelector('.app-shell--canvas')?.children).toHaveLength(1);
    expect(document.querySelector('.canvas-background')?.children).toHaveLength(2);
    expect(document.querySelector('.canvas-background')?.children[0]).toBe(document.querySelector('.page-renderer'));
    expect(document.querySelector('.canvas-background')?.children[1]).toBe(document.querySelector('.canvas-overlay-layer'));
    expect(document.querySelector('.canvas-overlay-layer')?.contains(document.querySelector('.composer-stage--dock'))).toBe(true);
    expect(document.querySelector('.canvas-overlay-layer')?.contains(document.querySelector('.page-renderer'))).toBe(false);
    expect(document.querySelector('.interaction-stage--canvas')?.children).toContain(document.querySelector('.composer-stage--dock'));
  });

  it('keeps generated components visible when their sandbox reports a runtime error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => generatedComponentPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '生成一个组件');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('group', { name: 'LiveWidget' })).toBeInTheDocument());
    const iframe = getGeneratedIframe('LiveWidget');
    dispatchSandboxMessage(iframe, {
      type: 'COMPONENT_ERROR',
      nodeId: 'generated-component-1',
      message: 'Generated component did not return a React element',
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Generated component did not return a React element');
    expect(screen.getByRole('group', { name: 'LiveWidget' })).toBeInTheDocument();
    expect(document.querySelector('.generated-component-shell')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders generated component backgrounds in the host frame without rewriting sandbox code', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => generatedBackgroundComponentPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '给组件加背景');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('group', { name: 'BackgroundWidget' })).toBeInTheDocument());
    const frame = screen.getByRole('group', { name: 'BackgroundWidget' });
    expect(frame).toHaveClass('generated-component-frame--background');
    expect(frame).toHaveStyle({ backgroundSize: 'cover' });
    expect(getGeneratedIframe('BackgroundWidget').srcdoc).not.toContain('__renderOriginalComponent');
  });

  it('mounts generated React components with hook-capable sandbox runtime', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => generatedHooksComponentPayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '生成一个计时器组件');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('group', { name: 'HookTimer' })).toBeInTheDocument());
    const iframe = getGeneratedIframe('HookTimer');
    expect(iframe.srcdoc).toContain('useState');
    expect(iframe.srcdoc).toContain('useEffect');
    expect(iframe.srcdoc).toContain('useMemo');
    expect(iframe.srcdoc).toContain('useCallback');
    expect(iframe.srcdoc).toContain('"createElement",');
    expect(iframe.srcdoc).toContain('"useRef",');
  });

  it('bridges declared generated component capabilities from the sandbox', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionStartPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => generatedComponentPayload,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sessionMessagePayload,
      });

    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText(/prompt input/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/prompt input/i), '生成一个组件');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('group', { name: 'LiveWidget' })).toBeInTheDocument());
    const iframe = getGeneratedIframe('LiveWidget');
    dispatchSandboxMessage(iframe, {
      type: 'CALL_CAPABILITY',
      nodeId: 'generated-component-1',
      capability: 'sendPrompt',
      args: ['Build a portfolio page'],
    });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        'http://localhost:8787/api/session/message',
        expect.objectContaining({
          body: JSON.stringify({ sessionId: 'session-1', prompt: 'Build a portfolio page' }),
          method: 'POST',
        }),
      ),
    );
  });
});
