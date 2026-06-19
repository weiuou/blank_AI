import { z } from 'zod';
import type { PageNode, PagePatchOperation, PageState } from './types';
import { pageNodeSchema, pagePatchOperationSchema } from './types';

const systemComponentTypes = new Set(['system_prompt', 'system_timeline']);
const hostCapabilities = ['sendPrompt', 'selectSnapshot', 'exportCanvasPng'] as const;
const generatedCodeMaxLength = 12_000;

const sharedPropsWhitelist: Record<string, z.ZodTypeAny> = {
  text: z.string().max(3000).optional(),
  label: z.string().max(240).optional(),
  placeholder: z.string().max(240).optional(),
  href: z.string().url().optional(),
  src: z.string().url().optional(),
  alt: z.string().max(240).optional(),
  title: z.string().max(240).optional(),
  subtitle: z.string().max(500).optional(),
  items: z.array(z.string().max(240)).max(12).optional(),
  columns: z.number().int().min(1).max(4).optional(),
  emphasis: z.enum(['default', 'muted', 'accent']).optional(),
};

function normalizeComponentProps(node: PageNode): void {
  const props = node.props as Record<string, unknown>;

  if ((node.type === 'button' || node.type === 'modal_trigger') && typeof props.label !== 'string' && typeof props.text === 'string') {
    props.label = props.text;
  }

  if (node.type === 'image' && typeof props.src === 'string' && props.src.startsWith('data:image/')) {
    node.type = 'image_background';
  }

  node.children.forEach(normalizeComponentProps);
}

const systemLayoutSchema = z
  .object({
    position: z.enum(['center', 'bottom', 'top', 'left', 'right']).optional(),
    dock: z.enum(['center', 'bottom', 'top', 'left', 'right']).optional(),
    width: z.string().max(80).optional(),
    maxWidth: z.string().max(80).optional(),
    offsetX: z.string().max(80).optional(),
    offsetY: z.string().max(80).optional(),
    orientation: z.enum(['vertical', 'horizontal']).optional(),
  })
  .strict();

const systemVisualSchema = z
  .object({
    variant: z.enum(['minimal', 'glass', 'solid']).optional(),
    opacity: z.number().min(0.22).max(1).optional(),
    radius: z.string().max(80).optional(),
    blur: z.string().max(80).optional(),
  })
  .strict();

const componentPropsSchemas: Record<string, z.ZodObject<Record<string, z.ZodTypeAny>>> = {
  section: z.object({
    layout: z.enum(['single', 'stack', 'hero']).optional(),
    ariaLabel: z.string().max(240).optional(),
  }),
  heading: z.object({
    text: z.string().max(200),
    level: z.number().int().min(1).max(4).optional(),
  }),
  text: z.object({
    text: z.string().max(2000),
  }),
  button: z.object({
    label: z.string().max(120),
    href: z.string().url().optional(),
    action: z.enum(['open_modal', 'none', 'exportCanvasPng']).optional(),
    targetId: z.string().optional(),
  }),
  input: z.object({
    label: z.string().max(120).optional(),
    placeholder: z.string().max(240).optional(),
    value: z.string().max(1000).optional(),
  }),
  card: z.object({
    title: z.string().max(200).optional(),
    subtitle: z.string().max(500).optional(),
  }),
  list: z.object({
    items: z.array(z.string().max(240)).max(12),
    ordered: z.boolean().optional(),
  }),
  image: z.object({
    src: z.string().url(),
    alt: z.string().max(240).optional(),
  }),
  image_background: z.object({
    src: z.string().max(8_000_000),
    alt: z.string().max(240).optional(),
  }),
  graffiti_word: z.object({
    text: z.string().max(24),
    variant: z.enum(['street', 'brush']).optional(),
    opacity: z.number().min(0).max(1).optional(),
  }),
  columns: z.object({
    columns: z.number().int().min(1).max(4),
  }),
  tabs: z.object({
    items: z.array(z.string().max(120)).min(1).max(6),
  }),
  accordion: z.object({
    items: z.array(z.string().max(120)).min(1).max(6),
  }),
  stepper: z.object({
    items: z.array(z.string().max(120)).min(1).max(6),
  }),
  modal_trigger: z.object({
    label: z.string().max(120),
    targetId: z.string().optional(),
  }),
  system_prompt: z.object({
    placeholder: z.string().max(240).optional(),
    layout: systemLayoutSchema.optional(),
    visual: systemVisualSchema.optional(),
  }),
  system_timeline: z.object({
    layout: systemLayoutSchema.optional(),
    visual: systemVisualSchema.optional(),
    showLabels: z.boolean().optional(),
  }),
  generated_react_component: z.object({
    name: z.string().min(1).max(80),
    code: z.string().min(1).max(generatedCodeMaxLength),
    mountProps: z.record(z.unknown()).optional(),
    capabilities: z.array(z.enum(hostCapabilities)).max(hostCapabilities.length).default([]),
  }),
};

for (const [key, schema] of Object.entries(componentPropsSchemas)) {
  componentPropsSchemas[key] = schema.extend(sharedPropsWhitelist).strict();
}

export function validatePatchOperations(rawPatch: unknown): PagePatchOperation[] {
  const patch = z.array(pagePatchOperationSchema).parse(rawPatch);
  assertPatchSafety(patch);
  return patch;
}

function cloneState(state: PageState): PageState {
  return structuredClone(state);
}

