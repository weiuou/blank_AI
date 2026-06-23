import { describe, expect, it } from 'vitest';
import { createInitialPageState } from './defaults';
import { applyPatchOperations } from './patches';
import type { PageNode, PagePatchOperation } from './types';

describe('applyPatchOperations', () => {
  it('adds nodes safely to the canvas', () => {
    const initial = createInitialPageState();
    const patch: PagePatchOperation[] = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'title-1',
          type: 'heading',
          props: { text: 'Hello world', level: 1 },
          styleTokens: {},
          children: [],
        },
      },
    ];

    const next = applyPatchOperations(initial, patch);
    const heading = next.root.children.find((node: PageNode) => node.id === 'title-1');
    expect(heading?.props.text).toBe('Hello world');
  });

  it('rejects nodes with unsupported props', () => {
    const initial = createInitialPageState();
    const patch: PagePatchOperation[] = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'bad-button',
          type: 'button',
          props: {
            label: 'Click',
            onClick: 'alert(1)',
          },
          styleTokens: {},
          children: [],
        },
      },
    ];

    expect(() => applyPatchOperations(initial, patch)).toThrow();
  });

  it('moves nodes between parents', () => {
    const initial = createInitialPageState();
    const patch: PagePatchOperation[] = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'container-a',
          type: 'section',
          props: { layout: 'stack' },
          styleTokens: {},
          children: [],
        },
      },
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'container-b',
          type: 'section',
          props: { layout: 'stack' },
          styleTokens: {},
          children: [],
        },
      },
      {
        type: 'add_node',
        target: { parentId: 'container-a' },
        node: {
          id: 'copy',
          type: 'text',
          props: { text: 'Move me' },
          styleTokens: {},
          children: [],
        },
      },
      {
        type: 'move_node',
        nodeId: 'copy',
        target: { parentId: 'container-b' },
      },
    ];

    const next = applyPatchOperations(initial, patch);
    const containerA = next.root.children.find((node: PageNode) => node.id === 'container-a');
    const containerB = next.root.children.find((node: PageNode) => node.id === 'container-b');
    expect(containerA?.children).toHaveLength(0);
    expect(containerB?.children[0]?.id).toBe('copy');
  });

  it('rejects removing system components', () => {
    const initial = createInitialPageState();
    const patch: PagePatchOperation[] = [
      {
        type: 'remove_node',
        nodeId: 'system-prompt',
      },
    ];

    expect(() => applyPatchOperations(initial, patch)).toThrow(/System/);
  });

  it('rejects empty update_node operations', () => {
    const initial = createInitialPageState();
    const patch = [{ type: 'update_node', nodeId: 'system-prompt' }] as unknown as PagePatchOperation[];
    const patchWithEmptyObjects = [
      {
        type: 'update_node',
        nodeId: 'system-prompt',
        props: {},
        styleTokens: {},
        behavior: {},
      },
    ] as unknown as PagePatchOperation[];

    expect(() => applyPatchOperations(initial, patch)).toThrow(/update_node requires props, styleTokens, or behavior/);
    expect(() => applyPatchOperations(initial, patchWithEmptyObjects)).toThrow(/update_node requires props, styleTokens, or behavior/);
  });

  it('accepts sandboxed generated React components with declared capabilities', () => {
    const initial = createInitialPageState();
    const patch: PagePatchOperation[] = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'generated-1',
          type: 'generated_react_component',
          props: {
            name: 'Demo',
            code: "return React.createElement('div', null, props.title)",
            mountProps: { title: 'Hello' },
            capabilities: ['sendPrompt'],
          },
          styleTokens: {},
          children: [],
        },
      },
    ];

    const next = applyPatchOperations(initial, patch);
    expect(next.root.children.find((node: PageNode) => node.id === 'generated-1')?.type).toBe('generated_react_component');
  });

  it('accepts safe positioning style tokens for generated components', () => {
    const initial = createInitialPageState();
    const patch: PagePatchOperation[] = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'positioned-calendar',
          type: 'generated_react_component',
          props: {
            name: 'PositionedCalendar',
            code: "return React.createElement('section', null, 'Calendar')",
            mountProps: {},
            capabilities: [],
          },
          styleTokens: {
            position: 'fixed',
            top: '24px',
            left: '24px',
            width: 'min(360px, calc(100vw - 48px))',
            maxWidth: '360px',
            minHeight: '320px',
            zIndex: '10',
          },
          children: [],
        },
      },
    ] as unknown as PagePatchOperation[];

    const next = applyPatchOperations(initial, patch);
    const calendar = next.root.children.find((node: PageNode) => node.id === 'positioned-calendar');
    expect(calendar?.styleTokens).toMatchObject({
      position: 'fixed',
      top: '24px',
      left: '24px',
      maxWidth: '360px',
      zIndex: 10,
    });
  });

  it('accepts common CSS properties and normalizes button text labels', () => {
    const initial = createInitialPageState();
    const patch = [
      {
        type: 'add_node',
        target: { parentId: 'root', index: 1 },
        node: {
          id: 'todo-panel',
          type: 'card',
          props: { title: 'TODO', subtitle: '待办事项' },
          styleTokens: {
            position: 'fixed',
            top: '24px',
            left: '380px',
            width: '280px',
            minHeight: '320px',
            padding: '20px',
            borderRadius: '20px',
            background: '#ffffff',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: '20',
          },
          children: [
            {
              id: 'todo-list',
              type: 'list',
              props: { items: ['完成本月计划', '安排会议'] },
              styleTokens: { marginTop: '12px' },
              children: [],
            },
            {
              id: 'todo-button',
              type: 'button',
              props: { text: '添加' },
              styleTokens: { marginTop: '12px', width: '100%' },
              children: [],
            },
          ],
        },
      },
    ] as unknown as PagePatchOperation[];

    const next = applyPatchOperations(initial, patch);
    const panel = next.root.children.find((node: PageNode) => node.id === 'todo-panel');
    const button = panel?.children.find((node: PageNode) => node.id === 'todo-button');

    expect(panel?.styleTokens).toMatchObject({
      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      borderRadius: '20px',
      zIndex: 20,
    });
    expect(panel?.children[0]?.styleTokens.marginTop).toBe('12px');
    expect(button?.props.label).toBe('添加');
  });

  it('accepts expressive CSS style tokens without a narrow whitelist', () => {
    const initial = createInitialPageState();
    const patch = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'expressive-panel',
          type: 'card',
          props: { title: 'Expressive CSS' },
          styleTokens: {
            position: 'fixed',
            inset: '24px auto auto 24px',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            placeItems: 'center',
            backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.7), rgba(180,220,255,0.42)), url(data:image/png;base64,abc123)',
            backgroundSize: 'cover',
            backdropFilter: 'blur(18px) saturate(1.2)',
            '-webkit-backdrop-filter': 'blur(18px) saturate(1.2)',
            clipPath: 'polygon(0 0, 100% 4%, 96% 100%, 3% 96%)',
            mixBlendMode: 'multiply',
            '--accent-ink': '#1f5eff',
            zIndex: '999',
            opacity: 'var(--panel-opacity, 0.92)',
          },
          children: [],
        },
      },
    ] as unknown as PagePatchOperation[];

    const next = applyPatchOperations(initial, patch);
    const panel = next.root.children.find((node: PageNode) => node.id === 'expressive-panel');

    expect(panel?.styleTokens).toMatchObject({
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
      backdropFilter: 'blur(18px) saturate(1.2)',
      WebkitBackdropFilter: 'blur(18px) saturate(1.2)',
      '--accent-ink': '#1f5eff',
      zIndex: 999,
      opacity: 'var(--panel-opacity, 0.92)',
    });
  });

  it('normalizes kebab-case CSS style tokens before applying patches', () => {
    const initial = createInitialPageState();
    const patch = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'kebab-panel',
          type: 'card',
          props: { title: 'Kebab CSS' },
          styleTokens: {
            'border-radius': '22px',
            'box-shadow': '0 12px 40px rgba(0,0,0,0.1)',
            'text-align': 'center',
            'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
            '-webkit-backdrop-filter': 'blur(12px)',
          },
          children: [],
        },
      },
    ] as unknown as PagePatchOperation[];

    const next = applyPatchOperations(initial, patch);
    const panel = next.root.children.find((node: PageNode) => node.id === 'kebab-panel');

    expect(panel?.styleTokens).toMatchObject({
      radius: '22px',
      borderRadius: '22px',
      shadow: '0 12px 40px rgba(0,0,0,0.1)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.1)',
      align: 'center',
      textAlign: 'center',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      WebkitBackdropFilter: 'blur(12px)',
    });
  });

  it('rejects unsafe CSS values and prototype-polluting style keys', () => {
    const initial = createInitialPageState();
    const patchWithScriptUrl = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'unsafe-style',
          type: 'card',
          props: { title: 'Unsafe' },
          styleTokens: {
            backgroundImage: 'url(javascript:alert(1))',
          },
          children: [],
        },
      },
    ] as unknown as PagePatchOperation[];

    const patchWithPrototypeKey = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'unsafe-key',
          type: 'card',
          props: { title: 'Unsafe' },
          styleTokens: {
            constructor: 'polluted',
          },
          children: [],
        },
      },
    ] as unknown as PagePatchOperation[];

    expect(() => applyPatchOperations(initial, patchWithScriptUrl)).toThrow(/Unsafe CSS value/);
    expect(() => applyPatchOperations(initial, patchWithPrototypeKey)).toThrow(/Unsafe CSS property name/);
  });

  it('rejects generated components with unknown capabilities', () => {
    const initial = createInitialPageState();
    const patch: PagePatchOperation[] = [
      {
        type: 'add_node',
        target: { parentId: 'root' },
        node: {
          id: 'generated-1',
          type: 'generated_react_component',
          props: {
            name: 'Demo',
            code: "return React.createElement('div')",
            capabilities: ['readCookies'],
          },
          styleTokens: {},
          children: [],
        },
      },
    ] as unknown as PagePatchOperation[];

    expect(() => applyPatchOperations(initial, patch)).toThrow();
  });
});
