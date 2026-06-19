import OpenAI from 'openai';
import { z } from 'zod';
import { defaultTheme } from '../src/shared/defaults';
import { applyPatchOperations, summarizePageState, validatePatchOperations } from '../src/shared/patches';
import type { AiMessageResponse, ConversationMessage, PageNode, PagePatchOperation, PageState } from '../src/shared/types';
import { aiMessageResponseSchema } from '../src/shared/types';
import { getLogContext, logLine } from './logger';

const openAiPatchResponseSchema = z.object({
  assistantText: z.string(),
  changeSummary: z.string(),
  patchJson: z.string(),
});

type PatchResponseDraft = z.infer<typeof openAiPatchResponseSchema>;

const workflowPlanSchema = z
  .object({
    reasoning: z.string(),
    target: z.enum(['page_background', 'component', 'none']),
    targetNodeId: z.string().optional(),
    needsImage: z.boolean(),
    imagePrompt: z.string().optional(),
    shouldEditExistingImage: z.boolean().default(false),
    shouldRewriteComponentCode: z.boolean().default(false),
  })
  .strict();

type WorkflowPlan = z.infer<typeof workflowPlanSchema>;

type WorkflowToolName = 'inspect_page_state' | 'generate_image' | 'edit_image' | 'prepare_component_background_patch';

type WorkflowToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

type AiRequestContext = {
  requestId?: string;
};

type WorkflowTraceStep =
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; tool: WorkflowToolName; input: unknown }
  | { type: 'tool_result'; tool: WorkflowToolName; ok: boolean; summary: string }
  | { type: 'final_patch'; summary: string; patchCount: number };

type ImageRefMap = Map<string, string>;

const modelResponseSchema = {
  type: 'json_schema',
  name: 'blank_ai_patch_response',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['assistantText', 'changeSummary', 'patchJson'],
    properties: {
      assistantText: { type: 'string' },
      changeSummary: { type: 'string' },
      patchJson: { type: 'string' },
    },
  },
} as const;

const workflowPlanResponseSchema = {
  type: 'json_schema',
  name: 'blank_ai_workflow_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'reasoning',
      'target',
      'targetNodeId',
      'needsImage',
      'imagePrompt',
      'shouldEditExistingImage',
      'shouldRewriteComponentCode',
    ],
    properties: {
      reasoning: { type: 'string' },
      target: { type: 'string', enum: ['page_background', 'component', 'none'] },
      targetNodeId: { type: ['string', 'null'] },
      needsImage: { type: 'boolean' },
      imagePrompt: { type: ['string', 'null'] },
      shouldEditExistingImage: { type: 'boolean' },
      shouldRewriteComponentCode: { type: 'boolean' },
    },
  },
} as const;

let openaiClient: OpenAI | null = null;

const defaultBaseUrl = 'https://cpa.weiuou.art';
const defaultModel = 'gpt-5';
const defaultImageModel = 'gpt-image-2';
const defaultImageSize = '1024x768';
const defaultTextTimeoutMs = 70_000;
const defaultImageTimeoutMs = 120_000;
const defaultPatchRepairAttempts = 2;
const imageRefPrefix = '__workflow_image_';
const patchProtocolPrompt = [
  'PATCH PROTOCOL CONTRACT:',
  'Return patchJson as JSON.stringify(array) using ONLY this app-specific protocol.',
  'Each operation MUST use a "type" field. Never use "op", "path", "value", "operation", "action", or RFC6902 JSON Patch fields.',
  'styleTokens are permissive React/CSS style objects: use normal camelCase CSS such as borderRadius, boxShadow, backdropFilter, gridTemplateColumns, backgroundImage, filter, clipPath, animation, and CSS variables when useful. Kebab-case CSS keys are also accepted and normalized. Do not use javascript:, vbscript:, expression(), @import, or HTML/script data URLs.',
  'Allowed operation shapes:',
  '{"type":"add_node","target":{"parentId":"root","index":0},"node":{"id":"example","type":"card","props":{"title":"Example"},"styleTokens":{},"children":[]}}',
  '{"type":"update_node","nodeId":"example","props":{"title":"Updated"}}',
  '{"type":"remove_node","nodeId":"example"}',
  '{"type":"move_node","nodeId":"example","target":{"parentId":"root","index":0}}',
  '{"type":"set_theme_tokens","theme":{"pageBackground":"#ffffff"}}',
  '{"type":"set_behavior_state_defaults","defaults":{"key":"value"}}',
  'Before responding, self-check every patch item: it has "type"; it does not have "op"; add_node has target and node; update_node has nodeId.',
].join('\n');

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function shouldLogAiHttp(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.AI_DEBUG_HTTP !== 'false';
}

function shouldLogAiWorkflow(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.AI_DEBUG_WORKFLOW !== 'false';
}

function sanitizeForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return `[image-data-url length=${value.length}]`;
    }
    return value.length > 800 ? `${value.slice(0, 800)}...[truncated ${value.length - 800}]` : value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForLog);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, sanitizeForLog(nestedValue)]));
  }

  return value;
}

function logWorkflow(workflowId: string, event: string, data: Record<string, unknown> = {}): void {
  if (!shouldLogAiWorkflow()) {
    return;
  }
  logLine(`[ai:workflow:${workflowId}] ${event} ${JSON.stringify(sanitizeForLog(data))}`);
}

function summarizeRequestUrl(url: RequestInfo | URL): string {
  const rawUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return rawUrl;
  }
}

function extractRequestModel(init?: RequestInit): string {
  if (typeof init?.body !== 'string') {
    return '<multipart-or-empty>';
  }

  try {
    const parsed = JSON.parse(init.body) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : '<missing>';
  } catch {
    return '<unreadable>';
  }
}

function createLoggedFetch(): typeof fetch {
  return async (url, init) => {
    const startedAt = Date.now();
    const method = init?.method ?? 'GET';
    const path = summarizeRequestUrl(url);
    const model = extractRequestModel(init);
    const requestId = getLogContext().requestId ?? 'noctx';
    logLine(`[ai:http:${requestId}:start] ${method} ${path} model=${model}`);

    try {
      const response = await fetch(url, init);
      logLine(`[ai:http:${requestId}:end] ${method} ${path} model=${model} status=${response.status} durationMs=${Date.now() - startedAt}`);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(`[ai:http:${requestId}:error] ${method} ${path} model=${model} durationMs=${Date.now() - startedAt} error=${message}`);
      throw error;
    }
  };
}

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'test' || process.env.USE_AI_MOCK === 'true') {
      throw new Error('AI_MOCK_ENABLED');
    }
    throw new Error('Missing OPENAI_API_KEY. Add it to .env before calling the AI endpoint.');
  }
  openaiClient ??= new OpenAI({
    apiKey,
    baseURL: normalizeBaseUrl(process.env.OPENAI_BASE_URL ?? defaultBaseUrl),
    fetch: shouldLogAiHttp() ? createLoggedFetch() : undefined,
    maxRetries: 0,
    timeout: Number(process.env.OPENAI_TEXT_TIMEOUT_MS ?? defaultTextTimeoutMs),
  });
  return openaiClient;
}

function getRequiredApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV === 'test' || process.env.USE_AI_MOCK === 'true') {
      throw new Error('AI_MOCK_ENABLED');
    }
    throw new Error('Missing OPENAI_API_KEY. Add it to .env before calling the AI endpoint.');
  }
  return apiKey;
}

