import { defaultTheme } from '../../src/shared/defaults';
import { validatePatchOperations } from '../../src/shared/patches';
import type { AiMessageResponse, PageNode, PagePatchOperation, PageState } from '../../src/shared/types';
import type { WorkflowPlan, WorkflowToolName, WorkflowToolResult } from './contracts';
import {
  extractMockGraffitiWord,
  inferMockAccent,
  isMockGeneratedComponentRequest,
  isMockGraffitiBackgroundRequest,
  isMockPromptMoveBottomRequest,
  isMockTimelineMoveLeftRequest,
  isTableComponentFallback,
  isTimerComponentFallback,
} from './intentRules';
import { findImageDataUrl, getCandidatePatch } from './tools';

function buildGeneratedTableWithImagePatch(prompt: string, imageDataUrl: string): PagePatchOperation[] {
  return [
    {
      type: 'add_node',
      target: { parentId: 'root', index: 0 },
      node: {
        id: `generated-table-${Math.random().toString(36).slice(2, 8)}`,
        type: 'generated_react_component',
        props: {
          name: 'GeneratedImageTable',
          capabilities: [],
          mountProps: {
            title: prompt.includes('宝可梦') || prompt.toLowerCase().includes('pokemon') ? 'Pokemon themed 3 x 3 table' : 'Generated 3 x 3 table',
            backgroundImage: imageDataUrl,
            columns: ['A', 'B', 'C'],
            rows: [
              ['1', '2', '3'],
              ['4', '5', '6'],
              ['7', '8', '9'],
            ],
          },
          code: [
            "const e = React.createElement;",
            "const columns = Array.isArray(props.columns) ? props.columns : ['A', 'B', 'C'];",
            "const rows = Array.isArray(props.rows) ? props.rows : [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];",
            "const backgroundImage = props.backgroundImage ? `linear-gradient(rgba(255,255,255,0.42), rgba(255,255,255,0.62)), url(${props.backgroundImage})` : 'rgba(255,255,255,0.68)';",
            "return e('section', { style: { width: '100%', minHeight: 360, padding: 24, borderRadius: 30, backgroundImage, backgroundSize: 'cover', backgroundPosition: 'center', boxShadow: '0 28px 90px rgba(20,20,20,0.16)', border: '1px solid rgba(255,255,255,0.58)', overflow: 'hidden', color: theme.textPrimary || '#111' } },",
            "  e('h2', { style: { margin: '0 0 16px', fontSize: 24, letterSpacing: '-0.03em' } }, props.title || 'Generated 3 x 3 table'),",
            "  e('div', { style: { borderRadius: 22, overflow: 'hidden', background: 'rgba(255,255,255,0.38)', backdropFilter: 'blur(10px)' } },",
            "    e('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: 460 } },",
            "      e('thead', null, e('tr', null, columns.map((col, index) => e('th', { key: index, style: { textAlign: 'center', padding: '15px 18px', fontSize: 14, fontWeight: 700, background: 'rgba(255,255,255,0.52)', borderBottom: '1px solid rgba(17,24,39,0.14)' } }, col)))),",
            "      e('tbody', null, rows.map((row, rowIndex) => e('tr', { key: rowIndex }, row.map((cell, cellIndex) => e('td', { key: cellIndex, style: { textAlign: 'center', padding: '18px', fontSize: 16, fontWeight: 650, borderBottom: rowIndex === rows.length - 1 ? 'none' : '1px solid rgba(17,24,39,0.1)', borderRight: cellIndex === row.length - 1 ? 'none' : '1px solid rgba(17,24,39,0.08)', background: rowIndex % 2 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)' } }, cell)))))",
            "    )",
            "  )",
            ");",
          ].join('\n'),
        },
        styleTokens: {
          width: 'min(860px, calc(100vw - 56px))',
          minHeight: '380px',
        },
        children: [],
      },
    },
  ];
}

