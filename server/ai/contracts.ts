import { z } from 'zod';
import type { AiMessageResponse, ConversationMessage, PagePatchOperation, PageState } from '../../src/shared/types';

export const patchResponseDraftSchema = z.object({
  assistantText: z.string(),
  changeSummary: z.string(),
  patch: z.array(z.unknown()),
});

export type PatchResponseDraft = z.infer<typeof patchResponseDraftSchema>;

export const workflowIntentSchema = z.enum(['create', 'update', 'remove', 'move', 'repair', 'answer_only']);
export const workflowSubjectSchema = z.enum([
  'page_background',
  'existing_component',
  'new_component',
  'system_prompt',
  'system_timeline',
  'text_response',
]);
export const workflowComponentCategorySchema = z.enum([
  'data',
  'display',
  'control',
  'input',
  'media',
  'navigation',
  'time_based',
  'layout',
  'system',
  'unknown',
]);
export const workflowImageTargetSchema = z.enum(['page', 'component', 'none']);
export const workflowConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const workflowReferenceRelationSchema = z.enum([
  'none',
  'near',
  'left_of',
  'right_of',
  'above',
  'below',
  'inside',
  'same_position',
  'custom',
]);

export const workflowTaskSchema = z
  .object({
    intent: workflowIntentSchema,
    subject: workflowSubjectSchema,
    targetNodeId: z.string().optional(),
    referenceNodeId: z.string().optional(),
    relationToReference: workflowReferenceRelationSchema.default('none'),
    componentCategory: workflowComponentCategorySchema,
    componentArchetype: z.string().min(1),
    userVisibleGoal: z.string().min(1),
    behavioralRequirements: z.array(z.string()).default([]),
    visualRequirements: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    needsImage: z.boolean(),
    imageTarget: workflowImageTargetSchema.default('none'),
    imagePrompt: z.string().optional(),
    requiresGeneratedCode: z.boolean(),
    shouldEditExistingImage: z.boolean().default(false),
    shouldRewriteComponentCode: z.boolean().default(false),
  })
  .strict();

export const workflowPlanSchema = z
  .object({
    reasoning: z.string(),
    tasks: z.array(workflowTaskSchema).min(1),
    confidence: workflowConfidenceSchema.default('medium'),
  })
  .strict();

export type WorkflowTask = z.infer<typeof workflowTaskSchema>;
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;

export type WorkflowToolName =
  | 'inspect_page_state'
  | 'list_components'
  | 'get_component_detail'
  | 'generate_image'
  | 'edit_image'
  | 'prepare_component_background_patch';

export const patchToolNameSchema = z.enum([
  'create_component_draft',
  'create_component_update_draft',
  'update_component_draft_metadata',
  'append_component_code_chunk',
  'read_component_draft',
  'clear_component_code',
  'validate_component_draft',
  'submit_component_draft',
  'submit_prepared_patch',
  'submit_no_changes',
  'add_standard_node',
  'update_node',
  'move_node',
  'remove_node',
  'set_theme_tokens',
  'set_behavior_state_defaults',
  'submit_collected_patch',
  'get_component_detail',
]);
export type PatchToolName = z.infer<typeof patchToolNameSchema>;

export type PatchToolDefinition = NativeToolDefinition<PatchToolName>;

export type NativeToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type NativeAssistantMessage = {
  content?: string | null;
  tool_calls?: NativeToolCall[];
};

export type NativeToolLoopMessage =
  | {
      role: 'system' | 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content?: string | null;
      tool_calls?: NativeToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

export type WorkflowToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type AiRequestContext = {
  requestId?: string;
};

export type WorkflowTraceStep =
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; tool: WorkflowToolName; input: unknown }
  | { type: 'tool_result'; tool: WorkflowToolName; ok: boolean; summary: string }
  | { type: 'final_patch'; summary: string; patchCount: number };

export type ImageRefMap = Map<string, string>;