function getOpenAiBaseUrl(): string {
  return normalizeBaseUrl(process.env.OPENAI_BASE_URL ?? defaultBaseUrl);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Image request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseImageResponse(response: Response): Promise<string> {
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(formatImageEndpointError(response.status, responseText));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error('Image endpoint returned non-JSON response.');
  }

  const data = (parsed as { data?: Array<{ b64_json?: unknown; url?: unknown }> }).data;
  const base64 = data?.[0]?.b64_json;
  if (typeof base64 === 'string' && base64.length > 0) {
    return `data:image/png;base64,${base64}`;
  }

  throw new Error('Image model did not return base64 image data.');
}

function textFromHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatImageEndpointError(status: number, responseText: string): string {
  if (!responseText) {
    return `${status} status code (no body)`;
  }

  const cleaned = responseText.includes('<') ? textFromHtml(responseText) : responseText.replace(/\s+/g, ' ').trim();
  const preview = cleaned.slice(0, 240);
  if (status === 504) {
    return `504 Gateway Timeout from image endpoint after the upstream gateway waited too long${preview ? `: ${preview}` : ''}`;
  }
  if (status === 502) {
    return `502 Bad Gateway from image endpoint${preview ? `: ${preview}` : ''}`;
  }
  return `${status} status code from image endpoint${preview ? `: ${preview}` : ''}`;
}

function isRetryableImageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:502|504|gateway|timed out|timeout|fetch failed|network)/i.test(message);
}

function buildFastFallbackImagePrompt(imagePrompt: string): string {
  const userRequest = imagePrompt.includes('User request:') ? imagePrompt.split('User request:').pop()?.trim() : imagePrompt;
  return [
    'Fast generation request: create a simpler low-complexity website background.',
    'Use broad shapes, fewer tiny details, clean negative space, and a calm center band for UI readability.',
    'Do not include UI, screenshots, text, buttons, input boxes, logos, or browser chrome.',
    `User request: ${userRequest ?? imagePrompt}`,
  ].join('\n');
}

function logDirectImageRequest(event: 'start' | 'end' | 'error', data: Record<string, unknown>): void {
  if (!shouldLogAiHttp()) {
    return;
  }
  const requestId = getLogContext().requestId ?? 'noctx';
  logLine(`[ai:http:${requestId}:${event}] ${JSON.stringify(sanitizeForLog(data))}`);
}

function inferAccent(prompt: string): { accent: string; accentSoft: string } {
  const normalized = prompt.toLowerCase();
  if (normalized.includes('ocean') || normalized.includes('blue')) {
    return { accent: '#0057ff', accentSoft: '#e9f0ff' };
  }
  if (normalized.includes('warm') || normalized.includes('orange') || normalized.includes('sunset')) {
    return { accent: '#c45a1e', accentSoft: '#fff1e8' };
  }
  if (normalized.includes('green') || normalized.includes('nature')) {
    return { accent: '#1c7c54', accentSoft: '#eaf8ef' };
  }
  return { accent: '#111111', accentSoft: '#ececec' };
}

function extractGraffitiWord(prompt: string): string {
  const quotedMatch = prompt.match(/[“"']([^”"']{1,24})[”"']/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const asciiMatch = prompt.match(/\b[A-Za-z][A-Za-z0-9_-]{1,23}\b/);
  return asciiMatch?.[0] ?? 'Weiuou';
}

function wantsGraffitiBackground(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('graffiti') ||
    normalized.includes('street') ||
    normalized.includes('涂鸦') ||
    normalized.includes('街头')
  );
}

function wantsGeneratedImageBackground(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('background') ||
    normalized.includes('image') ||
    normalized.includes('poster') ||
    normalized.includes('graffiti') ||
    normalized.includes('street') ||
    normalized.includes('背景') ||
    normalized.includes('图片') ||
    normalized.includes('海报') ||
    normalized.includes('涂鸦') ||
    normalized.includes('街头')
  );
}

function wantsVisualEdit(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    wantsGeneratedImageBackground(prompt) ||
    normalized.includes('icon') ||
    normalized.includes('logo') ||
    normalized.includes('sticker') ||
    normalized.includes('illustration') ||
    normalized.includes('draw') ||
    normalized.includes('color') ||
    normalized.includes('blue') ||
    normalized.includes('red') ||
    normalized.includes('green') ||
    normalized.includes('brighter') ||
    normalized.includes('darker') ||
    normalized.includes('lighter') ||
    normalized.includes('bigger') ||
    normalized.includes('smaller') ||
    normalized.includes('remove') ||
    normalized.includes('delete') ||
    normalized.includes('minecraft') ||
    normalized.includes('图标') ||
    normalized.includes('标志') ||
    normalized.includes('贴纸') ||
    normalized.includes('插画') ||
    normalized.includes('画') ||
    normalized.includes('颜色') ||
    normalized.includes('更蓝') ||
    normalized.includes('更红') ||
    normalized.includes('更绿') ||
    normalized.includes('更亮') ||
    normalized.includes('更暗') ||
    normalized.includes('变大') ||
    normalized.includes('变小') ||
    normalized.includes('删掉') ||
    normalized.includes('删除') ||
    normalized.includes('去掉') ||
    normalized.includes('移除') ||
    normalized.includes('修改') ||
    normalized.includes('换成') ||
    normalized.includes('加一个') ||
    normalized.includes('加个') ||
    normalized.includes('添加') ||
    normalized.includes('放一个') ||
    normalized.includes('放个') ||
    normalized.includes('中间')
  );
}

function wantsGeneratedComponent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('component') ||
    normalized.includes('widget') ||
    normalized.includes('react') ||
    normalized.includes('组件') ||
    normalized.includes('生成一个') ||
    normalized.includes('做一个')
  );
}

function wantsPromptMovedBottom(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    (normalized.includes('input') || normalized.includes('输入框')) &&
    (normalized.includes('bottom') || normalized.includes('下方') || normalized.includes('底部'))
  );
}

function wantsTimelineLeft(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    (normalized.includes('timeline') || normalized.includes('时间轴')) &&
    (normalized.includes('left') || normalized.includes('左侧') || normalized.includes('左边'))
  );
}

function wantsRepairOnly(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('fix') ||
    normalized.includes('broken') ||
    normalized.includes('not working') ||
    normalized.includes('does not work') ||
    normalized.includes('用不了') ||
    normalized.includes('不能用') ||
    normalized.includes('没反应') ||
    normalized.includes('修复') ||
    normalized.includes('修一下') ||
    normalized.includes('坏了')
  );
}

function wantsPositionChange(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('move') ||
    normalized.includes('position') ||
    normalized.includes('top') ||
    normalized.includes('bottom') ||
    normalized.includes('left') ||
    normalized.includes('right') ||
    normalized.includes('center') ||
    normalized.includes('移动') ||
    normalized.includes('挪') ||
    normalized.includes('位置') ||
    normalized.includes('上半') ||
    normalized.includes('下半') ||
    normalized.includes('顶部') ||
    normalized.includes('底部') ||
    normalized.includes('左边') ||
    normalized.includes('右边') ||
    normalized.includes('左侧') ||
    normalized.includes('右侧') ||
    normalized.includes('中间') ||
    normalized.includes('居中') ||
    normalized.includes('正中')
  );
}