function buildGeneratedTimerPatch(prompt: string): PagePatchOperation[] {
  const isCountdown = prompt.includes('倒计时') || prompt.toLowerCase().includes('countdown');
  const shouldPlaceLower = prompt.includes('下半') || prompt.includes('底部') || prompt.toLowerCase().includes('bottom');
  return [
    {
      type: 'add_node',
      target: { parentId: 'root', index: 0 },
      node: {
        id: `generated-timer-${Math.random().toString(36).slice(2, 8)}`,
        type: 'generated_react_component',
        props: {
          name: isCountdown ? 'CountdownTimer' : 'TimerWidget',
          capabilities: [],
          mountProps: {
            title: isCountdown ? '倒计时' : '计时器',
            mode: isCountdown ? 'countdown' : 'timer',
            initialSeconds: isCountdown ? 300 : 0,
          },
          code: [
            "const e = React.createElement;",
            "const mode = props.mode === 'countdown' ? 'countdown' : 'timer';",
            "const initialSeconds = Number.isFinite(Number(props.initialSeconds)) ? Number(props.initialSeconds) : (mode === 'countdown' ? 300 : 0);",
            "const state = React.useState(initialSeconds);",
            "const seconds = state[0];",
            "const setSeconds = state[1];",
            "const runningState = React.useState(false);",
            "const running = runningState[0];",
            "const setRunning = runningState[1];",
            "React.useEffect(function () {",
            "  if (!running) return undefined;",
            "  const id = setInterval(function () {",
            "    setSeconds(function (value) {",
            "      if (mode === 'countdown') return Math.max(0, value - 1);",
            "      return value + 1;",
            "    });",
            "  }, 1000);",
            "  return function () { clearInterval(id); };",
            "}, [running, mode]);",
            "React.useEffect(function () { if (mode === 'countdown' && seconds === 0) setRunning(false); }, [seconds, mode]);",
            "const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');",
            "const rest = String(seconds % 60).padStart(2, '0');",
            "const display = minutes + ':' + rest;",
            "const buttonStyle = { border: '1px solid rgba(17,17,17,0.12)', borderRadius: 999, padding: '10px 15px', background: 'rgba(255,255,255,0.52)', cursor: 'pointer', color: '#171717' };",
            "return e('section', { style: { width: '100%', minHeight: 260, padding: 28, borderRadius: 34, background: 'linear-gradient(135deg, rgba(255,255,255,0.62), rgba(236,240,232,0.42))', border: '1px solid rgba(255,255,255,0.56)', boxShadow: '0 30px 90px rgba(20,20,20,0.12)', backdropFilter: 'blur(12px)', color: theme.textPrimary || '#111', display: 'grid', gap: 18, placeItems: 'center' } },",
            "  e('p', { style: { margin: 0, fontSize: 12, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'rgba(17,17,17,0.48)' } }, props.title || (mode === 'countdown' ? 'Countdown' : 'Timer')),",
            "  e('div', { style: { fontVariantNumeric: 'tabular-nums', fontSize: 'clamp(3rem, 12vw, 7.5rem)', lineHeight: 1, letterSpacing: '-0.08em', fontWeight: 750 } }, display),",
            "  e('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' } },",
            "    e('button', { type: 'button', style: buttonStyle, onClick: function () { setRunning(!running); } }, running ? '暂停' : '开始'),",
            "    e('button', { type: 'button', style: buttonStyle, onClick: function () { setRunning(false); setSeconds(initialSeconds); } }, '重置')",
            "  )",
            ");",
          ].join('\n'),
        },
        styleTokens: {
          width: 'min(620px, calc(100vw - 56px))',
          minHeight: '280px',
          ...(shouldPlaceLower ? { padding: '52vh 0 0' } : {}),
        },
        children: [],
      },
    },
  ];
}

export function getWorkflowFallbackPatch(
  prompt: string,
  plan: WorkflowPlan,
  toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
): PagePatchOperation[] | null {
  const candidatePatch = getCandidatePatch(toolResults);
  if (candidatePatch) {
    return candidatePatch;
  }

  return null;
}

