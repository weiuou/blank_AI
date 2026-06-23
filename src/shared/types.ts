import { z } from 'zod';

export const componentTypeSchema = z.enum([
  'section',
  'heading',
  'text',
  'button',
  'input',
  'card',
  'list',
  'image',
  'image_background',
  'graffiti_word',
  'columns',
  'tabs',
  'accordion',
  'stepper',
  'modal_trigger',
  'system_prompt',
  'system_timeline',
  'generated_react_component',
]);

export type ComponentType = z.infer<typeof componentTypeSchema>;

const opacitySchema = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : value;
  }
  return value;
}, z.union([z.number().min(0).max(1), z.string().max(8_000_000)]));

const zIndexSchema = z.preprocess((value) => {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  return value;
}, z.union([z.number().int().min(-2147483648).max(2147483647), z.string().max(8_000_000)]));

const cssStyleValueSchema = z.union([z.string().max(8_000_000), z.number()]);
const forbiddenCssPropertyNames = new Set([
  '__definegetter__',
  '__definesetter__',
  '__lookupgetter__',
  '__lookupsetter__',
  '__proto__',
  'constructor',
  'prototype',
]);
const cssPropertyNamePattern = /^(?:--[A-Za-z_][A-Za-z0-9_-]*|-?(?:webkit|moz|ms|o)-[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*)$/i;

export const styleTokensSchema = z
  .object({
    background: cssStyleValueSchema.optional(),
    color: cssStyleValueSchema.optional(),
    align: cssStyleValueSchema.optional(),
    gap: cssStyleValueSchema.optional(),
    margin: cssStyleValueSchema.optional(),
    marginTop: cssStyleValueSchema.optional(),
    marginRight: cssStyleValueSchema.optional(),
    marginBottom: cssStyleValueSchema.optional(),
    marginLeft: cssStyleValueSchema.optional(),
    padding: cssStyleValueSchema.optional(),
    radius: cssStyleValueSchema.optional(),
    border: cssStyleValueSchema.optional(),
    shadow: cssStyleValueSchema.optional(),
    width: cssStyleValueSchema.optional(),
    maxWidth: cssStyleValueSchema.optional(),
    minHeight: cssStyleValueSchema.optional(),
    height: cssStyleValueSchema.optional(),
    position: cssStyleValueSchema.optional(),
    top: cssStyleValueSchema.optional(),
    right: cssStyleValueSchema.optional(),
    bottom: cssStyleValueSchema.optional(),
    left: cssStyleValueSchema.optional(),
    transform: cssStyleValueSchema.optional(),
    zIndex: zIndexSchema.optional(),
    opacity: opacitySchema.optional(),
  })
  .catchall(cssStyleValueSchema)
  .superRefine((value, ctx) => {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (!cssPropertyNamePattern.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsupported CSS property name: ${key}`,
          path: [key],
        });
      }
      if (forbiddenCssPropertyNames.has(key.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsafe CSS property name: ${key}`,
          path: [key],
        });
      }
      if (
        typeof nestedValue === 'string' &&
        /(?:javascript\s*:|vbscript\s*:|expression\s*\(|behavior\s*:|@import|<\s*script|data\s*:\s*(?:text\/html|application\/(?:javascript|x-javascript|ecmascript)))/i.test(
          nestedValue,
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsafe CSS value for ${key}`,
          path: [key],
        });
      }
    }
  });

export type StyleTokens = z.infer<typeof styleTokensSchema>;

export const themeTokensSchema = z
  .object({
    pageBackground: z.string(),
    surface: z.string(),
    surfaceMuted: z.string(),
    textPrimary: z.string(),
    textSecondary: z.string(),
    accent: z.string(),
    accentSoft: z.string(),
    border: z.string(),
    shadow: z.string(),
    radius: z.string(),
    fontFamily: z.string(),
    spacing: z.string(),
  })
  .strict();

export type ThemeTokens = z.infer<typeof themeTokensSchema>;

export const behaviorSchema = z
  .object({
    kind: z.enum(['none', 'tabs', 'accordion', 'stepper', 'modal']).default('none'),
    items: z.array(z.string()).optional(),
    activeItemId: z.string().optional(),
  })
  .strict();

export type BehaviorConfig = z.infer<typeof behaviorSchema>;

export const generatedComponentMetaSchema = z
  .object({
    category: z.string().optional(),
    archetype: z.string().optional(),
    userVisibleGoal: z.string().optional(),
    behavioralRequirements: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
  })
  .strict();

export type GeneratedComponentMeta = z.infer<typeof generatedComponentMetaSchema>;

export type PageNode = {
  id: string;
  type: ComponentType;
  props: Record<string, unknown>;
  styleTokens: StyleTokens;
  behavior?: BehaviorConfig;
  children: PageNode[];
};

export const pageNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      id: z.string(),
      type: componentTypeSchema,
      props: z.record(z.unknown()).superRefine((value, ctx) => {
        if (!Object.prototype.hasOwnProperty.call(value, 'componentMeta')) {
          return;
        }
        const parsed = generatedComponentMetaSchema.safeParse(value.componentMeta);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({
              ...issue,
              path: ['componentMeta', ...issue.path],
            });
          }
        }
      }),
      styleTokens: styleTokensSchema.default({}),
      behavior: behaviorSchema.optional(),
      children: z.array(pageNodeSchema).default([]),
    })
    .strict(),
);

export const pageStateSchema = z
  .object({
    root: pageNodeSchema,
    theme: themeTokensSchema,
    behaviorState: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export type PageState = z.infer<typeof pageStateSchema>;

const nodeTargetSchema = z
  .object({
    parentId: z.string(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict();

export const addNodePatchSchema = z
  .object({
    type: z.literal('add_node'),
    target: nodeTargetSchema,
    node: pageNodeSchema,
  })
  .strict();

const updateNodePatchBaseSchema = z
  .object({
    type: z.literal('update_node'),
    nodeId: z.string(),
    props: z.record(z.unknown()).optional(),
    styleTokens: styleTokensSchema.optional(),
    behavior: behaviorSchema.optional(),
  })
  .strict();

export const updateNodePatchSchema = updateNodePatchBaseSchema.superRefine((value, ctx) => {
  const hasProps = value.props !== undefined && Object.keys(value.props).length > 0;
  const hasStyleTokens = value.styleTokens !== undefined && Object.keys(value.styleTokens).length > 0;
  const hasBehavior =
    value.behavior !== undefined &&
    Object.entries(value.behavior).some(([key, nestedValue]) => !(key === 'kind' && nestedValue === 'none') && nestedValue !== undefined);
  if (!hasProps && !hasStyleTokens && !hasBehavior) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'update_node requires props, styleTokens, or behavior',
    });
  }
});

export const removeNodePatchSchema = z
  .object({
    type: z.literal('remove_node'),
    nodeId: z.string(),
  })
  .strict();

export const moveNodePatchSchema = z
  .object({
    type: z.literal('move_node'),
    nodeId: z.string(),
    target: nodeTargetSchema,
  })
  .strict();

export const setThemePatchSchema = z
  .object({
    type: z.literal('set_theme_tokens'),
    theme: themeTokensSchema.partial(),
  })
  .strict();

export const setBehaviorDefaultsPatchSchema = z
  .object({
    type: z.literal('set_behavior_state_defaults'),
    defaults: z.record(z.string(), z.string()),
  })
  .strict();

export const pagePatchOperationSchema = z.union([
  addNodePatchSchema,
  updateNodePatchSchema,
  removeNodePatchSchema,
  moveNodePatchSchema,
  setThemePatchSchema,
  setBehaviorDefaultsPatchSchema,
]);

export type PagePatchOperation = z.infer<typeof pagePatchOperationSchema>;

export const aiMessageResponseSchema = z
  .object({
    assistantText: z.string(),
    changeSummary: z.string(),
    patch: z.array(pagePatchOperationSchema),
    error: z.string().optional(),
    workflowTrace: z.array(z.record(z.unknown())).optional(),
  })
  .strict();

export type AiMessageResponse = z.infer<typeof aiMessageResponseSchema>;

export const apiErrorResponseSchema = z
  .object({
    error: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
  })
  .strict();

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const workflowTraceStepSchema = z
  .object({
    timestamp: z.string(),
    requestId: z.string(),
    type: z.string(),
    name: z.string(),
    status: z.enum(['start', 'success', 'error', 'info']),
    durationMs: z.number().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    inputSummary: z.unknown().optional(),
    outputSummary: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict();

export type WorkflowTraceStep = z.infer<typeof workflowTraceStepSchema>;

export const debugTraceSummarySchema = z
  .object({
    requestId: z.string(),
    sessionId: z.string().optional(),
    prompt: z.string().optional(),
    status: z.enum(['running', 'success', 'error']),
    startedAt: z.string(),
    updatedAt: z.string(),
    durationMs: z.number().optional(),
    stepCount: z.number().int().nonnegative(),
    error: z.string().optional(),
  })
  .strict();

export type DebugTraceSummary = z.infer<typeof debugTraceSummarySchema>;

export const debugTraceRecordSchema = debugTraceSummarySchema.extend({
  steps: z.array(workflowTraceStepSchema),
});

export type DebugTraceRecord = z.infer<typeof debugTraceRecordSchema>;

export const conversationMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    timestamp: z.string(),
  })
  .strict();

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const sessionSnapshotSchema = z
  .object({
    id: z.string(),
    index: z.number().int().nonnegative(),
    prompt: z.string(),
    label: z.string(),
    createdAt: z.string(),
    assistantText: z.string().optional(),
    hasPageChange: z.boolean(),
  })
  .strict();

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const sessionStartResponseSchema = z
  .object({
    sessionId: z.string(),
    pageState: pageStateSchema,
    messages: z.array(conversationMessageSchema),
    snapshots: z.array(sessionSnapshotSchema),
    activeSnapshotId: z.string(),
  })
  .strict();

export type SessionStartResponse = z.infer<typeof sessionStartResponseSchema>;

export const sessionMessageRequestSchema = z
  .object({
    sessionId: z.string(),
    prompt: z.string().min(1),
  })
  .strict();

export const sessionMessageResponseSchema = z
  .object({
    sessionId: z.string(),
    pageState: pageStateSchema,
    messages: z.array(conversationMessageSchema),
    snapshots: z.array(sessionSnapshotSchema),
    activeSnapshotId: z.string(),
    lastResponse: aiMessageResponseSchema,
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  })
  .strict();

export type SessionMessageResponse = z.infer<typeof sessionMessageResponseSchema>;

export const sessionHistoryResponseSchema = z
  .object({
    sessionId: z.string(),
    pageState: pageStateSchema,
    messages: z.array(conversationMessageSchema),
    snapshots: z.array(sessionSnapshotSchema),
    activeSnapshotId: z.string(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
  })
  .strict();

export type SessionHistoryResponse = z.infer<typeof sessionHistoryResponseSchema>;

export const sessionJumpRequestSchema = z
  .object({
    sessionId: z.string(),
    snapshotId: z.string(),
  })
  .strict();