function findFirstNodeByType(node: PageNode, type: PageNode['type']): PageNode | undefined {
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

function findNodeById(node: PageNode, nodeId: string): PageNode | undefined {
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

function getExistingImageBackground(pageState: PageState): PageNode | undefined {
  return findFirstNodeByType(pageState.root, 'image_background');
}

function inspectPageState(pageState: PageState): WorkflowToolResult {
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

function buildImagePrompt(prompt: string): string {
  return [
    'Create a clean website background image in a wide landscape composition.',
    'Do not include any UI, input boxes, buttons, panels, screenshots, browser chrome, or interface elements.',
    'The image will sit behind a minimal centered text input, so keep the central horizontal band slightly calmer and readable.',
    'Use pale low-contrast tones, white negative space, and sophisticated texture.',
    'If the user asks for letters or words, render the exact requested text clearly as part of the background artwork.',
    `User request: ${prompt}`,
  ].join('\n');
}

function buildImageEditPrompt(prompt: string): string {
  return [
    'Edit the provided image as an existing website background, not as a brand-new scene.',
    'Preserve the original composition, palette, texture, negative space, visual style, and all existing artwork unless the user explicitly asks to change them.',
    'Apply only the requested incremental change, blending it naturally into the current background.',
    'Do not add UI, input boxes, buttons, panels, screenshots, browser chrome, or interface elements.',
    'Keep the central text-input area readable and avoid visually overwhelming the middle band.',
    `User requested incremental edit: ${prompt}`,
  ].join('\n');
}

function buildComponentImagePrompt(prompt: string, targetNode?: PageNode): string {
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

function addImageRef(imageRefs: ImageRefMap, imageDataUrl: string): string {
  const existingRef = [...imageRefs.entries()].find(([, existingDataUrl]) => existingDataUrl === imageDataUrl)?.[0];
  if (existingRef) {
    return existingRef;
  }

  const nextRef = `${imageRefPrefix}${imageRefs.size + 1}__`;
  imageRefs.set(nextRef, imageDataUrl);
  return nextRef;
}

function replaceImageDataUrlsWithRefs(value: unknown, imageRefs: ImageRefMap): unknown {
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

function restoreImageRefs(value: unknown, imageRefs: ImageRefMap): unknown {
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

function sanitizeToolResultsForModel(
  toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
  imageRefs: ImageRefMap,
): Array<{ tool: WorkflowToolName; result: WorkflowToolResult }> {
  return replaceImageDataUrlsWithRefs(toolResults, imageRefs) as Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>;
}

function normalizeLegacyPatchOperations(rawPatch: unknown): unknown {
  if (!Array.isArray(rawPatch)) {
    return rawPatch;
  }

  return rawPatch.map((operation) => {
    if (!operation || typeof operation !== 'object' || !('op' in operation)) {
      return operation;
    }

    const legacy = operation as Record<string, unknown>;
    if (legacy.op === 'add_node') {
      return {
        type: 'add_node',
        target:
          legacy.target && typeof legacy.target === 'object'
            ? legacy.target
            : {
                parentId: typeof legacy.parentId === 'string' ? legacy.parentId : 'root',
                ...(typeof legacy.index === 'number' ? { index: legacy.index } : {}),
              },
        node: legacy.node,
      };
    }

    if (legacy.op === 'update_node') {
      return {
        type: 'update_node',
        nodeId: legacy.nodeId,
        props: legacy.props,
        styleTokens: legacy.styleTokens,
        behavior: legacy.behavior,
      };
    }

    if (legacy.op === 'remove_node') {
      return {
        type: 'remove_node',
        nodeId: legacy.nodeId,
      };
    }

    if (legacy.op === 'move_node') {
      return {
        type: 'move_node',
        nodeId: legacy.nodeId,
        target: legacy.target,
      };
    }

    if (legacy.op === 'set_theme_tokens') {
      return {
        type: 'set_theme_tokens',
        theme: legacy.theme,
      };
    }

    if (legacy.op === 'set_behavior_state_defaults') {
      return {
        type: 'set_behavior_state_defaults',
        defaults: legacy.defaults,
      };
    }

    return operation;
  });
}

function collectNodesById(root: PageNode): Map<string, PageNode> {
  const nodes = new Map<string, PageNode>();

  function walk(node: PageNode): void {
    nodes.set(node.id, node);
    node.children.forEach(walk);
  }

  walk(root);
  return nodes;
}

function getNodeIdFromPatchOperation(operation: PagePatchOperation): string | undefined {
  if (operation.type === 'update_node' || operation.type === 'remove_node' || operation.type === 'move_node') {
    return operation.nodeId;
  }
  return undefined;
}

function getRepairTargetIds(pageState: PageState, plan: WorkflowPlan, patch: PagePatchOperation[]): Set<string> {
  const existingNodes = collectNodesById(pageState.root);
  const targetIds = new Set<string>();

  if (plan.targetNodeId && existingNodes.has(plan.targetNodeId)) {
    targetIds.add(plan.targetNodeId);
  }

  for (const operation of patch) {
    const nodeId = getNodeIdFromPatchOperation(operation);
    const node = nodeId ? existingNodes.get(nodeId) : undefined;
    if (node?.type === 'generated_react_component') {
      targetIds.add(node.id);
    }
  }

  if (targetIds.size === 0) {
    const generatedNodes = [...existingNodes.values()].filter((node) => node.type === 'generated_react_component');
    if (generatedNodes.length === 1) {
      targetIds.add(generatedNodes[0].id);
    }
  }

  return targetIds;
}

function mergeMountPropsPreservingLayout(
  existingMountProps: unknown,
  nextMountProps: unknown,
): Record<string, unknown> | undefined {
  if (!nextMountProps || typeof nextMountProps !== 'object' || Array.isArray(nextMountProps)) {
    return undefined;
  }

  const existing =
    existingMountProps && typeof existingMountProps === 'object' && !Array.isArray(existingMountProps)
      ? (existingMountProps as Record<string, unknown>)
      : {};
  const next = nextMountProps as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...existing,
    ...next,
  };

  for (const key of ['layout', 'position', 'placement', 'dock']) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      merged[key] = existing[key];
    } else if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete merged[key];
    }
  }

  return merged;
}

function stabilizePatchForRepairOnly(
  prompt: string,
  pageState: PageState,
  plan: WorkflowPlan,
  patch: PagePatchOperation[],
): PagePatchOperation[] {
  if (!wantsRepairOnly(prompt) || wantsPositionChange(prompt)) {
    return patch;
  }

  const existingNodes = collectNodesById(pageState.root);
  const targetIds = getRepairTargetIds(pageState, plan, patch);
  if (targetIds.size === 0) {
    return patch;
  }

  return validatePatchOperations(
    patch.flatMap((operation): PagePatchOperation[] => {
      if (operation.type === 'move_node' && targetIds.has(operation.nodeId)) {
        return [];
      }

      if (operation.type !== 'update_node' || !targetIds.has(operation.nodeId)) {
        return [operation];
      }

      const existingNode = existingNodes.get(operation.nodeId);
      if (!existingNode) {
        return [operation];
      }

      const nextOperation: PagePatchOperation = {
        ...operation,
        styleTokens: operation.styleTokens ? { ...existingNode.styleTokens } : undefined,
      };

      if (operation.props) {
        nextOperation.props = { ...operation.props };
        const nextMountProps = mergeMountPropsPreservingLayout(existingNode.props.mountProps, operation.props.mountProps);
        if (nextMountProps) {
          nextOperation.props.mountProps = nextMountProps;
        }
      }

      return [nextOperation];
    }),
  );
}

function stabilizeResponseForRepairOnly(
  prompt: string,
  pageState: PageState,
  plan: WorkflowPlan,
  response: AiMessageResponse,
): AiMessageResponse {
  const patch = stabilizePatchForRepairOnly(prompt, pageState, plan, response.patch);
  return aiMessageResponseSchema.parse({
    ...response,
    patch,
  });
}

function buildRepairOnlyInstruction(prompt: string): string {
  if (!wantsRepairOnly(prompt) || wantsPositionChange(prompt)) {
    return '';
  }

  return [
    'Repair-only constraint for this user request:',
    'The user is reporting something broken or unusable, not asking for a visual/layout redesign.',
    'Fix component code, props, missing capabilities, or interaction behavior only.',
    'Do not move the target component, do not change its styleTokens, and do not change mountProps layout/position/placement/dock unless the user explicitly asks for position changes.',
  ].join('\n');
}

function parseModelPatchJson(patchJson: string): PagePatchOperation[] {
  const rawPatch = JSON.parse(patchJson);
  try {
    return validatePatchOperations(rawPatch);
  } catch (initialError) {
    const normalizedPatch = normalizeLegacyPatchOperations(rawPatch);
    const validatedPatch = validatePatchOperations(normalizedPatch);
    if (process.env.NODE_ENV !== 'test') {
      logLine(
        `[ai:patch_normalized] ${JSON.stringify(
          sanitizeForLog({
            reason: initialError instanceof Error ? initialError.message : String(initialError),
            operationCount: validatedPatch.length,
          }),
        )}`,
      );
    }
    return validatedPatch;
  }
}

function getPatchValidationErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function collectGeneratedComponentNodes(node: PageNode, nodes: PageNode[] = []): PageNode[] {
  if (node.type === 'generated_react_component') {
    nodes.push(node);
  }
  node.children.forEach((child) => collectGeneratedComponentNodes(child, nodes));
  return nodes;
}

function collectTouchedGeneratedComponentIds(patch: PagePatchOperation[], nextState: PageState): Set<string> {
  const ids = new Set<string>();
  for (const operation of patch) {
    if (operation.type === 'add_node') {
      collectGeneratedComponentNodes(operation.node).forEach((node) => ids.add(node.id));
      continue;
    }

    if (operation.type === 'update_node') {
      const updatedNode = findNodeById(nextState.root, operation.nodeId);
      if (updatedNode?.type === 'generated_react_component') {
        ids.add(updatedNode.id);
      }
    }
  }
  return ids;
}

function assertGeneratedComponentCodeCompiles(node: PageNode): void {
  if (node.type !== 'generated_react_component') {
    return;
  }

  const code = node.props.code;
  if (typeof code !== 'string' || code.trim() === '') {
    throw new Error(`Generated component ${node.id} is missing code.`);
  }

  try {
    new Function('React', 'props', 'theme', 'system', 'sdk', `"use strict";\n${code}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Generated component ${node.id} code does not compile: ${message}`);
  }
}

function assertPatchCanBeApplied(pageState: PageState, patch: PagePatchOperation[]): PageState {
  const nextState = applyPatchOperations(pageState, validatePatchOperations(patch));
  const touchedGeneratedIds = collectTouchedGeneratedComponentIds(patch, nextState);
  for (const nodeId of touchedGeneratedIds) {
    const node = findNodeById(nextState.root, nodeId);
    if (node) {
      assertGeneratedComponentCodeCompiles(node);
    }
  }
  return nextState;
}

function parseAndPreflightPatchResponse(pageState: PageState, draft: PatchResponseDraft): AiMessageResponse {
  let patch: PagePatchOperation[];
  try {
    patch = parseModelPatchJson(draft.patchJson);
    assertPatchCanBeApplied(pageState, patch);
  } catch (error) {
    throw new Error(`AI returned an invalid page patch: ${getPatchValidationErrorMessage(error)}`);
  }

  return aiMessageResponseSchema.parse({
    assistantText: draft.assistantText,
    changeSummary: draft.changeSummary,
    patch,
  });
}

function preflightAiMessageResponse(pageState: PageState, response: AiMessageResponse): AiMessageResponse {
  assertPatchCanBeApplied(pageState, response.patch);
  return aiMessageResponseSchema.parse(response);
}

async function repairPatchResponseDraft(
  client: OpenAI,
  args: {
    prompt: string;
    pageState: PageState;
    transcript: string;
    plan: WorkflowPlan;
    previousDraft: PatchResponseDraft;
    validationError: string;
    extraContext?: string;
  },
): Promise<PatchResponseDraft> {
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? defaultModel,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              'You are repairing a failed page patch for a controlled React page builder. Return only assistantText, changeSummary, and patchJson using the same JSON schema. Do not apologize, do not explain outside the fields, and do not output raw HTML.\n\n' +
              patchProtocolPrompt +
              '\n\nRepair requirements: fix every validation error, preserve the user intent, keep the change incremental, and ensure every generated_react_component code string is syntactically valid JavaScript function-body code for new Function("React","props","theme","system","sdk", code). Use React.createElement only, no imports, no browser globals, no unclosed brackets/quotes/template strings.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Validation failed before returning to the frontend.\n\nValidation error:\n${args.validationError}\n\nOriginal user request:\n${args.prompt}\n\nConversation transcript:\n${args.transcript || 'No prior messages'}\n\nCurrent page summary:\n${summarizePageState(args.pageState)}\n\nWorkflow plan:\n${JSON.stringify(args.plan)}\n\nAdditional context:\n${args.extraContext ?? 'None'}\n\nPrevious assistantText:\n${args.previousDraft.assistantText}\n\nPrevious changeSummary:\n${args.previousDraft.changeSummary}\n\nPrevious invalid patchJson:\n${args.previousDraft.patchJson}\n\nReturn a corrected patchJson that passes validation and code compilation.`,
          },
        ],
      },
    ],
    text: {
      format: modelResponseSchema,
    },
  });

  return openAiPatchResponseSchema.parse(JSON.parse(response.output_text));
}

