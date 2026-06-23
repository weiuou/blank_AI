import { summarizePageState, validatePatchOperations } from '../../src/shared/patches';
import type { PageNode, PagePatchOperation, PageState } from '../../src/shared/types';
import { imageRefPrefix, type ImageRefMap, type WorkflowToolResult, type WorkflowToolName } from './contracts';

export function findFirstNodeByType(node: PageNode, type: PageNode['type']): PageNode | undefined {
  if (node.type === type) {
    return node;
  }
  for (const child of node.children) {
    const match = findFirstNodeByType(child, type);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function findNodeById(node: PageNode, nodeId: string): PageNode | undefined {
  if (node.id === nodeId) {
    return node;
  }
  for (const child of node.children) {
    const match = findNodeById(child, nodeId);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function getExistingImageBackground(pageState: PageState): PageNode | undefined {
  return findFirstNodeByType(pageState.root, 'image_background');
}

export function inspectPageState(pageState: PageState): WorkflowToolResult {
  const nodes: Array<{
    id: string;
    type: PageNode['type'];
    label: string;
    editable: boolean;
    hasGeneratedCode: boolean;
    hasBackgroundImage: boolean;
  }> = [];

  function walk(node: PageNode): void {
    if (node.id !== 'root') {
      const label =
        typeof node.props.title === 'string'
          ? node.props.title
          : typeof node.props.label === 'string'
            ? node.props.label
            : typeof node.props.name === 'string'
              ? node.props.name
              : typeof node.props.text === 'string'
                ? node.props.text.slice(0, 60)
                : node.id;
      nodes.push({
        id: node.id,
        type: node.type,
        label,
        editable: node.type !== 'system_prompt' && node.type !== 'system_timeline',
        hasGeneratedCode: node.type === 'generated_react_component',
        hasBackgroundImage:
          typeof (node.props.mountProps as Record<string, unknown> | undefined)?.backgroundImage === 'string' ||
          typeof node.styleTokens.background === 'string',
      });
    }
    node.children.forEach(walk);
  }

  walk(pageState.root);
  return {
    ok: true,
    data: {
      summary: summarizePageState(pageState),
      nodes,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function getNodeLabel(node: PageNode): string {
  return (
    firstString(node.props.name, node.props.title, node.props.label, node.props.text) ??
    firstString(asRecord(node.props.mountProps).title, asRecord(node.props.mountProps).label) ??
    node.id
  );
}

function getNativeCategory(node: PageNode): string {
  if (node.type === 'system_prompt' || node.type === 'system_timeline') {
    return 'system';
  }
  if (node.type === 'button' || node.type === 'modal_trigger' || node.type === 'tabs' || node.type === 'accordion' || node.type === 'stepper') {
    return 'control';
  }
  if (node.type === 'input') {
    return 'input';
  }
  if (node.type === 'image' || node.type === 'image_background' || node.type === 'graffiti_word') {
    return 'media';
  }
  if (node.type === 'columns') {
    return 'layout';
  }
  if (node.type === 'list') {
    return 'data';
  }
  if (node.type === 'generated_react_component') {
    return 'unknown';
  }
  return 'display';
}

function getNodeCapabilities(node: PageNode): string[] {
  return arrayOfStrings(node.props.capabilities);
}

function getShortDescription(node: PageNode): string {
  const mountProps = asRecord(node.props.mountProps);
  const parts = [
    `${node.type}#${node.id}`,
    firstString(node.props.name, node.props.title, node.props.label, mountProps.title, mountProps.label),
    firstString(node.props.text),
    Object.keys(mountProps).length > 0 ? `mountProps keys: ${Object.keys(mountProps).slice(0, 10).join(', ')}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' | ').slice(0, 500);
}

export function listComponents(pageState: PageState): WorkflowToolResult {
  const components: Array<{
    id: string;
    type: PageNode['type'];
    name: string;
    category: string;
    archetype: string;
    position: number[];
    editable: boolean;
    capabilities: string[];
    shortDescription: string;
  }> = [];

  function walk(node: PageNode, position: number[]): void {
    if (node.id !== 'root') {
      const meta = asRecord(node.props.componentMeta);
      const name = getNodeLabel(node);
      components.push({
        id: node.id,
        type: node.type,
        name,
        category: firstString(meta.category) ?? getNativeCategory(node),
        archetype: firstString(meta.archetype) ?? node.type,
        position,
        editable: node.type !== 'system_prompt' && node.type !== 'system_timeline',
        capabilities: getNodeCapabilities(node),
        shortDescription: getShortDescription(node),
      });
    }
    node.children.forEach((child, index) => walk(child, [...position, index]));
  }

  walk(pageState.root, []);
  return {
    ok: true,
    data: {
      components,
    },
  };
}

export function getComponentDetail(pageState: PageState, nodeId: string): WorkflowToolResult {
  const node = findNodeById(pageState.root, nodeId);
  if (!node) {
    return { ok: false, error: `Component not found: ${nodeId}` };
  }

  return {
    ok: true,
    data: {
      id: node.id,
      type: node.type,
      name: getNodeLabel(node),
      props: {
        name: node.props.name,
        componentMeta: node.props.componentMeta,
        capabilities: node.props.capabilities,
        mountProps: node.props.mountProps,
        code: node.props.code,
      },
      styleTokens: node.styleTokens,
      behavior: node.behavior,
      children: node.children.map((child) => ({ id: child.id, type: child.type, name: getNodeLabel(child) })),
    },
  };
}

export function buildImagePrompt(prompt: string): string {
  return [
    'Create a clean website background image in a wide landscape composition.',
    'Do not include any UI, input boxes, buttons, panels, screenshots, browser chrome, or interface elements.',
    'The image will sit behind a minimal centered text input, so keep the central horizontal band slightly calmer and readable.',
    'Use pale low-contrast tones, white negative space, and sophisticated texture.',
    'If the user asks for letters or words, render the exact requested text clearly as part of the background artwork.',
    `User request: ${prompt}`,
  ].join('\n');
}

export function buildImageEditPrompt(prompt: string): string {
  return [
    'Edit the provided image as an existing website background, not as a brand-new scene.',
    'Preserve the original composition, palette, texture, negative space, visual style, and all existing artwork unless the user explicitly asks to change them.',
    'Apply only the requested incremental change, blending it naturally into the current background.',
    'Do not add UI, input boxes, buttons, panels, screenshots, browser chrome, or interface elements.',
    'Keep the central text-input area readable and avoid visually overwhelming the middle band.',
    `User requested incremental edit: ${prompt}`,
  ].join('\n');
}

export function buildComponentImagePrompt(prompt: string, targetNode?: PageNode): string {
  return [
    'Create a subtle component background image for a web UI element.',
    'The image will sit behind table/card content, so keep contrast low and avoid busy center details.',
    'Do not include UI controls, browser chrome, screenshots, text labels, or table grid lines.',
    'Use a polished modern visual texture that supports readable black text on top.',
    targetNode ? `Target component: ${targetNode.type}#${targetNode.id}` : '',
    `User request: ${prompt}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function addImageRef(imageRefs: ImageRefMap, imageDataUrl: string): string {
  const existingRef = [...imageRefs.entries()].find(([, existingDataUrl]) => existingDataUrl === imageDataUrl)?.[0];
  if (existingRef) {
    return existingRef;
  }

  const nextRef = `${imageRefPrefix}${imageRefs.size + 1}__`;
  imageRefs.set(nextRef, imageDataUrl);
  return nextRef;
}

export function replaceImageDataUrlsWithRefs(value: unknown, imageRefs: ImageRefMap): unknown {
  if (typeof value === 'string') {
    let nextValue = value;
    for (const [imageRef, imageDataUrl] of imageRefs) {
      nextValue = nextValue.split(imageDataUrl).join(imageRef);
    }
    return nextValue.replace(/data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/g, '[image-data-url-omitted]');
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceImageDataUrlsWithRefs(item, imageRefs));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, replaceImageDataUrlsWithRefs(nestedValue, imageRefs)]),
    );
  }

  return value;
}

export function restoreImageRefs(value: unknown, imageRefs: ImageRefMap): unknown {
  if (typeof value === 'string') {
    let nextValue = value;
    for (const [imageRef, imageDataUrl] of imageRefs) {
      nextValue = nextValue.split(imageRef).join(imageDataUrl);
    }
    return nextValue;
  }

  if (Array.isArray(value)) {
    return value.map((item) => restoreImageRefs(item, imageRefs));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, restoreImageRefs(nestedValue, imageRefs)]));
  }

  return value;
}

export function sanitizeToolResultsForModel(
  toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
  imageRefs: ImageRefMap,
): Array<{ tool: WorkflowToolName; result: WorkflowToolResult }> {
  return replaceImageDataUrlsWithRefs(toolResults, imageRefs) as Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>;
}

export function prepareComponentBackgroundPatch(pageState: PageState, targetNodeId: string, imageDataUrl: string): WorkflowToolResult {
  const targetNode = findNodeById(pageState.root, targetNodeId);
  if (!targetNode) {
    return { ok: false, error: `Target node not found: ${targetNodeId}` };
  }
  if (targetNode.type === 'system_prompt' || targetNode.type === 'system_timeline') {
    return { ok: false, error: 'System components cannot receive generated image backgrounds.' };
  }

  let operation: PagePatchOperation;
  if (targetNode.type === 'generated_react_component') {
    const mountProps =
      targetNode.props.mountProps && typeof targetNode.props.mountProps === 'object'
        ? { ...(targetNode.props.mountProps as Record<string, unknown>) }
        : {};
    operation = {
      type: 'update_node',
      nodeId: targetNode.id,
      props: {
        mountProps: {
          ...mountProps,
          backgroundImage: imageDataUrl,
        },
      },
      styleTokens: {
        ...targetNode.styleTokens,
        width: targetNode.styleTokens.width ?? 'min(860px, calc(100vw - 56px))',
        minHeight: targetNode.styleTokens.minHeight ?? '360px',
      },
    };
  } else {
    operation = {
      type: 'update_node',
      nodeId: targetNode.id,
      styleTokens: {
        background: `linear-gradient(rgba(255,255,255,0.54), rgba(255,255,255,0.64)), url(${imageDataUrl}) center / cover`,
        shadow: targetNode.styleTokens.shadow ?? '0 24px 70px rgba(20,20,20,0.1)',
      },
    };
  }

  return {
    ok: true,
    data: {
      targetNodeId,
      patch: [operation],
    },
  };
}

export function getCandidatePatch(toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>): PagePatchOperation[] | null {
  for (const item of [...toolResults].reverse()) {
    if (!item.result.ok || !item.result.data || typeof item.result.data !== 'object') {
      continue;
    }
    const patch = (item.result.data as { patch?: unknown }).patch;
    if (patch) {
      return validatePatchOperations(patch);
    }
  }
  return null;
}

export function findImageDataUrl(toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>): string | undefined {
  for (const item of [...toolResults].reverse()) {
    if (!item.result.ok || !item.result.data || typeof item.result.data !== 'object') {
      continue;
    }
    const imageDataUrl = (item.result.data as { imageDataUrl?: unknown }).imageDataUrl;
    if (typeof imageDataUrl === 'string') {
      return imageDataUrl;
    }
  }
  return undefined;
}