export const workflowPlanToolInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reasoning', 'tasks', 'confidence'],
  properties: {
    reasoning: { type: 'string' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'intent',
          'subject',
          'targetNodeId',
          'referenceNodeId',
          'relationToReference',
          'componentCategory',
          'componentArchetype',
          'userVisibleGoal',
          'behavioralRequirements',
          'visualRequirements',
          'acceptanceCriteria',
          'needsImage',
          'imageTarget',
          'imagePrompt',
          'requiresGeneratedCode',
          'shouldEditExistingImage',
          'shouldRewriteComponentCode',
        ],
        properties: {
          intent: { type: 'string', enum: workflowIntentSchema.options },
          subject: { type: 'string', enum: workflowSubjectSchema.options },
          targetNodeId: { type: ['string', 'null'] },
          referenceNodeId: { type: ['string', 'null'] },
          relationToReference: { type: 'string', enum: workflowReferenceRelationSchema.options },
          componentCategory: { type: 'string', enum: workflowComponentCategorySchema.options },
          componentArchetype: { type: 'string' },
          userVisibleGoal: { type: 'string' },
          behavioralRequirements: { type: 'array', items: { type: 'string' } },
          visualRequirements: { type: 'array', items: { type: 'string' } },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          needsImage: { type: 'boolean' },
          imageTarget: { type: 'string', enum: workflowImageTargetSchema.options },
          imagePrompt: { type: ['string', 'null'] },
          requiresGeneratedCode: { type: 'boolean' },
          shouldEditExistingImage: { type: 'boolean' },
          shouldRewriteComponentCode: { type: 'boolean' },
        },
      },
    },
    confidence: { type: 'string', enum: workflowConfidenceSchema.options },
  },
} as const;

export type NativeToolDefinition<TName extends string = string> = {
  name: TName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type TextModelClient = {
  baseUrl: string;
  model: string;
  provider: string;
  createToolTurn: (args: {
    messages: NativeToolLoopMessage[];
    tools: NativeToolDefinition[];
    workflowId?: string;
    source: string;
  }) => Promise<NativeAssistantMessage>;
};

export function getPrimaryWorkflowTask(plan: WorkflowPlan): WorkflowTask {
  return plan.tasks[0];
}

export function workflowPlanNeedsImage(plan: WorkflowPlan): boolean {
  return plan.tasks.some((task) => task.needsImage);
}

export function getFirstImageWorkflowTask(plan: WorkflowPlan): WorkflowTask | undefined {
  return plan.tasks.find((task) => task.needsImage);
}

export type ImageModelClient = {
  provider: string;
  model: string;
  generateBackground: (prompt: string) => Promise<string>;
  editBackground: (prompt: string, currentImageDataUrl: string) => Promise<string>;
};

export type WorkflowRequest = {
  prompt: string;
  pageState: PageState;
  messages: ConversationMessage[];
  context?: AiRequestContext;
};

export type WorkflowPatchResult = AiMessageResponse & {
  patch: PagePatchOperation[];
};

export const defaultMiniMaxBaseUrl = 'https://api.minimaxi.com/v1';
export const defaultGeminiImageBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
export const defaultModel = 'MiniMax-M3';
export const defaultImageModel = 'gemini-3.1-flash-image';
export const defaultTextTimeoutMs = 70_000;
export const defaultImageTimeoutMs = 120_000;
export const defaultPatchRepairAttempts = 10;
export const imageRefPrefix = '__workflow_image_';

export const patchProtocolPrompt = [
  'PATCH PROTOCOL CONTRACT:',
  'Submit patch as an actual JSON array using ONLY this app-specific protocol.',
  'Each operation MUST use a "type" field. Never use "op", "path", "value", "operation", "action", or RFC6902 JSON Patch fields.',
  'styleTokens are permissive React/CSS style objects: use normal camelCase CSS such as borderRadius, boxShadow, backdropFilter, gridTemplateColumns, backgroundImage, filter, clipPath, animation, and CSS variables when useful. Do not use javascript:, vbscript:, expression(), @import, or HTML/script data URLs.',
  'Allowed operation shapes:',
  '{"type":"add_node","target":{"parentId":"root","index":0},"node":{"id":"example","type":"card","props":{"title":"Example"},"styleTokens":{},"children":[]}}',
  '{"type":"update_node","nodeId":"example","props":{"title":"Updated"}}',
  '{"type":"remove_node","nodeId":"example"}',
  '{"type":"move_node","nodeId":"example","target":{"parentId":"root","index":0}}',
  '{"type":"set_theme_tokens","theme":{"pageBackground":"#ffffff"}}',
  '{"type":"set_behavior_state_defaults","defaults":{"key":"value"}}',
  'For generated_react_component code, React, props, theme, system, and sdk are reserved runtime bindings already provided by the host. Use them directly. Never declare, assign, shadow, destructure-overwrite, or alias React. Do not redeclare props/theme/system/sdk at top level.',
  'Before submitting, self-check every patch item: it has "type"; it does not have "op"; add_node has target and node; update_node has nodeId.',
].join('\n');