async function generateCheckedPatchResponse(
  client: OpenAI,
  args: {
    prompt: string;
    pageState: PageState;
    transcript: string;
    plan: WorkflowPlan;
    source: string;
    extraContext?: string;
    createDraft: () => Promise<PatchResponseDraft>;
    workflowId?: string;
  },
): Promise<AiMessageResponse> {
  const maxAttempts = Number(process.env.AI_PATCH_REPAIR_ATTEMPTS ?? defaultPatchRepairAttempts);
  let draft = await args.createDraft();
  let lastError = '';

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = parseAndPreflightPatchResponse(args.pageState, draft);
      if (attempt > 0) {
        logWorkflow(args.workflowId ?? 'noctx', 'patch_repair_success', {
          source: args.source,
          attempt,
          patchCount: response.patch.length,
        });
      }
      return response;
    } catch (error) {
      lastError = getPatchValidationErrorMessage(error);
      logWorkflow(args.workflowId ?? 'noctx', 'patch_check_failed', {
        source: args.source,
        attempt,
        error: lastError,
        patchJson: draft.patchJson,
      });

      if (attempt >= maxAttempts) {
        break;
      }

      draft = await repairPatchResponseDraft(client, {
        prompt: args.prompt,
        pageState: args.pageState,
        transcript: args.transcript,
        plan: args.plan,
        previousDraft: draft,
        validationError: lastError,
        extraContext: args.extraContext,
      });
    }
  }

  throw new Error(lastError || 'AI returned an invalid page patch.');
}