export function buildMockPatch(prompt: string, pageState: PageState): AiMessageResponse {
  const normalized = prompt.trim().toLowerCase();
  const hasContent = pageState.root.children.some((node: PageNode) => !node.type.startsWith('system_'));
  const accents = inferMockAccent(normalized);
  const patch: PagePatchOperation[] = [];

  if (isMockPromptMoveBottomRequest(prompt)) {
    return {
      assistantText: 'I moved the prompt to the bottom while keeping it usable.',
      changeSummary: 'Moved the system prompt to the bottom.',
      patch: [
        {
          type: 'update_node',
          nodeId: 'system-prompt',
          props: {
            layout: {
              position: 'bottom',
              width: 'min(720px, calc(100vw - 48px))',
            },
            visual: {
              variant: 'glass',
              opacity: 0.48,
            },
          },
        },
      ],
    };
  }

  if (isMockTimelineMoveLeftRequest(prompt)) {
    return {
      assistantText: 'I moved the timeline to the left side.',
      changeSummary: 'Moved the system timeline to the left.',
      patch: [
        {
          type: 'update_node',
          nodeId: 'system-timeline',
          props: {
            layout: {
              position: 'left',
              orientation: 'vertical',
            },
            visual: {
              variant: 'minimal',
              opacity: 1,
            },
          },
        },
      ],
    };
  }

  if (isMockGeneratedComponentRequest(prompt)) {
    return {
      assistantText: 'I generated a live sandboxed component for the canvas.',
      changeSummary: 'Added an AI generated React component.',
      patch: [
        {
          type: 'add_node',
          target: { parentId: 'root', index: 0 },
          node: {
            id: `generated-${Math.random().toString(36).slice(2, 8)}`,
            type: 'generated_react_component',
            props: {
              name: 'GeneratedPanel',
              capabilities: ['sendPrompt'],
              mountProps: {
                title: 'Generated component',
                prompt,
              },
              code:
                "const e = React.createElement;\nreturn e('section', { style: { padding: 28, borderRadius: 30, background: 'rgba(255,255,255,0.52)', border: '1px solid rgba(255,255,255,0.54)', boxShadow: '0 24px 70px rgba(20,20,20,0.08)', backdropFilter: 'blur(10px)', color: theme.textPrimary || '#111' } }, e('p', { style: { margin: 0, letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 11, color: theme.textSecondary || '#777' } }, 'AI generated'), e('h2', { style: { margin: '10px 0 8px', fontSize: 32, lineHeight: 1.05 } }, props.title || 'Generated component'), e('p', { style: { margin: 0, color: theme.textSecondary || '#666', lineHeight: 1.7 } }, 'This component is running inside a sandbox iframe and can call declared host capabilities.'))",
            },
            styleTokens: {
              width: 'min(680px, calc(100vw - 48px))',
              minHeight: '220px',
            },
            children: [],
          },
        },
      ],
    };
  }

  if (isMockGraffitiBackgroundRequest(prompt)) {
    const word = extractMockGraffitiWord(prompt);
    patch.push(
      {
        type: 'set_theme_tokens',
        theme: {
          ...defaultTheme,
          pageBackground: '#ffffff',
          surface: '#ffffff',
          surfaceMuted: '#f6f6f6',
          accent: '#6f6f6f',
          accentSoft: '#eeeeee',
        },
      },
      {
        type: 'add_node',
        target: { parentId: 'root', index: 0 },
        node: {
          id: 'graffiti-background',
          type: 'graffiti_word',
          props: {
            text: word,
            variant: 'street',
            opacity: 0.16,
          },
          styleTokens: {},
          children: [],
        },
      },
    );

    return {
      assistantText: `I placed ${word} behind the input as a pale street-graffiti background.`,
      changeSummary: 'Added a pale graffiti word background.',
      patch,
    };
  }

  patch.push({
    type: 'set_theme_tokens',
    theme: {
      ...defaultTheme,
      ...accents,
      pageBackground: '#fcfcfb',
      surface: '#ffffff',
      surfaceMuted: accents.accentSoft,
      accent: accents.accent,
      accentSoft: accents.accentSoft,
    },
  });

  if (!hasContent) {
    patch.push(
      {
        type: 'add_node',
        target: { parentId: 'root', index: 0 },
        node: {
          id: 'hero-card',
          type: 'card',
          props: {
            title: normalized.includes('portfolio') ? 'A calm portfolio landing' : 'A page shaped by your prompt',
            subtitle: 'This canvas is controlled through safe UI patches rather than raw HTML.',
          },
          styleTokens: {
            padding: '40px',
            radius: '32px',
            border: '1px solid #e8e3dc',
            shadow: '0 24px 60px rgba(17, 17, 17, 0.08)',
            width: 'min(920px, calc(100vw - 48px))',
          },
          children: [
            {
              id: 'hero-heading',
              type: 'heading',
              props: {
                text: normalized.includes('travel') ? 'Designing a travel-inspired canvas' : 'Your idea is taking shape',
                level: 1,
              },
              styleTokens: {
                color: '#111111',
              },
              children: [],
            },
            {
              id: 'hero-copy',
              type: 'text',
              props: {
                text: `Prompt received: ${prompt}`,
              },
              styleTokens: {
                color: '#666666',
              },
              children: [],
            },
            {
              id: 'hero-columns',
              type: 'columns',
              props: {
                columns: 2,
              },
              styleTokens: {
                gap: '18px',
                padding: '24px 0 0',
              },
              children: [
                {
                  id: 'column-one-card',
                  type: 'card',
                  props: {
                    title: 'Mood',
                    subtitle: 'Minimal, airy, and ready for iterative refinement.',
                  },
                  styleTokens: {
                    background: accents.accentSoft,
                    padding: '20px',
                    radius: '20px',
                  },
                  children: [],
                },
                {
                  id: 'column-two-list',
                  type: 'list',
                  props: {
                    items: ['Structured components only', 'Undo and redo ready', 'Expandable conversation panel'],
                  },
                  styleTokens: {
                    padding: '20px',
                    border: '1px solid #ece7df',
                    radius: '20px',
                  },
                  children: [],
                },
              ],
            },
          ],
        },
      },
      {
        type: 'set_behavior_state_defaults',
        defaults: {
          workspace_mode: 'hero',
        },
      },
    );
  } else {
    patch.push({
      type: 'add_node',
      target: { parentId: 'hero-card' },
      node: {
        id: `note-${Math.random().toString(36).slice(2, 8)}`,
        type: 'text',
        props: {
          text: `New refinement: ${prompt}`,
        },
        styleTokens: {
          color: accents.accent,
          padding: '6px 0 0',
        },
        children: [],
      },
    });
  }

  return {
    assistantText: hasContent
      ? 'I added another refinement to the current canvas and kept the structure intact.'
      : 'I turned the blank canvas into a first structured layout and left room for further iteration.',
    changeSummary: hasContent ? 'Added one incremental content block.' : 'Created a hero card with supporting sections.',
    patch,
  };
}