function findNode(node: PageNode, nodeId: string): PageNode | undefined {
  if (node.id === nodeId) {
    return node;
  }
  for (const child of node.children) {
    const match = findNode(child, nodeId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findParent(node: PageNode, nodeId: string): { parent: PageNode; index: number } | undefined {
  const index = node.children.findIndex((child: PageNode) => child.id === nodeId);
  if (index >= 0) {
    return { parent: node, index };
  }
  for (const child of node.children) {
    const match = findParent(child, nodeId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function assertValidComponentProps(node: PageNode): void {
  normalizeComponentProps(node);
  const schema = componentPropsSchemas[node.type];
  if (!schema) {
    throw new Error(`Unsupported component type: ${node.type}`);
  }
  node.props = schema.parse(node.props);
  node.children.forEach(assertValidComponentProps);
}

function assertPatchSafety(patch: PagePatchOperation[]): void {
  for (const operation of patch) {
    if (operation.type === 'add_node' && systemComponentTypes.has(operation.node.type)) {
      throw new Error(`System component cannot be added by AI: ${operation.node.type}`);
    }
    if (operation.type === 'remove_node' && operation.nodeId.startsWith('system-')) {
      throw new Error(`System component cannot be removed: ${operation.nodeId}`);
    }
    if (operation.type === 'move_node' && operation.nodeId.startsWith('system-') && operation.target.parentId !== 'root') {
      throw new Error(`System component must stay at root: ${operation.nodeId}`);
    }
  }
}

function sanitizeNode(node: PageNode): PageNode {
  const nextNode = pageNodeSchema.parse(structuredClone(node)) as PageNode;
  assertValidComponentProps(nextNode);
  return nextNode;
}

function insertChild(parent: PageNode, node: PageNode, index?: number): void {
  const insertIndex = typeof index === 'number' ? Math.min(index, parent.children.length) : parent.children.length;
  parent.children.splice(insertIndex, 0, node);
}

export function applyPatchOperations(state: PageState, patch: PagePatchOperation[]): PageState {
  const nextState = cloneState(state);
  assertPatchSafety(patch);

  for (const operation of patch) {
    switch (operation.type) {
      case 'add_node': {
        const parent = findNode(nextState.root, operation.target.parentId);
        if (!parent) {
          throw new Error(`Parent node not found: ${operation.target.parentId}`);
        }
        insertChild(parent, sanitizeNode(operation.node), operation.target.index);
        break;
      }
      case 'update_node': {
        const node = findNode(nextState.root, operation.nodeId);
        if (!node) {
          throw new Error(`Node not found: ${operation.nodeId}`);
        }
        if (operation.props) {
          node.props = {
            ...node.props,
            ...operation.props,
          };
        }
        if (operation.styleTokens) {
          node.styleTokens = {
            ...node.styleTokens,
            ...operation.styleTokens,
          };
        }
        if (operation.behavior) {
          node.behavior = operation.behavior;
        }
        assertValidComponentProps(node);
        break;
      }
      case 'remove_node': {
        const removableNode = findNode(nextState.root, operation.nodeId);
        if (operation.nodeId === 'root' || removableNode?.type === 'system_prompt' || removableNode?.type === 'system_timeline') {
          throw new Error('System/root nodes cannot be removed');
        }
        const parentMatch = findParent(nextState.root, operation.nodeId);
        if (!parentMatch) {
          throw new Error(`Node not found: ${operation.nodeId}`);
        }
        parentMatch.parent.children.splice(parentMatch.index, 1);
        break;
      }
      case 'move_node': {
        if (operation.nodeId === 'root') {
          throw new Error('Root node cannot be moved');
        }
        const movingNode = findNode(nextState.root, operation.nodeId);
        if ((movingNode?.type === 'system_prompt' || movingNode?.type === 'system_timeline') && operation.target.parentId !== 'root') {
          throw new Error('System components must stay at the root level');
        }
        const parentMatch = findParent(nextState.root, operation.nodeId);
        const targetParent = findNode(nextState.root, operation.target.parentId);
        if (!parentMatch || !targetParent) {
          throw new Error(`Unable to move node: ${operation.nodeId}`);
        }
        const [node] = parentMatch.parent.children.splice(parentMatch.index, 1);
        insertChild(targetParent, node, operation.target.index);
        break;
      }
      case 'set_theme_tokens': {
        nextState.theme = {
          ...nextState.theme,
          ...operation.theme,
        };
        break;
      }
      case 'set_behavior_state_defaults': {
        nextState.behaviorState = {
          ...nextState.behaviorState,
          ...operation.defaults,
        };
        break;
      }
      default: {
        throw new Error(`Unknown patch operation: ${String(operation)}`);
      }
    }
  }

  return nextState;
}

export function summarizePageState(state: PageState): string {
  const lines: string[] = [];

  function walk(node: PageNode, depth: number): void {
    if (node.id !== 'root') {
      const prefix = '  '.repeat(depth);
      const text =
        typeof node.props.text === 'string'
          ? node.props.text
          : typeof node.props.title === 'string'
            ? node.props.title
            : typeof node.props.label === 'string'
              ? node.props.label
              : '';
      lines.push(`${prefix}- ${node.type}#${node.id}${text ? `: ${text.slice(0, 80)}` : ''}`);
    }
    node.children.forEach((child: PageNode) => walk(child, depth + 1));
  }

  walk(state.root, 0);
  return lines.length > 0 ? lines.join('\n') : 'Empty canvas';
}