function buildGeneratedComponentBackgroundCode(originalCode: string, targetNode: PageNode): string {
  const originalName = typeof targetNode.props.name === 'string' ? targetNode.props.name : 'Generated component';
  const originalMountProps = targetNode.props.mountProps;
  const title =
    originalMountProps && typeof originalMountProps === 'object' && typeof (originalMountProps as Record<string, unknown>).title === 'string'
      ? String((originalMountProps as Record<string, unknown>).title)
      : originalName;

  const isLikelyTable =
    originalCode.includes('table') ||
    (originalMountProps &&
      typeof originalMountProps === 'object' &&
      Array.isArray((originalMountProps as Record<string, unknown>).columns) &&
      Array.isArray((originalMountProps as Record<string, unknown>).rows));

  if (!isLikelyTable) {
    return [
      "const e = React.createElement;",
      "const backgroundImage = props.backgroundImage ? `linear-gradient(rgba(255,255,255,0.54), rgba(255,255,255,0.62)), url(${props.backgroundImage})` : 'rgba(255,255,255,0.66)';",
      "return e('section', { style: { width: '100%', minHeight: 260, padding: 28, borderRadius: 30, backgroundImage, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid rgba(255,255,255,0.58)', boxShadow: '0 24px 70px rgba(20,20,20,0.1)', backdropFilter: 'blur(8px)', color: theme.textPrimary || '#111' } },",
      `  e('h2', { style: { margin: '0 0 12px', fontSize: 28 } }, props.title || ${JSON.stringify(title)}),`,
      "  e('p', { style: { margin: 0, lineHeight: 1.7, color: theme.textSecondary || '#555' } }, props.description || 'This component background was generated and blended into the existing component.')",
      ");",
    ].join('\n');
  }

  return [
    "const e = React.createElement;",
    "const columns = Array.isArray(props.columns) ? props.columns : ['姓名', '部门', '状态', '更新时间'];",
    "const rows = Array.isArray(props.rows) ? props.rows : [['张伟', '产品', '进行中', '2025-02-01'], ['李娜', '设计', '已完成', '2025-02-03'], ['王强', '研发', '待处理', '2025-02-05']];",
    "const backgroundImage = props.backgroundImage ? `linear-gradient(rgba(255,255,255,0.50), rgba(255,255,255,0.66)), url(${props.backgroundImage})` : 'rgba(255,255,255,0.72)';",
    "return e('section', { style: { width: '100%', padding: 24, borderRadius: 28, backgroundImage, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid rgba(255,255,255,0.58)', boxShadow: '0 26px 80px rgba(20,20,20,0.12)', color: theme.textPrimary || '#111', overflow: 'hidden' } },",
    `  e('h2', { style: { margin: '0 0 16px', fontSize: 22, letterSpacing: '-0.02em' } }, props.title || ${JSON.stringify(title)}),`,
    "  e('div', { style: { overflowX: 'auto', borderRadius: 18, background: 'rgba(255,255,255,0.42)', backdropFilter: 'blur(8px)' } },",
    "    e('table', { style: { width: '100%', borderCollapse: 'collapse', minWidth: 560 } },",
    "      e('thead', null, e('tr', null, columns.map((col, index) => e('th', { key: index, style: { textAlign: 'left', padding: '13px 15px', fontSize: 13, color: '#1f2937', background: 'rgba(255,255,255,0.48)', borderBottom: '1px solid rgba(31,41,55,0.14)' } }, col)))),",
    "      e('tbody', null, rows.map((row, rowIndex) => e('tr', { key: rowIndex }, row.map((cell, cellIndex) => e('td', { key: cellIndex, style: { padding: '13px 15px', fontSize: 14, color: '#111827', borderBottom: '1px solid rgba(31,41,55,0.09)', background: rowIndex % 2 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.1)' } }, cell)))))",
    "    )",
    "  )",
    ");",
  ].join('\n');
}

function prepareComponentBackgroundPatch(pageState: PageState, targetNodeId: string, imageDataUrl: string): WorkflowToolResult {
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
        code: buildGeneratedComponentBackgroundCode(String(targetNode.props.code ?? ''), targetNode),
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

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) {
    throw new Error('Existing image background is not an editable data URL.');
  }

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  return {
    blob: new Blob([Buffer.from(match[2], 'base64')], { type: mimeType }),
    mimeType,
  };
}

async function postImageGenerationRequest(body: {
  model: string;
  prompt: string;
  size: string;
  quality: 'low' | 'medium' | 'high' | 'auto';
  background: 'opaque';
  output_format: 'png';
  n: number;
}): Promise<string> {
  const timeoutMs = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? defaultImageTimeoutMs);
  const url = `${getOpenAiBaseUrl()}/images/generations`;
  const startedAt = Date.now();

  logDirectImageRequest('start', {
    method: 'POST',
    path: '/v1/images/generations',
    model: body.model,
    body,
  });

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getRequiredApiKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    logDirectImageRequest('end', {
      method: 'POST',
      path: '/v1/images/generations',
      model: body.model,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return await parseImageResponse(response);
  } catch (error) {
    logDirectImageRequest('error', {
      method: 'POST',
      path: '/v1/images/generations',
      model: body.model,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function generateImageBackground(imagePrompt: string): Promise<string> {
  const model = process.env.OPENAI_IMAGE_MODEL ?? defaultImageModel;
  const firstBody = {
    model,
    prompt: imagePrompt,
    size: process.env.OPENAI_IMAGE_SIZE ?? defaultImageSize,
    quality: (process.env.OPENAI_IMAGE_QUALITY as 'low' | 'medium' | 'high' | 'auto' | undefined) ?? 'medium',
    background: 'opaque' as const,
    output_format: 'png' as const,
    n: 1,
  };

  try {
    return await postImageGenerationRequest(firstBody);
  } catch (error) {
    if (process.env.OPENAI_IMAGE_FAST_RETRY === 'false' || !isRetryableImageError(error)) {
      throw error;
    }

    logDirectImageRequest('start', {
      method: 'POST',
      path: '/v1/images/generations',
      model,
      retry: 'fast_fallback',
      reason: error instanceof Error ? error.message : String(error),
    });

    return postImageGenerationRequest({
      ...firstBody,
      prompt: buildFastFallbackImagePrompt(imagePrompt),
      quality: 'low',
    });
  }
}

async function editImageBackground(imagePrompt: string, currentImageDataUrl: string): Promise<string> {
  const model = process.env.OPENAI_IMAGE_MODEL ?? defaultImageModel;
  const timeoutMs = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS ?? defaultImageTimeoutMs);
  const url = `${getOpenAiBaseUrl()}/images/edits`;
  const { blob, mimeType } = dataUrlToBlob(currentImageDataUrl);
  const formData = new FormData();
  formData.set('model', model);
  formData.set('image', blob, `current-background.${mimeType.split('/')[1] ?? 'png'}`);
  formData.set('prompt', imagePrompt);
  formData.set('size', process.env.OPENAI_IMAGE_SIZE ?? defaultImageSize);
  formData.set('quality', (process.env.OPENAI_IMAGE_QUALITY as 'low' | 'medium' | 'high' | 'auto' | undefined) ?? 'medium');
  formData.set('background', 'opaque');
  formData.set('output_format', 'png');
  formData.set('n', '1');
  const startedAt = Date.now();

  logDirectImageRequest('start', {
    method: 'POST',
    path: '/v1/images/edits',
    model,
    body: {
      model,
      prompt: imagePrompt,
      size: process.env.OPENAI_IMAGE_SIZE ?? defaultImageSize,
      quality: (process.env.OPENAI_IMAGE_QUALITY as 'low' | 'medium' | 'high' | 'auto' | undefined) ?? 'medium',
      background: 'opaque',
      output_format: 'png',
      n: 1,
      image: `[${mimeType} blob bytes=${blob.size}]`,
    },
  });

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${getRequiredApiKey()}`,
        },
        body: formData,
      },
      timeoutMs,
    );
    logDirectImageRequest('end', {
      method: 'POST',
      path: '/v1/images/edits',
      model,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return await parseImageResponse(response);
  } catch (error) {
    logDirectImageRequest('error', {
      method: 'POST',
      path: '/v1/images/edits',
      model,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function generateWorkflowPlan(
  client: OpenAI,
  prompt: string,
  pageState: PageState,
  transcript: string,
): Promise<WorkflowPlan> {
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL ?? defaultModel,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              'You are the planner for a page-editing workflow. Decide whether the user needs text-only response, page/component patching, image generation, or image editing. Return only the required JSON schema. If the user asks to change a table/card/button/component background, target component and provide its node id from the page summary. If the user asks for whole page/background/canvas background, target page_background. If the user says chat box/input/prompt/composer/聊天框/输入框, target system-prompt. If the user says timeline/history rail/时间轴, target system-timeline. For repair-only requests such as broken/not working/用不了/没反应/修复, target the existing affected component and do not imply a position change unless explicitly requested. Do not invent node IDs.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Conversation transcript:\n${transcript || 'No prior messages'}\n\nCurrent page summary:\n${summarizePageState(pageState)}\n\nInspectable nodes:\n${JSON.stringify((inspectPageState(pageState).data as { nodes: unknown[] }).nodes)}\n\nUser request:\n${prompt}`,
          },
        ],
      },
    ],
    text: {
      format: workflowPlanResponseSchema,
    },
  });

  const rawPlan = JSON.parse(response.output_text);
  const normalized = {
    ...rawPlan,
    targetNodeId: rawPlan.targetNodeId ?? undefined,
    imagePrompt: rawPlan.imagePrompt ?? undefined,
  };
  return workflowPlanSchema.parse(normalized);
}

async function finalizeWorkflowPatch(
  client: OpenAI,
  prompt: string,
  pageState: PageState,
  transcript: string,
  plan: WorkflowPlan,
  toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
  imageRefs: ImageRefMap,
  workflowId?: string,
): Promise<AiMessageResponse> {
  const modelSafeToolResults = sanitizeToolResultsForModel(toolResults, imageRefs);
  const repairOnlyInstruction = buildRepairOnlyInstruction(prompt);
  return generateCheckedPatchResponse(client, {
    prompt,
    pageState,
    transcript,
    plan,
    source: 'finalizer',
    workflowId,
    extraContext: `Tool results:\n${JSON.stringify(modelSafeToolResults)}`,
    createDraft: async () => {
      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL ?? defaultModel,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'You are generating the final safe page patch after a workflow. Never output raw HTML pages, imports, arbitrary browser APIs, event handler props, RFC6902 JSON Patch operations, or components outside the approved list. Only return assistantText, changeSummary, and patchJson.\n\n' +
                  patchProtocolPrompt +
                  '\n\nYou may add generated_react_component nodes for bespoke UI such as tables, dashboards, and controls. A generated_react_component must use props { name, code, mountProps, capabilities }. code is a JavaScript function body receiving React, props, theme, system, sdk and must return a React element using React.createElement; do not import packages. For tables, include visible 3x3 or requested rows/columns, set styleTokens.width to a visible value, styleTokens.minHeight or height to at least 320px, and style the table so it remains readable. Use styleTokens freely for visual CSS and placement, including backgroundImage, borderRadius, boxShadow, backdropFilter, display/grid/flex properties, overflow, zIndex, and transforms; keep positioned components inside the viewport and do not intentionally cover the prompt or timeline. If tool results contain an image reference like __workflow_image_1__, copy that exact reference into the patch, preferably mountProps.backgroundImage for generated components. For generated_react_component updates, preserve existing mountProps and use backgroundImage from tool results when available. If a tool provided a candidate patch, prefer using it unless it violates the user request.' +
                  (repairOnlyInstruction ? `\n\n${repairOnlyInstruction}` : ''),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Conversation transcript:\n${transcript || 'No prior messages'}\n\nCurrent page summary:\n${summarizePageState(pageState)}\n\nWorkflow plan:\n${JSON.stringify(plan)}\n\nTool results:\n${JSON.stringify(modelSafeToolResults)}\n\nUser request:\n${prompt}`,
              },
            ],
          },
        ],
        text: {
          format: modelResponseSchema,
        },
      });

      const parsed = openAiPatchResponseSchema.parse(JSON.parse(response.output_text));
      const restoredPatchJson = restoreImageRefs(parsed.patchJson, imageRefs);
      if (typeof restoredPatchJson !== 'string') {
        throw new Error('AI returned an invalid page patch.');
      }
      return {
        ...parsed,
        patchJson: restoredPatchJson,
      };
    },
  });
}

function getCandidatePatch(toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>): PagePatchOperation[] | null {
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

function findImageDataUrl(toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>): string | undefined {
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

function wantsTimerComponent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('timer') ||
    normalized.includes('countdown') ||
    normalized.includes('stopwatch') ||
    normalized.includes('计时器') ||
    normalized.includes('倒计时') ||
    normalized.includes('秒表')
  );
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

function getWorkflowFallbackPatch(
  prompt: string,
  plan: WorkflowPlan,
  toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
): PagePatchOperation[] | null {
  const candidatePatch = getCandidatePatch(toolResults);
  if (candidatePatch) {
    return candidatePatch;
  }

  const imageDataUrl = findImageDataUrl(toolResults);
  const normalizedPrompt = prompt.toLowerCase();
  const wantsTable =
    normalizedPrompt.includes('table') ||
    normalizedPrompt.includes('表格') ||
    normalizedPrompt.includes('3x3') ||
    normalizedPrompt.includes('3×3');
  if (imageDataUrl && plan.target === 'component' && wantsTable) {
    return validatePatchOperations(buildGeneratedTableWithImagePatch(prompt, imageDataUrl));
  }

  if (plan.target === 'component' && wantsTimerComponent(prompt)) {
    return validatePatchOperations(buildGeneratedTimerPatch(prompt));
  }

  return null;
}

function buildMockPatch(prompt: string, pageState: PageState): AiMessageResponse {
  const normalized = prompt.trim().toLowerCase();
  const hasContent = pageState.root.children.some((node: PageNode) => !node.type.startsWith('system_'));
  const accents = inferAccent(normalized);
  const patch: PagePatchOperation[] = [];

  if (wantsPromptMovedBottom(prompt)) {
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

  if (wantsTimelineLeft(prompt)) {
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

  if (wantsGeneratedComponent(prompt)) {
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

  if (wantsGraffitiBackground(prompt)) {
    const word = extractGraffitiWord(prompt);
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

async function runAiWorkflow(
  client: OpenAI,
  prompt: string,
  pageState: PageState,
  messages: ConversationMessage[],
  context: AiRequestContext = {},
): Promise<AiMessageResponse> {
  const workflowId = context.requestId ?? Math.random().toString(36).slice(2, 8);
  const transcript = messages
    .filter((message) => message.role !== 'system')
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n');
  const trace: WorkflowTraceStep[] = [];
  const toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }> = [];
  const imageRefs: ImageRefMap = new Map();

  logWorkflow(workflowId, 'start', { promptLength: prompt.length });

  const planStartedAt = Date.now();
  logWorkflow(workflowId, 'tool_call', { tool: 'planner', model: process.env.OPENAI_MODEL ?? defaultModel });
  const plan = await generateWorkflowPlan(client, prompt, pageState, transcript);
  logWorkflow(workflowId, 'tool_result', {
    tool: 'planner',
    ok: true,
    durationMs: Date.now() - planStartedAt,
    plan,
  });
  trace.push({ type: 'reasoning', content: plan.reasoning });

  logWorkflow(workflowId, 'tool_call', { tool: 'inspect_page_state' });
  const inspectResult = inspectPageState(pageState);
  toolResults.push({ tool: 'inspect_page_state', result: inspectResult });
  logWorkflow(workflowId, 'tool_result', {
    tool: 'inspect_page_state',
    ok: inspectResult.ok,
    summary: inspectResult.ok ? 'Page state inspected.' : (inspectResult.error ?? 'Inspection failed.'),
  });
  trace.push({
    type: 'tool_call',
    tool: 'inspect_page_state',
    input: {},
  });
  trace.push({
    type: 'tool_result',
    tool: 'inspect_page_state',
    ok: inspectResult.ok,
    summary: inspectResult.ok ? 'Page state inspected.' : (inspectResult.error ?? 'Inspection failed.'),
  });

  if (!plan.needsImage) {
    const directStartedAt = Date.now();
    logWorkflow(workflowId, 'tool_call', { tool: 'direct_patch', model: process.env.OPENAI_MODEL ?? defaultModel });
    let directResponse: AiMessageResponse;
    try {
      directResponse = await generateDirectPatchResponse(client, prompt, pageState, transcript, plan, workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWorkflow(workflowId, 'tool_result', {
        tool: 'direct_patch',
        ok: false,
        durationMs: Date.now() - directStartedAt,
        error: message,
      });
      const fallbackPatch = getWorkflowFallbackPatch(prompt, plan, toolResults);
      if (!fallbackPatch) {
        throw error;
      }

      directResponse = {
        assistantText: wantsTimerComponent(prompt)
          ? '我创建了一个可运行的计时器组件。'
          : 'I created a safe generated component fallback.',
        changeSummary: 'Applied direct patch fallback after model patch validation failed.',
        patch: fallbackPatch,
      };
    }
    directResponse = stabilizeResponseForRepairOnly(prompt, pageState, plan, directResponse);
    directResponse = preflightAiMessageResponse(pageState, directResponse);
    logWorkflow(workflowId, 'tool_result', {
      tool: 'direct_patch',
      ok: true,
      durationMs: Date.now() - directStartedAt,
      patchCount: directResponse.patch.length,
      changeSummary: directResponse.changeSummary,
    });
    return aiMessageResponseSchema.parse({
      ...directResponse,
      workflowTrace: [
        ...trace,
        {
          type: 'final_patch',
          summary: directResponse.changeSummary,
          patchCount: directResponse.patch.length,
        },
      ],
    });
  }

  if (plan.needsImage) {
    const targetNode = plan.targetNodeId ? findNodeById(pageState.root, plan.targetNodeId) : undefined;
    const imagePrompt =
      plan.target === 'component'
        ? buildComponentImagePrompt(plan.imagePrompt ?? prompt, targetNode)
        : buildImagePrompt(plan.imagePrompt ?? prompt);
    const existingPageImage = getExistingImageBackground(pageState);
    const existingImageSrc = typeof existingPageImage?.props.src === 'string' ? existingPageImage.props.src : undefined;
    const shouldEditPageImage = plan.target === 'page_background' && plan.shouldEditExistingImage && existingImageSrc;

    trace.push({
      type: 'tool_call',
      tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
      input: { target: plan.target, targetNodeId: plan.targetNodeId, prompt: imagePrompt },
    });

    try {
      const imageStartedAt = Date.now();
      logWorkflow(workflowId, 'tool_call', {
        tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
        model: process.env.OPENAI_IMAGE_MODEL ?? defaultImageModel,
        target: plan.target,
        targetNodeId: plan.targetNodeId ?? null,
        promptLength: imagePrompt.length,
      });
      const imageDataUrl = shouldEditPageImage
        ? await editImageBackground(imagePrompt, existingImageSrc)
        : await generateImageBackground(imagePrompt);
      const imageRef = addImageRef(imageRefs, imageDataUrl);
      const imageResult: WorkflowToolResult = { ok: true, data: { imageDataUrl, imageRef } };
      toolResults.push({ tool: shouldEditPageImage ? 'edit_image' : 'generate_image', result: imageResult });
      logWorkflow(workflowId, 'tool_result', {
        tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
        ok: true,
        durationMs: Date.now() - imageStartedAt,
        imageRef,
        imageDataUrl,
      });
      trace.push({
        type: 'tool_result',
        tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
        ok: true,
        summary: 'Image generated.',
      });

      if (plan.target === 'component' && plan.targetNodeId) {
        logWorkflow(workflowId, 'tool_call', {
          tool: 'prepare_component_background_patch',
          targetNodeId: plan.targetNodeId,
        });
        trace.push({
          type: 'tool_call',
          tool: 'prepare_component_background_patch',
          input: { targetNodeId: plan.targetNodeId },
        });
        const componentPatchResult = prepareComponentBackgroundPatch(pageState, plan.targetNodeId, imageDataUrl);
        toolResults.push({ tool: 'prepare_component_background_patch', result: componentPatchResult });
        logWorkflow(workflowId, 'tool_result', {
          tool: 'prepare_component_background_patch',
          ok: componentPatchResult.ok,
          result: componentPatchResult,
        });
        trace.push({
          type: 'tool_result',
          tool: 'prepare_component_background_patch',
          ok: componentPatchResult.ok,
          summary: componentPatchResult.ok ? 'Prepared component background patch.' : (componentPatchResult.error ?? 'Patch failed.'),
        });
      } else if (plan.target === 'page_background') {
        const pagePatch: PagePatchOperation[] = [
          {
            type: 'set_theme_tokens',
            theme: {
              pageBackground: '#ffffff',
            },
          },
          existingPageImage
            ? {
                type: 'update_node',
                nodeId: existingPageImage.id,
                props: {
                  src: imageDataUrl,
                  alt: 'AI edited page background',
                },
              }
            : {
                type: 'add_node',
                target: { parentId: 'root', index: 0 },
                node: {
                  id: 'generated-image-background',
                  type: 'image_background',
                  props: {
                    src: imageDataUrl,
                    alt: 'AI generated page background',
                  },
                  styleTokens: {},
                  children: [],
                },
              },
        ];
        toolResults.push({ tool: 'prepare_component_background_patch', result: { ok: true, data: { patch: pagePatch } } });
        logWorkflow(workflowId, 'tool_result', {
          tool: 'prepare_component_background_patch',
          ok: true,
          result: { patch: pagePatch },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Image generation failed.';
      const imageResult: WorkflowToolResult = { ok: false, error: message };
      toolResults.push({ tool: shouldEditPageImage ? 'edit_image' : 'generate_image', result: imageResult });
      logWorkflow(workflowId, 'tool_result', {
        tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
        ok: false,
        error: message,
      });
      trace.push({
        type: 'tool_result',
        tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
        ok: false,
        summary: message,
      });
      return aiMessageResponseSchema.parse({
        assistantText: `图片生成失败：${message}`,
        changeSummary: 'Image tool failed before applying any page changes.',
        patch: [],
        error: message,
        workflowTrace: trace,
      });
    }
  }

  try {
    const finalizerStartedAt = Date.now();
    logWorkflow(workflowId, 'tool_call', {
      tool: 'finalizer',
      model: process.env.OPENAI_MODEL ?? defaultModel,
      toolResultCount: toolResults.length,
      imageRefCount: imageRefs.size,
    });
    const finalResponse = stabilizeResponseForRepairOnly(
      prompt,
      pageState,
      plan,
      await finalizeWorkflowPatch(client, prompt, pageState, transcript, plan, toolResults, imageRefs, workflowId),
    );
    const checkedFinalResponse = preflightAiMessageResponse(pageState, finalResponse);
    logWorkflow(workflowId, 'tool_result', {
      tool: 'finalizer',
      ok: true,
      durationMs: Date.now() - finalizerStartedAt,
      patchCount: checkedFinalResponse.patch.length,
      changeSummary: checkedFinalResponse.changeSummary,
    });
    const responseWithTrace = aiMessageResponseSchema.parse({
      ...checkedFinalResponse,
      workflowTrace: [
        ...trace,
        {
          type: 'final_patch',
          summary: checkedFinalResponse.changeSummary,
          patchCount: checkedFinalResponse.patch.length,
        },
      ],
    });
    return responseWithTrace;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWorkflow(workflowId, 'tool_result', {
      tool: 'finalizer',
      ok: false,
      error: message,
    });
    const fallbackPatch = getWorkflowFallbackPatch(prompt, plan, toolResults);
    if (fallbackPatch) {
      logWorkflow(workflowId, 'final_patch', {
        source: 'workflow_fallback',
        patchCount: fallbackPatch.length,
      });
      return aiMessageResponseSchema.parse({
        assistantText:
          plan.target === 'component'
            ? 'I generated an image and applied it to the target component background.'
            : 'I generated an image and applied it to the page background.',
        changeSummary: 'Applied workflow candidate patch after finalizer fallback.',
        patch: preflightAiMessageResponse(pageState, {
          assistantText: 'fallback',
          changeSummary: 'fallback',
          patch: stabilizePatchForRepairOnly(prompt, pageState, plan, fallbackPatch),
        }).patch,
        workflowTrace: [
          ...trace,
          {
            type: 'final_patch',
            summary: 'Used candidate patch fallback.',
            patchCount: fallbackPatch.length,
          },
        ],
      });
    }

    throw error;
  }
}

export async function generateAssistantResponse(
  prompt: string,
  pageState: PageState,
  messages: ConversationMessage[],
  context: AiRequestContext = {},
): Promise<AiMessageResponse> {
  let client: OpenAI;
  try {
    client = getClient();
  } catch (error) {
    if (error instanceof Error && error.message === 'AI_MOCK_ENABLED') {
      // Tests keep using a deterministic local patch without requiring a real API key.
      return buildMockPatch(prompt, pageState);
    }
    throw error;
  }

  if (process.env.USE_AI_MOCK === 'true') {
    return buildMockPatch(prompt, pageState);
  }

  const response = await runAiWorkflow(client, prompt, pageState, messages, context);
  return aiMessageResponseSchema.parse(response);
}

async function generateDirectPatchResponse(
  client: OpenAI,
  prompt: string,
  pageState: PageState,
  transcript: string,
  plan: WorkflowPlan,
  workflowId?: string,
): Promise<AiMessageResponse> {
  const repairOnlyInstruction = buildRepairOnlyInstruction(prompt);
  return generateCheckedPatchResponse(client, {
    prompt,
    pageState,
    transcript,
    plan,
    source: 'direct_patch',
    workflowId,
    extraContext:
      'Valid patchJson example:\n' +
      '[{"type":"add_node","target":{"parentId":"root","index":0},"node":{"id":"example-card","type":"card","props":{"title":"Example","subtitle":"Safe component patch"},"styleTokens":{"padding":"32px","radius":"28px"},"children":[]}}]',
    createDraft: async () => {
      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL ?? defaultModel,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'You are generating safe UI patch operations for a controlled page builder. Never output raw HTML pages, arbitrary browser APIs, event handler props, RFC6902 JSON Patch operations, or components outside the approved list. Only return concise assistantText, changeSummary, and patchJson.\n\n' +
                  patchProtocolPrompt +
                  '\n\nApproved native components include section, heading, text, button, input, card, list, image, image_background, graffiti_word, columns, tabs, accordion, stepper, and modal_trigger. System components already exist with ids system-prompt and system-timeline; you may update or move them but must never remove, hide, or make them unusable. To move the input, update nodeId system-prompt props.layout.position to center, bottom, top, left, or right. To move the timeline, update nodeId system-timeline props.layout.position to left or right, and props.layout.orientation to vertical or horizontal. You may add generated_react_component nodes for bespoke UI such as tables, custom controls, dashboards, and forms. A generated_react_component must use props { name, code, mountProps, capabilities }. code is a JavaScript function body receiving React, props, theme, system, sdk and must return a React element using React.createElement; do not import packages. For tables or multi-row widgets, set styleTokens.width to a visible value and styleTokens.minHeight or height to at least 320px, and style the table/card inside the generated component so it is visible on a white canvas. Use styleTokens freely for visual CSS and placement, including backgroundImage, borderRadius, boxShadow, backdropFilter, display/grid/flex properties, overflow, zIndex, and transforms; keep positioned components inside the viewport and do not intentionally cover the prompt or timeline. Host capabilities are sendPrompt, selectSnapshot, and exportCanvasPng, and must be declared in capabilities before use. Keep changes incremental and stable.' +
                  (repairOnlyInstruction ? `\n\n${repairOnlyInstruction}` : ''),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `Conversation transcript:\n${transcript || 'No prior messages'}\n\nCurrent canvas summary:\n${summarizePageState(pageState)}\n\nWorkflow plan:\n${JSON.stringify(plan)}\n\nValid patchJson example:\n[{\"type\":\"add_node\",\"target\":{\"parentId\":\"root\",\"index\":0},\"node\":{\"id\":\"example-card\",\"type\":\"card\",\"props\":{\"title\":\"Example\",\"subtitle\":\"Safe component patch\"},\"styleTokens\":{\"padding\":\"32px\",\"radius\":\"28px\"},\"children\":[]}}]\n\nUser request:\n${prompt}`,
              },
            ],
          },
        ],
        text: {
          format: modelResponseSchema,
        },
      });

      return openAiPatchResponseSchema.parse(JSON.parse(response.output_text));
    },
  });
}

export function validateAndApplyAiResponse(pageState: PageState, response: AiMessageResponse): PageState {
  return applyPatchOperations(pageState, validatePatchOperations(response.patch));
}
