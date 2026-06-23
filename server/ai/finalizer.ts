import { z } from 'zod';
import { applyPatchOperations, validatePatchOperations } from '../../src/shared/patches';
import { aiMessageResponseSchema, styleTokensSchema, type AiMessageResponse, type PagePatchOperation, type PageState } from '../../src/shared/types';
import {
  defaultPatchRepairAttempts,
  type ImageRefMap,
  type NativeToolCall,
  type NativeToolLoopMessage,
  type PatchToolDefinition,
  type PatchToolName,
  type PatchResponseDraft,
  type TextModelClient,
  type WorkflowPlan,
  type WorkflowToolName,
  type WorkflowToolResult,
  patchResponseDraftSchema,
} from './contracts';
import { logWorkflow } from './logging';
import {
  findNodeById,
  getCandidatePatch,
  getComponentDetail,
  listComponents,
  replaceImageDataUrlsWithRefs,
  restoreImageRefs,
  sanitizeToolResultsForModel,
} from './tools';
import { parseModelPatch, preflightAiMessageResponse } from './validation';

type NativePatchArgs = {
  textProvider: TextModelClient;
  prompt: string;
  pageState: PageState;
  transcript: string;
  plan: WorkflowPlan;
  source: string;
  extraContext?: string;
  initialDraft?: PatchResponseDraft;
  imageRefs?: ImageRefMap;
  toolResults?: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>;
  transformResponse?: (response: AiMessageResponse) => AiMessageResponse;
  workflowId?: string;
  collectedPatch?: PagePatchOperation[];
  componentDrafts?: Map<string, ComponentDraft>;
  validatedComponentDraftIds?: Set<string>;
  failedComponentDraftIds?: Set<string>;
  clearRequiredComponentDraftIds?: Set<string>;
};

type ValidationResult = { ok: true; response: AiMessageResponse; draft: PatchResponseDraft } | { ok: false; error: string; draft: PatchResponseDraft };
type ComponentDraftMode = 'create' | 'update';
type ComponentDraftMeta = {
  category: string;
  archetype: string;
  userVisibleGoal: string;
  behavioralRequirements: string[];
  acceptanceCriteria: string[];
};
type ComponentDraft = {
  draftId: string;
  mode: ComponentDraftMode;
  taskIndex?: number;
  target?: { parentId: string; index?: number };
  nodeId: string;
  name: string;
  code: string;
  mountProps: Record<string, unknown>;
  capabilities: string[];
  styleTokens: Record<string, unknown>;
  componentMeta: ComponentDraftMeta;
  codeModified: boolean;
};
type PatchToolStage =
  | 'prepared_patch'
  | 'answer_only'
  | 'operation'
  | 'create_draft'
  | 'update_draft'
  | 'code_draft'
  | 'layout_draft'
  | 'submit_draft';
type DraftCodeState = 'empty' | 'incomplete' | 'complete_unvalidated' | 'failed_validation' | 'validated';

const stringArrayInputSchema = { type: 'array', items: { type: 'string' } } as const;
const recordInputSchema = { type: 'object', additionalProperties: true } as const;
const codeChunkSoftSplitLength = 4_000;
const codeChunkMaxInputLength = 80_000;
const generatedComponentCodeMaxLength = 12_000;
const codePreviewLength = 1_200;
const modelHistoryCodeChunkPreviewLength = 240;
const summarizedCodeChunkMarkerPattern = /\[omitted \d+ character code chunk already appended\b/;
const toolMarkupLeakPattern = /<\]?minimax|<\/?(?:invoke|tool_call|codeChunk)>/i;
const placeholderCodeChunkPattern =
  /^\s*(?:\.{3}|…|\[\s*\.{3}\s*\]|(?:\/\*\s*placeholder\s*\*\/\s*)?return\s+null\s*;?|\/\/[^\n]*(?:rest|remaining|same|previous|unchanged|omitted|placeholder|continuation|no additional code|fragment)[^\n]*|\/\*[\s\S]*(?:rest|remaining|same|previous|unchanged|omitted|placeholder|continuation|no additional code|fragment)[\s\S]*?\*\/)\s*;?\s*$/i;
const incompleteCodeChunkPattern = /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=.+;?\s*$/s;
const toolHistoryPlaceholderPattern = /^\s*\[(?:see|continued|continues?|omitted|truncated|same|previous|rest|remaining)[^\]]*\]\s*$/i;
const hasTopLevelReturnPattern = /\breturn\s+/;
const allowedHostCapabilities = new Set(['sendPrompt', 'selectSnapshot', 'exportCanvasPng']);
const componentMetaInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'archetype', 'userVisibleGoal', 'behavioralRequirements', 'acceptanceCriteria'],
  properties: {
    category: { type: 'string' },
    archetype: { type: 'string' },
    userVisibleGoal: { type: 'string' },
    behavioralRequirements: stringArrayInputSchema,
    acceptanceCriteria: stringArrayInputSchema,
  },
} as const;
const generatedComponentPropsInputSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['name', 'code', 'mountProps', 'capabilities', 'componentMeta'],
  properties: {
    name: { type: 'string' },
    code: { type: 'string' },
    mountProps: recordInputSchema,
    capabilities: stringArrayInputSchema,
    componentMeta: componentMetaInputSchema,
  },
} as const;
const pageNodeInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'props', 'styleTokens', 'children'],
  properties: {
    id: { type: 'string' },
    type: {
      type: 'string',
      enum: [
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
      ],
    },
    props: {
      anyOf: [generatedComponentPropsInputSchema, recordInputSchema],
    },
    styleTokens: recordInputSchema,
    behavior: recordInputSchema,
    children: { type: 'array', maxItems: 0 },
  },
} as const;
const targetInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['parentId'],
  properties: {
    parentId: { type: 'string' },
    index: { type: 'number' },
  },
} as const;

const submitNoChangesTool: PatchToolDefinition = {
  name: 'submit_no_changes',
  description: 'Submit an answer-only response with no page changes. Use only when the workflow task intent is answer_only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['assistantText', 'changeSummary'],
    properties: {
      assistantText: { type: 'string' },
      changeSummary: { type: 'string' },
    },
  },
};

const addStandardNodeTool: PatchToolDefinition = {
  name: 'add_standard_node',
  description:
    'Append one empty non-generated page node to the collected patch. children must be []. To build layout, add empty containers first, then move existing nodes into them with move_node. Do not use for generated_react_component; use component draft tools for that.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['target', 'node'],
    properties: {
      target: targetInputSchema,
      node: pageNodeInputSchema,
    },
  },
};

const updateNodeTool: PatchToolDefinition = {
  name: 'update_node',
  description:
    'Append one update_node operation to the collected patch. Include only changed props, styleTokens, or behavior fields.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    anyOf: [
      { required: ['props'] },
      { required: ['styleTokens'] },
      { required: ['behavior'] },
    ],
    properties: {
      nodeId: { type: 'string' },
      props: recordInputSchema,
      styleTokens: recordInputSchema,
      behavior: recordInputSchema,
    },
  },
};

const moveNodeTool: PatchToolDefinition = {
  name: 'move_node',
  description:
    'Append one move_node operation to the collected patch. Use this for layout/reordering moves instead of rewriting generated component code.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId', 'target'],
    properties: {
      nodeId: { type: 'string' },
      target: targetInputSchema,
    },
  },
};

const removeNodeTool: PatchToolDefinition = {
  name: 'remove_node',
  description: 'Append one remove_node operation to the collected patch.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
    },
  },
};

const setThemeTokensTool: PatchToolDefinition = {
  name: 'set_theme_tokens',
  description: 'Append one set_theme_tokens operation to the collected patch.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['theme'],
    properties: {
      theme: recordInputSchema,
    },
  },
};

const setBehaviorStateDefaultsTool: PatchToolDefinition = {
  name: 'set_behavior_state_defaults',
  description: 'Append one set_behavior_state_defaults operation to the collected patch.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['defaults'],
    properties: {
      defaults: recordInputSchema,
    },
  },
};

const submitCollectedPatchTool: PatchToolDefinition = {
  name: 'submit_collected_patch',
  description:
    'Submit all operations collected through add_standard_node/update_node/move_node/remove_node/set_theme_tokens/set_behavior_state_defaults.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['assistantText', 'changeSummary'],
    properties: {
      assistantText: { type: 'string' },
      changeSummary: { type: 'string' },
    },
  },
};

const createComponentDraftTool: PatchToolDefinition = {
  name: 'create_component_draft',
  description:
    'Create an in-memory draft for a new generated_react_component. Then append code chunks, validate, and submit_component_draft.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId', 'target', 'nodeId', 'name', 'mountProps', 'capabilities', 'styleTokens', 'componentMeta'],
    properties: {
      draftId: { type: 'string' },
      taskIndex: { type: 'number' },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['parentId'],
        properties: {
          parentId: { type: 'string' },
          index: { type: 'number' },
        },
      },
      nodeId: { type: 'string' },
      name: { type: 'string' },
      mountProps: recordInputSchema,
      capabilities: stringArrayInputSchema,
      styleTokens: recordInputSchema,
      componentMeta: componentMetaInputSchema,
    },
  },
};

const createComponentUpdateDraftTool: PatchToolDefinition = {
  name: 'create_component_update_draft',
  description:
    'Create an in-memory draft for updating one existing generated_react_component. It starts from the existing component code and metadata.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId', 'nodeId'],
    properties: {
      draftId: { type: 'string' },
      taskIndex: { type: 'number' },
      nodeId: { type: 'string' },
      name: { type: 'string' },
      mountProps: recordInputSchema,
      capabilities: stringArrayInputSchema,
      styleTokens: recordInputSchema,
      componentMeta: componentMetaInputSchema,
    },
  },
};

const updateComponentDraftMetadataTool: PatchToolDefinition = {
  name: 'update_component_draft_metadata',
  description:
    'Update generic component draft metadata such as target, name, mountProps, styleTokens, capabilities, or componentMeta. Use this when validation reports a bad target or stale metadata.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId'],
    properties: {
      draftId: { type: 'string' },
      taskIndex: { type: 'number' },
      target: targetInputSchema,
      nodeId: { type: 'string' },
      name: { type: 'string' },
      mountProps: recordInputSchema,
      capabilities: stringArrayInputSchema,
      styleTokens: recordInputSchema,
      componentMeta: componentMetaInputSchema,
    },
  },
};

const appendComponentCodeChunkTool: PatchToolDefinition = {
  name: 'append_component_code_chunk',
  description: `Append executable generated component code to a draft. Large inputs up to ${codeChunkMaxInputLength} characters are accepted and split internally; compact complete code is still preferred.`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId', 'codeChunk'],
    properties: {
      draftId: { type: 'string' },
      codeChunk: { type: 'string', maxLength: codeChunkMaxInputLength },
    },
  },
};

const readComponentDraftTool: PatchToolDefinition = {
  name: 'read_component_draft',
  description: 'Read component draft metadata and a code preview. Use fullCode=true only when complete code is needed for repair.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId'],
    properties: {
      draftId: { type: 'string' },
      fullCode: { type: 'boolean' },
    },
  },
};

const clearComponentCodeTool: PatchToolDefinition = {
  name: 'clear_component_code',
  description: 'Clear all code from a component draft so it can be rewritten after validation fails.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId'],
    properties: {
      draftId: { type: 'string' },
    },
  },
};

const validateComponentDraftTool: PatchToolDefinition = {
  name: 'validate_component_draft',
  description:
    'Validate a component draft using schema, sandbox safety, compile checks, and workflow patch contract verification.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId', 'assistantText', 'changeSummary'],
    properties: {
      draftId: { type: 'string' },
      assistantText: { type: 'string' },
      changeSummary: { type: 'string' },
    },
  },
};

const submitComponentDraftTool: PatchToolDefinition = {
  name: 'submit_component_draft',
  description: 'Submit a validated component draft as the final page patch. Use only after validate_component_draft returns ok=true.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['draftId', 'assistantText', 'changeSummary'],
    properties: {
      draftId: { type: 'string' },
      assistantText: { type: 'string' },
      changeSummary: { type: 'string' },
    },
  },
};

const submitPreparedPatchTool: PatchToolDefinition = {
  name: 'submit_prepared_patch',
  description:
    'Submit the latest server-prepared patch from prior tool results. Use this when an image/background patch was already prepared; do not reconstruct the patch array.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['assistantText', 'changeSummary'],
    properties: {
      assistantText: { type: 'string' },
      changeSummary: { type: 'string' },
    },
  },
};

const getComponentDetailTool: PatchToolDefinition = {
  name: 'get_component_detail',
  description: 'Return complete detail for one existing target component, including code, mountProps, styleTokens, and componentMeta.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['nodeId'],
    properties: {
      nodeId: { type: 'string' },
    },
  },
};

function shouldExposeComponentDetailTool(plan: WorkflowPlan): boolean {
  return plan.tasks.some((task) => task.subject === 'existing_component' && Boolean(task.targetNodeId));
}

function shouldUseGeneratedComponentTool(plan: WorkflowPlan): boolean {
  return plan.tasks.some((task) => task.intent === 'create' && task.subject === 'new_component' && task.requiresGeneratedCode);
}

function shouldUseGeneratedComponentUpdateTool(plan: WorkflowPlan, pageState: PageState): boolean {
  return plan.tasks.some((task) => {
    if (
      task.subject !== 'existing_component' ||
      task.intent === 'remove' ||
      task.intent === 'move' ||
      !task.shouldRewriteComponentCode ||
      !task.targetNodeId
    ) {
      return false;
    }
    return findNodeById(pageState.root, task.targetNodeId)?.type === 'generated_react_component';
  });
}

function taskUsesGeneratedComponentDraft(task: WorkflowPlan['tasks'][number], pageState: PageState): boolean {
  if (task.intent === 'create' && task.subject === 'new_component' && task.requiresGeneratedCode) {
    return true;
  }
  if (
    task.subject === 'existing_component' &&
    task.intent !== 'remove' &&
    task.intent !== 'move' &&
    task.shouldRewriteComponentCode &&
    task.targetNodeId
  ) {
    return findNodeById(pageState.root, task.targetNodeId)?.type === 'generated_react_component';
  }
  return false;
}

function shouldExposeOperationToolsWithDraft(plan: WorkflowPlan, pageState: PageState): boolean {
  return plan.tasks.some((task) => {
    if (task.intent === 'answer_only') {
      return false;
    }
    if (!taskUsesGeneratedComponentDraft(task, pageState)) {
      return true;
    }
    return Boolean(
      task.intent === 'create' &&
        task.subject === 'new_component' &&
        task.referenceNodeId &&
        task.relationToReference !== 'none' &&
        task.relationToReference !== 'inside',
    );
  });
}

function shouldExposePreparedPatchTool(toolResults?: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>): boolean {
  return Boolean(toolResults && getCandidatePatch(toolResults));
}

type DraftTaskEntry = {
  taskIndex: number;
  task: WorkflowPlan['tasks'][number];
};

function getDraftTaskEntries(plan: WorkflowPlan, pageState: PageState): DraftTaskEntry[] {
  return plan.tasks
    .map((task, taskIndex) => ({ task, taskIndex }))
    .filter((entry) => taskUsesGeneratedComponentDraft(entry.task, pageState));
}

function draftMatchesTask(draft: ComponentDraft, entry: DraftTaskEntry): boolean {
  if (draft.taskIndex !== undefined) {
    return draft.taskIndex === entry.taskIndex;
  }
  if (entry.task.subject === 'existing_component' && entry.task.targetNodeId) {
    return draft.mode === 'update' && draft.nodeId === entry.task.targetNodeId;
  }
  return (
    draft.mode === 'create' &&
    draft.componentMeta.category === entry.task.componentCategory &&
    draft.componentMeta.archetype === entry.task.componentArchetype
  );
}

function getComponentDrafts(args: NativePatchArgs): ComponentDraft[] {
  return [...(args.componentDrafts?.values() ?? [])];
}

function findDraftForTask(args: NativePatchArgs, entry: DraftTaskEntry): ComponentDraft | undefined {
  return getComponentDrafts(args).find((draft) => draftMatchesTask(draft, entry));
}

function inferDraftTaskIndex(
  args: NativePatchArgs,
  mode: ComponentDraftMode,
  input: { nodeId?: string; componentMeta?: ComponentDraftMeta },
): number | undefined {
  const entries = getDraftTaskEntries(args.plan, args.pageState);
  const existingIndexes = new Set(getComponentDrafts(args).map((draft) => draft.taskIndex).filter((index): index is number => index !== undefined));
  const unclaimedEntries = entries.filter((entry) => !existingIndexes.has(entry.taskIndex));
  if (mode === 'update' && input.nodeId) {
    return unclaimedEntries.find((entry) => entry.task.targetNodeId === input.nodeId)?.taskIndex;
  }
  if (mode === 'create' && input.componentMeta) {
    const exact = unclaimedEntries.filter(
      (entry) =>
        entry.task.intent === 'create' &&
        entry.task.subject === 'new_component' &&
        entry.task.componentCategory === input.componentMeta?.category &&
        entry.task.componentArchetype === input.componentMeta?.archetype,
    );
    if (exact.length === 1) {
      return exact[0].taskIndex;
    }
    return unclaimedEntries.find((entry) => entry.task.intent === 'create' && entry.task.subject === 'new_component')?.taskIndex;
  }
  return unclaimedEntries[0]?.taskIndex;
}

function currentDraftTaskEntry(args: NativePatchArgs, plan: WorkflowPlan, pageState: PageState): DraftTaskEntry | undefined {
  const entries = getDraftTaskEntries(plan, pageState);
  return (
    entries.find((entry) => !findDraftForTask(args, entry)) ??
    entries.find((entry) => {
      const draft = findDraftForTask(args, entry);
      return Boolean(draft && !args.validatedComponentDraftIds?.has(draft.draftId));
    })
  );
}

function currentComponentDraft(args: NativePatchArgs, plan: WorkflowPlan, pageState: PageState): ComponentDraft | undefined {
  const currentEntry = currentDraftTaskEntry(args, plan, pageState);
  if (currentEntry) {
    return findDraftForTask(args, currentEntry);
  }
  return getComponentDrafts(args)[0];
}

function getDraftCodeState(args: NativePatchArgs, draft: ComponentDraft): DraftCodeState {
  if (args.validatedComponentDraftIds?.has(draft.draftId)) {
    return 'validated';
  }
  if (draft.code.trim().length === 0) {
    return 'empty';
  }
  if (args.failedComponentDraftIds?.has(draft.draftId)) {
    return 'failed_validation';
  }
  if (hasTopLevelReturnPattern.test(draft.code)) {
    return 'complete_unvalidated';
  }
  return 'incomplete';
}

function allRequiredComponentDraftsValidated(args: NativePatchArgs, plan: WorkflowPlan, pageState: PageState): boolean {
  const entries = getDraftTaskEntries(plan, pageState);
  return entries.length > 0 && entries.every((entry) => {
    const draft = findDraftForTask(args, entry);
    return Boolean(draft && args.validatedComponentDraftIds?.has(draft.draftId));
  });
}

function buildOperationCollectionTools(plan: WorkflowPlan): PatchToolDefinition[] {
  const tools = [
    addStandardNodeTool,
    updateNodeTool,
    moveNodeTool,
    removeNodeTool,
    setThemeTokensTool,
    setBehaviorStateDefaultsTool,
  ];
  return shouldExposeComponentDetailTool(plan) ? [...tools, getComponentDetailTool] : tools;
}

function buildReferenceLayoutTools(): PatchToolDefinition[] {
  return [addStandardNodeTool, moveNodeTool];
}

function buildPatchTools(
  plan: WorkflowPlan,
  pageState: PageState,
  toolResults?: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
): PatchToolDefinition[] {
  if (shouldExposePreparedPatchTool(toolResults)) {
    return [submitPreparedPatchTool];
  }
  if (plan.tasks.every((task) => task.intent === 'answer_only')) {
    return [submitNoChangesTool];
  }
  if (shouldUseGeneratedComponentTool(plan)) {
    return [
      createComponentDraftTool,
      appendComponentCodeChunkTool,
      readComponentDraftTool,
      clearComponentCodeTool,
      validateComponentDraftTool,
      submitComponentDraftTool,
    ];
  }
  if (shouldUseGeneratedComponentUpdateTool(plan, pageState)) {
    return [
      createComponentUpdateDraftTool,
      appendComponentCodeChunkTool,
      readComponentDraftTool,
      clearComponentCodeTool,
      validateComponentDraftTool,
      submitComponentDraftTool,
      getComponentDetailTool,
    ];
  }
  return [...buildOperationCollectionTools(plan), submitCollectedPatchTool];
}

function getPatchToolStage(
  args: NativePatchArgs,
  plan: WorkflowPlan,
  pageState: PageState,
  toolResults?: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
): PatchToolStage {
  if (shouldExposePreparedPatchTool(toolResults)) {
    return 'prepared_patch';
  }
  if (plan.tasks.every((task) => task.intent === 'answer_only')) {
    return 'answer_only';
  }

  const draftTasks = getDraftTaskEntries(plan, pageState);
  if (draftTasks.length === 0) {
    return 'operation';
  }
  if (allRequiredComponentDraftsValidated(args, plan, pageState)) {
    if (tasksNeedingReferenceLayout(args).length > 0 && !collectedPatchHasRequiredReferenceMoves(args)) {
      return 'layout_draft';
    }
    return 'submit_draft';
  }
  const currentEntry = currentDraftTaskEntry(args, plan, pageState);
  if (!currentEntry) {
    return 'submit_draft';
  }
  const draft = findDraftForTask(args, currentEntry);
  if (!draft) {
    return currentEntry.task.intent === 'create' && currentEntry.task.subject === 'new_component' ? 'create_draft' : 'update_draft';
  }
  return 'code_draft';
}

function buildPatchToolsForTurn(
  args: NativePatchArgs,
  plan: WorkflowPlan,
  pageState: PageState,
  toolResults?: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
): PatchToolDefinition[] {
  const stage = getPatchToolStage(args, plan, pageState, toolResults);
  if (stage === 'prepared_patch') {
    return [submitPreparedPatchTool];
  }
  if (stage === 'answer_only') {
    return [submitNoChangesTool];
  }
  if (stage === 'operation') {
    if ((args.collectedPatch?.length ?? 0) > 0) {
      return [submitCollectedPatchTool];
    }
    return buildPatchTools(plan, pageState, toolResults);
  }
  if (stage === 'create_draft') {
    return [createComponentDraftTool];
  }
  if (stage === 'update_draft') {
    return [createComponentUpdateDraftTool, getComponentDetailTool];
  }
  if (stage === 'submit_draft') {
    if ((args.collectedPatch?.length ?? 0) > 0) {
      return [submitComponentDraftTool, readComponentDraftTool];
    }
    return shouldExposeOperationToolsWithDraft(plan, pageState)
      ? [...buildOperationCollectionTools(plan), submitComponentDraftTool, readComponentDraftTool]
      : [submitComponentDraftTool, readComponentDraftTool];
  }
  if (stage === 'layout_draft') {
    return [...buildReferenceLayoutTools(), readComponentDraftTool];
  }
  const draft = currentComponentDraft(args, plan, pageState);
  if (draft && args.clearRequiredComponentDraftIds?.has(draft.draftId)) {
    return [clearComponentCodeTool, readComponentDraftTool];
  }
  if (draft && draft.code.length === 0) {
    return [appendComponentCodeChunkTool, validateComponentDraftTool];
  }
  if (draft && getDraftCodeState(args, draft) === 'complete_unvalidated') {
    if (draft.mode === 'update' && !draft.codeModified) {
      return [clearComponentCodeTool, validateComponentDraftTool, readComponentDraftTool];
    }
    return [validateComponentDraftTool, readComponentDraftTool];
  }
  const draftTools = [
    updateComponentDraftMetadataTool,
    appendComponentCodeChunkTool,
    readComponentDraftTool,
    clearComponentCodeTool,
    validateComponentDraftTool,
    submitComponentDraftTool,
  ];
  return draftTools;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeNativeToolValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeNativeToolValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'item' && Array.isArray(record.item)) {
    return record.item.map(normalizeNativeToolValue);
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, nestedValue]) => [key, normalizeNativeToolValue(nestedValue)]),
  );
}

function parseDraftStyleTokens(value: Record<string, unknown>): Record<string, unknown> {
  const parsed = styleTokensSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  const invalidKeys = [
    ...new Set(
      parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((key): key is string | number => typeof key === 'string' || typeof key === 'number')
        .map(String),
    ),
  ];
  const nestedKeys = Object.entries(value)
    .filter(([, nestedValue]) => nestedValue !== null && typeof nestedValue === 'object')
    .map(([key]) => key);
  const keys = [...new Set([...invalidKeys, ...nestedKeys])];
  throw new Error(
    [
      'Invalid component draft styleTokens.',
      'styleTokens must be a flat object of CSS property names to string or number values.',
      'Nested objects and arrays are not supported.',
      keys.length ? `Invalid keys: ${keys.join(', ')}.` : '',
      'Use flat keys such as fontSize, fontWeight, lineHeight, background, border, width, maxWidth, minHeight, position, top, left, or put complex styling inside the generated component code.',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

const componentMetaSchema = z
  .object({
    category: z.string(),
    archetype: z.string(),
    userVisibleGoal: z.string(),
    behavioralRequirements: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
  })
  .strict();

const targetSchema = z
  .object({
    parentId: z.string(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict();

const createComponentDraftToolInputSchema = z
  .object({
    draftId: z.string(),
    taskIndex: z.number().int().nonnegative().optional(),
    target: targetSchema,
    nodeId: z.string(),
    name: z.string(),
    mountProps: z.record(z.unknown()),
    capabilities: z.array(z.string()),
    styleTokens: z.record(z.unknown()),
    componentMeta: componentMetaSchema,
  })
  .strict();

const createComponentUpdateDraftToolInputSchema = z
  .object({
    draftId: z.string(),
    taskIndex: z.number().int().nonnegative().optional(),
    nodeId: z.string(),
    name: z.string().optional(),
    mountProps: z.record(z.unknown()).optional(),
    capabilities: z.array(z.string()).optional(),
    styleTokens: z.record(z.unknown()).optional(),
    componentMeta: componentMetaSchema.optional(),
  })
  .strict();

const updateComponentDraftMetadataToolInputSchema = z
  .object({
    draftId: z.string(),
    taskIndex: z.number().int().nonnegative().optional(),
    target: targetSchema.optional(),
    nodeId: z.string().optional(),
    name: z.string().optional(),
    mountProps: z.record(z.unknown()).optional(),
    capabilities: z.array(z.string()).optional(),
    styleTokens: z.record(z.unknown()).optional(),
    componentMeta: componentMetaSchema.optional(),
  })
  .strict();

const appendComponentCodeChunkToolInputSchema = z
  .object({
    draftId: z.string(),
    codeChunk: z.string().max(codeChunkMaxInputLength),
  })
  .strict();

const readComponentDraftToolInputSchema = z
  .object({
    draftId: z.string(),
    fullCode: z.boolean().optional(),
  })
  .strict();

const draftIdOnlyToolInputSchema = z
  .object({
    draftId: z.string(),
  })
  .strict();

const validateOrSubmitComponentDraftToolInputSchema = z
  .object({
    draftId: z.string(),
    assistantText: z.string(),
    changeSummary: z.string(),
  })
  .strict();

const preparedPatchToolInputSchema = z
  .object({
    assistantText: z.string(),
    changeSummary: z.string(),
  })
  .strict();

const noChangesToolInputSchema = preparedPatchToolInputSchema;

function recordHasKeys(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0);
}

function behaviorHasMeaningfulKeys(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value && Object.entries(value).some(([key, nestedValue]) => !(key === 'kind' && nestedValue === 'none') && nestedValue !== undefined));
}

const addStandardNodeToolInputSchema = z
  .object({
    target: targetSchema,
    node: z
      .object({
        type: z.string(),
        children: z.array(z.never()).max(0, {
          message:
            'add_standard_node only creates one empty node at a time; set children: [] and use later add_standard_node/move_node calls for children.',
        }),
      })
      .passthrough()
      .refine((node) => node.type !== 'generated_react_component', {
        message: 'add_standard_node cannot add generated_react_component; use component draft tools.',
      }),
  })
  .strict();

const updateNodeToolInputSchema = z
  .object({
    nodeId: z.string(),
    props: z.record(z.unknown()).optional(),
    styleTokens: z.record(z.unknown()).optional(),
    behavior: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine(
    (value) =>
      recordHasKeys(value.props) ||
      recordHasKeys(value.styleTokens) ||
      behaviorHasMeaningfulKeys(value.behavior),
    {
      message: 'update_node requires at least one of props, styleTokens, or behavior.',
    },
  );

const moveNodeToolInputSchema = z
  .object({
    nodeId: z.string(),
    target: targetSchema,
  })
  .strict();

const removeNodeToolInputSchema = z
  .object({
    nodeId: z.string(),
  })
  .strict();

const setThemeTokensToolInputSchema = z
  .object({
    theme: z.record(z.unknown()),
  })
  .strict();

const setBehaviorStateDefaultsToolInputSchema = z
  .object({
    defaults: z.record(z.string()),
  })
  .strict();

const submitCollectedPatchToolInputSchema = preparedPatchToolInputSchema;

function numericInput(value: unknown, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function styleTokenFromBehavior(value: unknown): Record<string, unknown> {
  const behavior = asRecord(value);
  const layout = typeof behavior.layout === 'string' ? behavior.layout : '';
  const next: Record<string, unknown> = {};
  if (layout.includes('flex')) {
    next.display = 'flex';
    next.flexDirection = layout.includes('column') ? 'column' : 'row';
  }
  if (layout.includes('grid')) {
    next.display = 'grid';
    next.gridTemplateColumns = `repeat(${Math.max(1, Math.min(4, Math.round(numericInput(behavior.columns, 2))))}, minmax(0, 1fr))`;
  }
  if (behavior.columnGap !== undefined || behavior.gap !== undefined) {
    next.gap = typeof behavior.columnGap === 'number' ? `${behavior.columnGap}px` : behavior.columnGap ?? behavior.gap;
  }
  if (typeof behavior.alignItems === 'string') {
    next.alignItems = behavior.alignItems;
  }
  if (typeof behavior.justifyContent === 'string') {
    next.justifyContent = behavior.justifyContent;
  }
  if (behavior.flexWrap !== undefined) {
    next.flexWrap = String(behavior.flexWrap);
  }
  return next;
}

function normalizeStandardNodeForCollectedTool(rawNode: Record<string, unknown>): Record<string, unknown> {
  const type = typeof rawNode.type === 'string' ? rawNode.type : 'section';
  const props = asRecord(rawNode.props);
  const styleTokens = {
    ...asRecord(rawNode.styleTokens),
    ...styleTokenFromBehavior(rawNode.behavior),
  };
  const base = {
    ...rawNode,
    props,
    styleTokens,
    children: [],
  };

  if (type === 'columns') {
    return {
      ...base,
      props: {
        columns: Math.max(2, Math.min(4, Math.round(numericInput(props.columns ?? asRecord(rawNode.behavior).columns, 2)))),
      },
      behavior: undefined,
    };
  }

  if (type !== 'generated_react_component') {
    const {
      name: _name,
      code: _code,
      mountProps: _mountProps,
      capabilities: _capabilities,
      componentMeta: _componentMeta,
      ...standardProps
    } = props;
    const standardNode = {
      ...base,
      props: standardProps,
      behavior: undefined,
    };
    if (type === 'section' && Object.keys(standardNode.styleTokens).length === 0 && Object.keys(styleTokenFromBehavior(rawNode.behavior)).length > 0) {
      standardNode.styleTokens = styleTokenFromBehavior(rawNode.behavior);
    }
    return standardNode;
  }

  return base;
}

function draftFromPreparedPatchInput(
  input: Record<string, unknown>,
  toolResults?: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
): PatchResponseDraft {
  const parsed = preparedPatchToolInputSchema.parse(input);
  const patch = toolResults ? getCandidatePatch(toolResults) : null;
  if (!patch) {
    throw new Error('No server-prepared patch is available.');
  }
  return {
    assistantText: parsed.assistantText,
    changeSummary: parsed.changeSummary,
    patch,
  };
}

function draftFromNoChangesInput(input: Record<string, unknown>): PatchResponseDraft {
  const parsed = noChangesToolInputSchema.parse(input);
  return {
    assistantText: parsed.assistantText,
    changeSummary: parsed.changeSummary,
    patch: [],
  };
}

function operationFromCollectedTool(tool: PatchToolName, input: Record<string, unknown>): PagePatchOperation {
  let operation: PagePatchOperation;
  if (tool === 'add_standard_node') {
    const parsed = addStandardNodeToolInputSchema.parse(input);
    operation = {
      type: 'add_node',
      target: parsed.target,
      node: normalizeStandardNodeForCollectedTool(parsed.node as Record<string, unknown>),
    } as PagePatchOperation;
    return validatePatchOperations([operation])[0];
  }

  if (tool === 'update_node') {
    const parsed = updateNodeToolInputSchema.parse(input);
    operation = {
      type: 'update_node',
      nodeId: parsed.nodeId,
      ...(parsed.props !== undefined ? { props: parsed.props } : {}),
      ...(parsed.styleTokens !== undefined ? { styleTokens: parsed.styleTokens } : {}),
      ...(parsed.behavior !== undefined ? { behavior: parsed.behavior } : {}),
    } as PagePatchOperation;
    return validatePatchOperations([operation])[0];
  }

  if (tool === 'move_node') {
    const parsed = moveNodeToolInputSchema.parse(input);
    operation = {
      type: 'move_node',
      nodeId: parsed.nodeId,
      target: parsed.target,
    };
    return validatePatchOperations([operation])[0];
  }

  if (tool === 'remove_node') {
    const parsed = removeNodeToolInputSchema.parse(input);
    operation = {
      type: 'remove_node',
      nodeId: parsed.nodeId,
    };
    return validatePatchOperations([operation])[0];
  }

  if (tool === 'set_theme_tokens') {
    const parsed = setThemeTokensToolInputSchema.parse(input);
    operation = {
      type: 'set_theme_tokens',
      theme: parsed.theme,
    } as PagePatchOperation;
    return validatePatchOperations([operation])[0];
  }

  if (tool === 'set_behavior_state_defaults') {
    const parsed = setBehaviorStateDefaultsToolInputSchema.parse(input);
    operation = {
      type: 'set_behavior_state_defaults',
      defaults: parsed.defaults,
    };
    return validatePatchOperations([operation])[0];
  }

  throw new Error(`Tool ${tool} does not collect patch operations.`);
}

function collectRenderableNodeSummaries(pageState: PageState): Array<{ id: string; type: string; name: string }> {
  const components = asRecord(listComponents(pageState).data).components;
  return Array.isArray(components)
    ? components
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .filter((item) => item.type !== 'system_prompt' && item.type !== 'system_timeline')
        .map((item) => ({
          id: String(item.id ?? ''),
          type: String(item.type ?? ''),
          name: String(item.name ?? ''),
        }))
    : [];
}

function enrichOperationWorkspaceError(args: NativePatchArgs, tool: PatchToolName, input: Record<string, unknown>, message: string): string {
  const details: string[] = [message];
  if (tool === 'move_node' || tool === 'update_node' || tool === 'remove_node') {
    const nodeId = typeof input.nodeId === 'string' ? input.nodeId : '';
    if (nodeId && !findNodeById(args.pageState.root, nodeId)) {
      details.push(`No existing node has nodeId "${nodeId}".`);
    }
  }
  const target = asRecord(input.target);
  const parentId = typeof target.parentId === 'string' ? target.parentId : '';
  if ((tool === 'add_standard_node' || tool === 'move_node') && parentId && !findNodeById(args.pageState.root, parentId)) {
    const createdInWorkspace = args.collectedPatch?.some(
      (operation) => operation.type === 'add_node' && operation.node.id === parentId,
    );
    if (!createdInWorkspace) {
      details.push(`No existing or collected parent node has parentId "${parentId}".`);
    }
  }
  details.push(`Use exact ids from the current component inventory: ${JSON.stringify(collectRenderableNodeSummaries(args.pageState))}.`);
  if (tool === 'move_node') {
    details.push('When moving into a new layout container, first call add_standard_node to create that container, then call move_node with target.parentId set to the new container id.');
  }
  return details.join(' ');
}

function draftFromCollectedPatchInput(input: Record<string, unknown>, collectedPatch?: PagePatchOperation[]): PatchResponseDraft {
  const parsed = submitCollectedPatchToolInputSchema.parse(input);
  if (!collectedPatch?.length) {
    throw new Error('submit_collected_patch requires at least one collected operation. Call add_standard_node, update_node, move_node, remove_node, set_theme_tokens, or set_behavior_state_defaults before submitting.');
  }
  return {
    assistantText: parsed.assistantText,
    changeSummary: parsed.changeSummary,
    patch: collectedPatch ?? [],
  };
}

function withCollectedPatch(draft: PatchResponseDraft, collectedPatch?: PagePatchOperation[]): PatchResponseDraft {
  if (!collectedPatch?.length) {
    return draft;
  }
  return {
    ...draft,
    patch: [...draft.patch, ...collectedPatch],
  };
}

function assertCollectedPatchCanApply(args: NativePatchArgs): void {
  if (!args.collectedPatch?.length) {
    return;
  }
  const draftBasePatch =
    allRequiredComponentDraftsValidated(args, args.plan, args.pageState)
      ? buildPatchForDrafts(getDraftTaskEntries(args.plan, args.pageState).map((entry) => {
          const draft = findDraftForTask(args, entry);
          if (!draft) {
            throw new Error(`Missing component draft for task ${entry.taskIndex} (${entry.task.componentArchetype}).`);
          }
          return draft;
        }))
      : [];
  applyPatchOperations(args.pageState, [...draftBasePatch, ...args.collectedPatch]);
}

function getComponentDraft(args: NativePatchArgs, draftId: string): ComponentDraft {
  const draft = args.componentDrafts?.get(draftId);
  if (!draft) {
    throw new Error(`Component draft not found: ${draftId}`);
  }
  return draft;
}

function assertValidDraftTarget(args: NativePatchArgs, target: { parentId: string; index?: number }): void {
  const parent = findNodeById(args.pageState.root, target.parentId);
  if (!parent) {
    throw new Error(`Parent node not found: ${target.parentId}. Use parentId "root" or an existing rendered container id.`);
  }
  if (parent.type === 'system_prompt' || parent.type === 'system_timeline') {
    throw new Error(`Parent node ${target.parentId} is a system node and does not render children. Use parentId "root" or a rendered container id.`);
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function hostCapabilitiesOnly(value: unknown): string[] {
  return arrayOfStrings(value).filter((capability) => allowedHostCapabilities.has(capability));
}

function metaFromExisting(value: unknown, nodeId: string): ComponentDraftMeta {
  const meta = asRecord(value);
  return {
    category: typeof meta.category === 'string' ? meta.category : 'unknown',
    archetype: typeof meta.archetype === 'string' ? meta.archetype : 'generated_component',
    userVisibleGoal: typeof meta.userVisibleGoal === 'string' ? meta.userVisibleGoal : `Update ${nodeId}`,
    behavioralRequirements: arrayOfStrings(meta.behavioralRequirements),
    acceptanceCriteria: arrayOfStrings(meta.acceptanceCriteria),
  };
}

function findMatchingCodeBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function unwrapSingleComponentFunctionBody(code: string): { code: string; unwrapped: boolean } {
  const wrapperStart =
    /^\s*function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.exec(code) ??
    /^\s*function\s*\([^)]*\)\s*\{/.exec(code) ??
    /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/.exec(code) ??
    /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/.exec(code);

  if (!wrapperStart) {
    return { code, unwrapped: false };
  }

  const openIndex = code.indexOf('{', wrapperStart[0].length - 1);
  if (openIndex < 0) {
    return { code, unwrapped: false };
  }

  const closeIndex = findMatchingCodeBrace(code, openIndex);
  if (closeIndex < 0) {
    return { code, unwrapped: false };
  }

  const trailing = code.slice(closeIndex + 1).trim();
  if (trailing && trailing !== ';') {
    return { code, unwrapped: false };
  }

  return { code: code.slice(openIndex + 1, closeIndex).trim(), unwrapped: true };
}

function draftToPatchResponseDraft(draft: ComponentDraft, assistantText: string, changeSummary: string): PatchResponseDraft {
  if (draft.mode === 'create') {
    if (!draft.target) {
      throw new Error(`Component draft ${draft.draftId} is missing target.`);
    }
    return {
      assistantText,
      changeSummary,
      patch: [
        {
          type: 'add_node',
          target: draft.target,
          node: {
            id: draft.nodeId,
            type: 'generated_react_component',
            props: {
              name: draft.name,
              code: draft.code,
              mountProps: draft.mountProps,
              capabilities: draft.capabilities,
              componentMeta: draft.componentMeta,
            },
            styleTokens: draft.styleTokens,
            children: [],
          },
        },
      ],
    };
  }

  return {
    assistantText,
    changeSummary,
    patch: [
      {
        type: 'update_node',
        nodeId: draft.nodeId,
        props: {
          name: draft.name,
          code: draft.code,
          mountProps: draft.mountProps,
          capabilities: draft.capabilities,
          componentMeta: draft.componentMeta,
        },
        styleTokens: draft.styleTokens,
      },
    ],
  };
}

function draftEntriesForDrafts(args: NativePatchArgs, drafts: ComponentDraft[]): DraftTaskEntry[] {
  const entries = getDraftTaskEntries(args.plan, args.pageState);
  return drafts.flatMap((draft) => {
    const entry = entries.find((candidate) => draftMatchesTask(draft, candidate));
    return entry ? [entry] : [];
  });
}

function planForDraftValidation(args: NativePatchArgs, drafts: ComponentDraft[]): WorkflowPlan {
  const entries = draftEntriesForDrafts(args, drafts);
  if (entries.length === 0) {
    return args.plan;
  }
  return {
    ...args.plan,
    tasks: entries.map((entry) => ({
      ...entry.task,
      referenceNodeId: undefined,
      relationToReference: 'none',
    })),
  };
}

function buildPatchForDrafts(drafts: ComponentDraft[]): PagePatchOperation[] {
  return drafts.flatMap((draft) => validatePatchOperations(draftToPatchResponseDraft(draft, '', '').patch));
}

function draftWorkspaceToPatchResponseDraft(args: NativePatchArgs, assistantText: string, changeSummary: string): PatchResponseDraft {
  const drafts = getDraftTaskEntries(args.plan, args.pageState).map((entry) => {
    const draft = findDraftForTask(args, entry);
    if (!draft) {
      throw new Error(`Missing component draft for task ${entry.taskIndex} (${entry.task.componentArchetype}).`);
    }
    if (!args.validatedComponentDraftIds?.has(draft.draftId)) {
      throw new Error(`Component draft ${draft.draftId} for task ${entry.taskIndex} has not validated successfully.`);
    }
    return draft;
  });
  return withCollectedPatch(
    {
      assistantText,
      changeSummary,
      patch: buildPatchForDrafts(drafts),
    },
    args.collectedPatch,
  );
}

function createComponentDraft(args: NativePatchArgs, input: Record<string, unknown>): Record<string, unknown> {
  const parsed = createComponentDraftToolInputSchema.parse(input);
  assertValidDraftTarget(args, parsed.target);
  const styleTokens = parseDraftStyleTokens(parsed.styleTokens);
  const draft: ComponentDraft = {
    draftId: parsed.draftId,
    mode: 'create',
    taskIndex: parsed.taskIndex ?? inferDraftTaskIndex(args, 'create', { componentMeta: parsed.componentMeta }),
    target: parsed.target,
    nodeId: parsed.nodeId,
    name: parsed.name,
    code: '',
    mountProps: parsed.mountProps,
    capabilities: hostCapabilitiesOnly(parsed.capabilities),
    styleTokens,
    componentMeta: parsed.componentMeta,
    codeModified: false,
  };
  args.componentDrafts?.set(parsed.draftId, draft);
  args.validatedComponentDraftIds?.delete(parsed.draftId);
  args.failedComponentDraftIds?.delete(parsed.draftId);
  args.clearRequiredComponentDraftIds?.delete(parsed.draftId);
  return { ok: true, draftId: draft.draftId, mode: draft.mode, taskIndex: draft.taskIndex, codeLength: draft.code.length };
}

function createComponentUpdateDraft(args: NativePatchArgs, input: Record<string, unknown>): Record<string, unknown> {
  const parsed = createComponentUpdateDraftToolInputSchema.parse(input);
  const node = findNodeById(args.pageState.root, parsed.nodeId);
  if (!node) {
    throw new Error(`Component not found: ${parsed.nodeId}`);
  }
  if (node.type !== 'generated_react_component') {
    throw new Error(`Component ${parsed.nodeId} is not a generated_react_component.`);
  }
  const styleTokens = parsed.styleTokens !== undefined ? parseDraftStyleTokens(parsed.styleTokens) : node.styleTokens;
  const draft: ComponentDraft = {
    draftId: parsed.draftId,
    mode: 'update',
    taskIndex: parsed.taskIndex ?? inferDraftTaskIndex(args, 'update', { nodeId: parsed.nodeId }),
    nodeId: parsed.nodeId,
    name: parsed.name ?? (typeof node.props.name === 'string' ? node.props.name : parsed.nodeId),
    code: typeof node.props.code === 'string' ? node.props.code : '',
    mountProps: parsed.mountProps ?? asRecord(node.props.mountProps),
    capabilities: parsed.capabilities ? hostCapabilitiesOnly(parsed.capabilities) : hostCapabilitiesOnly(node.props.capabilities),
    styleTokens,
    componentMeta: parsed.componentMeta ?? metaFromExisting(node.props.componentMeta, parsed.nodeId),
    codeModified: false,
  };
  args.componentDrafts?.set(parsed.draftId, draft);
  args.validatedComponentDraftIds?.delete(parsed.draftId);
  args.failedComponentDraftIds?.delete(parsed.draftId);
  args.clearRequiredComponentDraftIds?.delete(parsed.draftId);
  return { ok: true, draftId: draft.draftId, mode: draft.mode, taskIndex: draft.taskIndex, codeLength: draft.code.length };
}

function updateComponentDraftMetadata(args: NativePatchArgs, input: Record<string, unknown>): Record<string, unknown> {
  const parsed = updateComponentDraftMetadataToolInputSchema.parse(input);
  const draft = getComponentDraft(args, parsed.draftId);
  const styleTokens = parsed.styleTokens !== undefined ? parseDraftStyleTokens(parsed.styleTokens) : undefined;
  if (parsed.target) {
    if (draft.mode !== 'create') {
      throw new Error('Only create drafts have a target.');
    }
    assertValidDraftTarget(args, parsed.target);
    draft.target = parsed.target;
  }
  if (parsed.taskIndex !== undefined) {
    draft.taskIndex = parsed.taskIndex;
  }
  if (parsed.nodeId !== undefined) {
    draft.nodeId = parsed.nodeId;
  }
  if (parsed.name !== undefined) {
    draft.name = parsed.name;
  }
  if (parsed.mountProps !== undefined) {
    draft.mountProps = parsed.mountProps;
  }
  if (parsed.capabilities !== undefined) {
    draft.capabilities = hostCapabilitiesOnly(parsed.capabilities);
  }
  if (parsed.styleTokens !== undefined) {
    draft.styleTokens = styleTokens ?? {};
  }
  if (parsed.componentMeta !== undefined) {
    draft.componentMeta = parsed.componentMeta;
  }
  args.validatedComponentDraftIds?.delete(parsed.draftId);
  args.clearRequiredComponentDraftIds?.delete(parsed.draftId);
  return {
    ok: true,
    draftId: draft.draftId,
    mode: draft.mode,
    taskIndex: draft.taskIndex,
    nodeId: draft.nodeId,
    target: draft.target,
    codeLength: draft.code.length,
  };
}

function appendComponentCodeChunk(args: NativePatchArgs, input: Record<string, unknown>): Record<string, unknown> {
  const parsed = appendComponentCodeChunkToolInputSchema.parse(input);
  const draft = getComponentDraft(args, parsed.draftId);
  if (args.clearRequiredComponentDraftIds?.has(draft.draftId)) {
    throw new Error(
      `Draft ${draft.draftId} failed validation and must be cleared before rewriting. Call clear_component_code for ${draft.draftId}; append_component_code_chunk is intentionally unavailable until the draft is empty.`,
    );
  }
  if (summarizedCodeChunkMarkerPattern.test(parsed.codeChunk) || toolMarkupLeakPattern.test(parsed.codeChunk) || toolHistoryPlaceholderPattern.test(parsed.codeChunk)) {
    if (draft.code.trim().length > 0) {
      return {
        ok: true,
        draftId: draft.draftId,
        codeLength: draft.code.length,
        acceptedLength: 0,
        ignored: 'tool_history_placeholder',
        nextAction: 'Draft code was unchanged. Call validate_component_draft next, or clear_component_code before rewriting.',
      };
    }
    throw new Error(
      'codeChunk contains tool-history placeholder or tool-call markup, not executable component code. Do not replay omitted history text. Call read_component_draft if needed, or clear_component_code and append real JavaScript that returns a React element.',
    );
  }
  const normalized = draft.code.trim().length === 0 ? unwrapSingleComponentFunctionBody(parsed.codeChunk) : { code: parsed.codeChunk, unwrapped: false };
  if (placeholderCodeChunkPattern.test(normalized.code)) {
    if (draft.code.trim().length > 0 && hasTopLevelReturnPattern.test(draft.code)) {
      return {
        ok: true,
        draftId: draft.draftId,
        codeLength: draft.code.length,
        acceptedLength: 0,
        ignored: 'placeholder_after_complete_draft',
        nextAction: `Draft ${draft.draftId} was unchanged because it already contains a top-level return. Call validate_component_draft next, or clear_component_code before rewriting it.`,
      };
    }
    throw new Error(
      'codeChunk is a placeholder, omission marker, or rewrite note rather than executable component code. Append real JavaScript code, or call clear_component_code before rewriting the full draft.',
    );
  }
  if (draft.code.length + normalized.code.length > generatedComponentCodeMaxLength) {
    throw new Error(
      `Appending this code would make draft ${draft.draftId} ${draft.code.length + normalized.code.length} characters, exceeding the generated component code limit of ${generatedComponentCodeMaxLength}. Call clear_component_code and rewrite a compact complete component instead of appending another large version.`,
    );
  }
  if (draft.code.trim().length > 0 && hasTopLevelReturnPattern.test(draft.code)) {
    throw new Error(
      `Draft ${draft.draftId} already contains a top-level return and looks complete. Call validate_component_draft next, or clear_component_code before rewriting it.`,
    );
  }
  draft.code += normalized.code;
  draft.codeModified = true;
  args.validatedComponentDraftIds?.delete(parsed.draftId);
  args.failedComponentDraftIds?.delete(parsed.draftId);
  args.clearRequiredComponentDraftIds?.delete(parsed.draftId);
  return {
    ok: true,
    draftId: draft.draftId,
    codeLength: draft.code.length,
    acceptedLength: parsed.codeChunk.length,
    internalChunkCount: Math.max(1, Math.ceil(parsed.codeChunk.length / codeChunkSoftSplitLength)),
    ...(normalized.unwrapped ? { normalized: 'unwrapped_component_function_body' } : {}),
  };
}

function readComponentDraft(args: NativePatchArgs, input: Record<string, unknown>): Record<string, unknown> {
  const parsed = readComponentDraftToolInputSchema.parse(input);
  const draft = getComponentDraft(args, parsed.draftId);
  return {
    ok: true,
    draftId: draft.draftId,
    mode: draft.mode,
    taskIndex: draft.taskIndex,
    nodeId: draft.nodeId,
    name: draft.name,
    target: draft.target,
    codeLength: draft.code.length,
    codePreview: draft.code.slice(Math.max(0, draft.code.length - codePreviewLength)),
    ...(parsed.fullCode ? { code: draft.code } : {}),
    mountProps: draft.mountProps,
    capabilities: draft.capabilities,
    styleTokens: draft.styleTokens,
    componentMeta: draft.componentMeta,
  };
}

function clearComponentCode(args: NativePatchArgs, input: Record<string, unknown>): Record<string, unknown> {
  const parsed = draftIdOnlyToolInputSchema.parse(input);
  const draft = getComponentDraft(args, parsed.draftId);
  draft.code = '';
  draft.codeModified = true;
  args.validatedComponentDraftIds?.delete(parsed.draftId);
  args.failedComponentDraftIds?.delete(parsed.draftId);
  args.clearRequiredComponentDraftIds?.delete(parsed.draftId);
  return { ok: true, draftId: draft.draftId, codeLength: draft.code.length };
}

function draftFromComponentDraft(args: NativePatchArgs, input: Record<string, unknown>): PatchResponseDraft {
  const parsed = validateOrSubmitComponentDraftToolInputSchema.parse(input);
  const draft = getComponentDraft(args, parsed.draftId);
  return withCollectedPatch(draftToPatchResponseDraft(draft, parsed.assistantText, parsed.changeSummary), args.collectedPatch);
}

function draftFromValidatedWorkspace(args: NativePatchArgs, input: Record<string, unknown>): PatchResponseDraft {
  const parsed = validateOrSubmitComponentDraftToolInputSchema.parse(input);
  return draftWorkspaceToPatchResponseDraft(args, parsed.assistantText, parsed.changeSummary);
}

function restoreDraftImageRefs(draft: PatchResponseDraft, imageRefs?: ImageRefMap): PatchResponseDraft {
  if (!imageRefs) {
    return draft;
  }
  const restoredPatch = z.array(z.unknown()).parse(restoreImageRefs(draft.patch, imageRefs));
  return {
    ...draft,
    patch: restoredPatch,
  };
}

function validateDraft(args: NativePatchArgs, draft: PatchResponseDraft): ValidationResult {
  return validateDraftWithPlan(args, draft, args.plan);
}

function validateDraftWithPlan(args: NativePatchArgs, draft: PatchResponseDraft, plan: WorkflowPlan): ValidationResult {
  try {
    const restoredDraft = restoreDraftImageRefs(draft, args.imageRefs);
    const patch = parseModelPatch(restoredDraft.patch);
    const response = aiMessageResponseSchema.parse({
      assistantText: restoredDraft.assistantText,
      changeSummary: restoredDraft.changeSummary,
      patch,
    });
    const transformedResponse = args.transformResponse ? args.transformResponse(response) : response;
    return {
      ok: true,
      response: preflightAiMessageResponse(args.pageState, transformedResponse, plan),
      draft: restoredDraft,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: enrichPatchValidationError(message),
      draft,
    };
  }
}

function serializeToolResultForModel(args: NativePatchArgs, result: Record<string, unknown>): string {
  return JSON.stringify(replaceImageDataUrlsWithRefs(result, args.imageRefs ?? new Map()));
}

function summarizeToolCallForModel(toolCall: NativeToolCall): NativeToolCall {
  if (toolCall.function.name !== 'append_component_code_chunk') {
    return toolCall;
  }

  try {
    const parsed = asRecord(JSON.parse(toolCall.function.arguments));
    const codeChunk = parsed.codeChunk;
    if (typeof codeChunk !== 'string' || codeChunk.length <= modelHistoryCodeChunkPreviewLength) {
      return toolCall;
    }

    const draftId = typeof parsed.draftId === 'string' ? parsed.draftId : 'unknown draft';
    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments: JSON.stringify({
          ...parsed,
          codeChunk: `[omitted ${codeChunk.length} character code chunk already appended to ${draftId}; call read_component_draft if exact code is needed, or clear_component_code before rewriting]`,
        }),
      },
    };
  } catch {
    return toolCall;
  }
}

function enrichPatchValidationError(message: string): string {
  if (/forbidden API: window|forbidden API: document|forbidden API: globalThis|forbidden API: self/.test(message)) {
    return `${message}\nGenerated component code runs in a sandboxed function. Do not use window, document, globalThis, or self. Use only the provided React runtime, helper bindings, props, theme, system, and sdk parameters.`;
  }
  if (/shadows reserved runtime binding|React redeclaration|React reassignment/.test(message)) {
    return `${message}\nDo not declare, assign, destructure, or pass reserved runtime/helper bindings: React, props, theme, system, sdk, createElement, useState, useEffect, useMemo, useCallback, or useRef. Use the provided bindings directly, for example useState(...) or React.useState(...).`;
  }
  if (/must return a React element|renderable value at top level|returned an empty array|returned an invalid React element/.test(message)) {
    return `${message}\nGenerated component code is a function body. It must execute a top-level return statement such as return React.createElement('section', ...). Defining a component function or constants without returning a React element is not enough.`;
  }
  return message;
}

function shouldClearAndRewriteDraftAfterValidationError(message: string): boolean {
  return /Generated component .* code (?:does not compile|failed render smoke test|shadows reserved runtime binding|uses forbidden API|must return a React element|returned an invalid React element|returned an empty array|returned no renderable value)|reserved runtime\/helper|Identifier '.+' has already been declared/.test(message);
}

function fallbackDraftSubmitText(args: NativePatchArgs): { assistantText: string; changeSummary: string } {
  const draftTasks = getDraftTaskEntries(args.plan, args.pageState);
  const visibleGoals = draftTasks
    .map((entry) => entry.task.userVisibleGoal.trim())
    .filter(Boolean);
  return {
    assistantText: '已完成。',
    changeSummary: visibleGoals.length > 0 ? visibleGoals.join('; ') : 'Submitted validated component draft.',
  };
}

function recoverValidatedDraftWorkspace(
  args: NativePatchArgs,
  assistantText?: string,
  changeSummary?: string,
): { ok: true; response: AiMessageResponse } | { ok: false; error?: string; skipped?: true } {
  const entries = getDraftTaskEntries(args.plan, args.pageState);
  if (entries.length === 0) {
    return { ok: false, skipped: true };
  }

  const drafts: ComponentDraft[] = [];
  for (const entry of entries) {
    const draft = findDraftForTask(args, entry);
    if (!draft || draft.code.trim().length === 0) {
      return { ok: false, skipped: true };
    }
    drafts.push(draft);
  }

  const fallbackText = fallbackDraftSubmitText(args);
  const safeAssistantText = assistantText?.trim() || fallbackText.assistantText;
  const safeChangeSummary = changeSummary?.trim() || fallbackText.changeSummary;

  try {
    for (const draft of drafts) {
      if (args.validatedComponentDraftIds?.has(draft.draftId)) {
        continue;
      }
      const candidate = withCollectedPatch(
        draftToPatchResponseDraft(draft, safeAssistantText, safeChangeSummary),
        args.collectedPatch,
      );
      const validation = validateDraftWithPlan(args, candidate, planForDraftValidation(args, [draft]));
      if (!validation.ok) {
        return { ok: false, error: validation.error };
      }
      args.validatedComponentDraftIds?.add(draft.draftId);
    }

    const workspaceDraft = draftWorkspaceToPatchResponseDraft(args, safeAssistantText, safeChangeSummary);
    const validation = validateDraft(args, workspaceDraft);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }
    return { ok: true, response: validation.response };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? enrichPatchValidationError(error.message) : String(error),
    };
  }
}

function fallbackCollectedPatchSubmitText(args: NativePatchArgs): { assistantText: string; changeSummary: string } {
  const visibleGoals = args.plan.tasks
    .map((task) => task.userVisibleGoal.trim())
    .filter(Boolean);
  return {
    assistantText: '已完成。',
    changeSummary: visibleGoals.length > 0 ? visibleGoals.join('; ') : 'Submitted collected page operations.',
  };
}

function recoverCollectedPatchWorkspace(
  args: NativePatchArgs,
  assistantText?: string,
  changeSummary?: string,
): { ok: true; response: AiMessageResponse } | { ok: false; error?: string; skipped?: true } {
  if (!args.collectedPatch?.length) {
    return { ok: false, skipped: true };
  }
  const fallbackText = fallbackCollectedPatchSubmitText(args);
  const draft: PatchResponseDraft = {
    assistantText: assistantText?.trim() || fallbackText.assistantText,
    changeSummary: changeSummary?.trim() || fallbackText.changeSummary,
    patch: args.collectedPatch,
  };
  const validation = validateDraft(args, draft);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  return { ok: true, response: validation.response };
}

function buildPatchSystemPrompt(stage: PatchToolStage): string {
  const base = [
    'You are a patch finalizer for a controlled React page builder.',
    'Call the provided native function tool. Do not answer with raw JSON, Markdown code, or a patch array.',
  ];
  if (stage === 'code_draft') {
    return [
      ...base,
      'Write generated component code into the existing draft, validate it, and repair validation errors with draft tools.',
      'Prefer a compact, complete first version over an elaborate component. Large code chunks are accepted and split internally, but shorter code validates faster.',
      'Generated code is executed by new Function with React, props, theme, system, sdk, and React helper bindings, and must return a React element at top level.',
      'You may use React.createElement/React.useState or the provided bare helpers createElement, useState, useEffect, useMemo, useCallback, and useRef.',
      'React, helper bindings, props, theme, system, and sdk are provided; do not redeclare, assign, shadow, destructure, or pass those binding names, and do not read them from window/globalThis/self.',
      `append_component_code_chunk accepts up to ${codeChunkMaxInputLength} characters per call, but the final draft code must stay under ${generatedComponentCodeMaxLength} characters.`,
      'Call validate_component_draft after writing code. If validation fails, clear or append as needed and validate again.',
    ].join('\n');
  }
  if (stage === 'submit_draft') {
    return [...base, 'All required component drafts have already validated successfully. Submit the draft workspace with submit_component_draft.'].join('\n');
  }
  if (stage === 'layout_draft') {
    return [
      ...base,
      'All required component drafts have already validated successfully, but required reference layout operations are still missing.',
      'Use only add_standard_node and move_node to create a real grid/flex/columns layout container and move the existing reference component plus the validated draft node into it.',
      'Do not call update_node for draft nodes; draft metadata/code is already complete.',
      'Do not submit the component draft in this turn; submit_component_draft is intentionally unavailable until layout operations are collected.',
    ].join('\n');
  }
  if (stage === 'operation') {
    return [
      ...base,
      'Use operation tools to collect page changes, then call submit_collected_patch.',
      'For layout, prefer: add_standard_node an empty section/columns container at parentId "root"; add child containers only as separate empty nodes if needed; then move_node existing components into those containers.',
      'Never put nested children inside add_standard_node. Its node.children must always be [].',
      'Never add nodes under system_prompt or system_timeline; they do not render children.',
    ].join('\n');
  }
  if (stage === 'prepared_patch') {
    return [...base, 'A server-prepared patch is available from prior tool results. Submit it with submit_prepared_patch.'].join('\n');
  }
  if (stage === 'answer_only') {
    return [...base, 'This task changes no page state. Call submit_no_changes.'].join('\n');
  }
  return [...base, 'Create the requested component draft metadata. Do not write component code in this tool call.'].join('\n');
}

function compactTaskContract(task: WorkflowPlan['tasks'][number]): Record<string, unknown> {
  return {
    intent: task.intent,
    subject: task.subject,
    targetNodeId: task.targetNodeId,
    referenceNodeId: task.referenceNodeId,
    relationToReference: task.relationToReference,
    componentCategory: task.componentCategory,
    componentArchetype: task.componentArchetype,
    userVisibleGoal: task.userVisibleGoal,
    behavioralRequirements: task.behavioralRequirements,
    visualRequirements: task.visualRequirements,
    acceptanceCriteria: task.acceptanceCriteria,
    imageTarget: task.imageTarget,
    requiresGeneratedCode: task.requiresGeneratedCode,
  };
}

function compactTaskContracts(args: NativePatchArgs): Array<Record<string, unknown>> {
  return args.plan.tasks.map(compactTaskContract);
}

function buildDraftSummary(draft?: ComponentDraft): Record<string, unknown> | undefined {
  if (!draft) {
    return undefined;
  }
  return {
    draftId: draft.draftId,
    mode: draft.mode,
    taskIndex: draft.taskIndex,
    nodeId: draft.nodeId,
    name: draft.name,
    target: draft.target,
    codeLength: draft.code.length,
    codePreview: draft.code.slice(Math.max(0, draft.code.length - codePreviewLength)),
    mountPropKeys: Object.keys(draft.mountProps),
    capabilityCount: draft.capabilities.length,
    styleTokenKeys: Object.keys(draft.styleTokens),
    componentMeta: {
      category: draft.componentMeta.category,
      archetype: draft.componentMeta.archetype,
      userVisibleGoal: draft.componentMeta.userVisibleGoal,
    },
  };
}

function buildDraftSummaries(args: NativePatchArgs): Array<Record<string, unknown> | undefined> {
  return getComponentDrafts(args).map(buildDraftSummary);
}

function tasksNeedingReferenceLayout(args: NativePatchArgs): Array<Record<string, unknown>> {
  return args.plan.tasks
    .filter(
      (task) =>
        task.intent === 'create' &&
        task.subject === 'new_component' &&
        task.referenceNodeId &&
        task.relationToReference !== 'none' &&
        task.relationToReference !== 'inside',
    )
    .map((task) => ({
      componentArchetype: task.componentArchetype,
      referenceNodeId: task.referenceNodeId,
      relationToReference: task.relationToReference,
      userVisibleGoal: task.userVisibleGoal,
    }));
}

function collectedPatchHasMoveForNode(collectedPatch: PagePatchOperation[] | undefined, nodeId: string): boolean {
  return Boolean(collectedPatch?.some((operation) => operation.type === 'move_node' && operation.nodeId === nodeId));
}

function collectedPatchHasRequiredReferenceMoves(args: NativePatchArgs): boolean {
  const entries = getDraftTaskEntries(args.plan, args.pageState).filter(
    (entry) =>
      entry.task.intent === 'create' &&
      entry.task.subject === 'new_component' &&
      Boolean(entry.task.referenceNodeId) &&
      entry.task.relationToReference !== 'none' &&
      entry.task.relationToReference !== 'inside',
  );
  if (entries.length === 0) {
    return true;
  }
  return entries.every((entry) => {
    const referenceNodeId = entry.task.referenceNodeId;
    const draft = findDraftForTask(args, entry);
    return Boolean(
      referenceNodeId &&
        draft &&
        collectedPatchHasMoveForNode(args.collectedPatch, referenceNodeId) &&
        collectedPatchHasMoveForNode(args.collectedPatch, draft.nodeId),
    );
  });
}

function buildCollectedPatchSummary(collectedPatch?: PagePatchOperation[]): Record<string, unknown> {
  const patch = collectedPatch ?? [];
  return {
    count: patch.length,
    operations: patch.map((operation) => {
      if (operation.type === 'add_node') {
        return { type: operation.type, nodeId: operation.node.id, nodeType: operation.node.type, target: operation.target };
      }
      if (operation.type === 'update_node') {
        return {
          type: operation.type,
          nodeId: operation.nodeId,
          props: operation.props ? Object.keys(operation.props) : [],
          styleTokens: operation.styleTokens ? Object.keys(operation.styleTokens) : [],
          behavior: operation.behavior ? Object.keys(operation.behavior) : [],
        };
      }
      if (operation.type === 'move_node') {
        return { type: operation.type, nodeId: operation.nodeId, target: operation.target };
      }
      if (operation.type === 'remove_node') {
        return { type: operation.type, nodeId: operation.nodeId };
      }
      return { type: operation.type };
    }),
  };
}

function buildPatchUserMessage(args: NativePatchArgs, stage: PatchToolStage): string {
  const currentEntry = currentDraftTaskEntry(args, args.plan, args.pageState);
  const draft = currentComponentDraft(args, args.plan, args.pageState);
  const tasks = compactTaskContracts(args);
  const parts: string[] = [`User request: ${args.prompt}`, `Task contract: ${JSON.stringify(tasks)}`];

  if (stage === 'create_draft') {
    parts.push(`Component inventory: ${JSON.stringify(listComponents(args.pageState))}`);
    parts.push(`Current draft task: ${JSON.stringify(currentEntry ? { taskIndex: currentEntry.taskIndex, task: compactTaskContract(currentEntry.task) } : null)}`);
    parts.push('Call create_component_draft for the current draft task. Include taskIndex when provided. Copy componentMeta from that task contract. Choose a stable nodeId. Use parentId "root" unless intentionally inserting inside a rendered non-system container.');
    return parts.join('\n\n');
  }

  if (stage === 'update_draft') {
    parts.push(`Component inventory: ${JSON.stringify(listComponents(args.pageState))}`);
    parts.push(`Current draft task: ${JSON.stringify(currentEntry ? { taskIndex: currentEntry.taskIndex, task: compactTaskContract(currentEntry.task) } : null)}`);
    parts.push('Call create_component_update_draft for the current target generated component. Include taskIndex when provided. Use get_component_detail first only if you need to inspect the existing code.');
    return parts.join('\n\n');
  }

  if (stage === 'code_draft') {
    parts.push(`Current draft task: ${JSON.stringify(currentEntry ? { taskIndex: currentEntry.taskIndex, task: compactTaskContract(currentEntry.task) } : null)}`);
    parts.push(`Draft: ${JSON.stringify(buildDraftSummary(draft))}`);
    parts.push(`Collected operations: ${JSON.stringify(buildCollectedPatchSummary(args.collectedPatch))}`);
    if (draft && args.clearRequiredComponentDraftIds?.has(draft.draftId)) {
      parts.push(`Repair required: draft ${draft.draftId} failed validation in a way that cannot be fixed by appending. Call clear_component_code for this draft before writing replacement code.`);
    }
    parts.push('If validation reports a bad draft target or metadata, call update_component_draft_metadata first. Call append_component_code_chunk with compact executable component code, then call validate_component_draft. Do not call read_component_draft unless validation fails or you truly need the draft preview.');
    if (args.extraContext) {
      parts.push(`Context: ${args.extraContext}`);
    }
    return parts.join('\n\n');
  }

  if (stage === 'submit_draft') {
    parts.push(`Drafts: ${JSON.stringify(buildDraftSummaries(args))}`);
    parts.push(`Collected operations: ${JSON.stringify(buildCollectedPatchSummary(args.collectedPatch))}`);
    const referenceLayoutTasks = tasksNeedingReferenceLayout(args);
    if (referenceLayoutTasks.length > 0 && (args.collectedPatch?.length ?? 0) === 0) {
      parts.push(`Reference layout still required: ${JSON.stringify(referenceLayoutTasks)}`);
      parts.push('Before submitting, use add_standard_node to create a real grid/flex/columns layout container, then move_node the new draft component and its reference component into that container in the requested order.');
    }
    parts.push('Validation passed for all required component drafts. If required non-code operations are still missing, collect them with operation tools first. Then call submit_component_draft once to submit the whole draft workspace.');
    return parts.join('\n\n');
  }

  if (stage === 'layout_draft') {
    parts.push(`Drafts: ${JSON.stringify(buildDraftSummaries(args))}`);
    parts.push(`Reference layout still required: ${JSON.stringify(tasksNeedingReferenceLayout(args))}`);
    parts.push(`Collected operations: ${JSON.stringify(buildCollectedPatchSummary(args.collectedPatch))}`);
    parts.push('Use add_standard_node to create one empty layout container at parentId "root" with display:grid/flex or type columns. Use move_node for both the existing reference component and the validated draft node into that container.');
    parts.push('The draft node id is available in the draft summary. It is not in current page state yet, but the patch workspace validates move_node for it by applying the draft add_node before collected layout operations.');
    return parts.join('\n\n');
  }

  if (stage === 'prepared_patch') {
    parts.push(`Prepared patch context: ${args.extraContext ?? 'available'}`);
    parts.push('Call submit_prepared_patch.');
    return parts.join('\n\n');
  }

  if (stage === 'answer_only') {
    parts.push('Call submit_no_changes with a concise user-facing answer.');
    return parts.join('\n\n');
  }

  parts.push(`Component inventory: ${JSON.stringify(listComponents(args.pageState))}`);
  if ((args.collectedPatch?.length ?? 0) > 0) {
    parts.push(`Collected operations: ${JSON.stringify(buildCollectedPatchSummary(args.collectedPatch))}`);
    parts.push('Call submit_collected_patch now. Do not collect more operations in this turn. If the collected patch is incomplete, submit it so the verifier can return a specific repair error.');
    return parts.join('\n\n');
  }
  if (args.extraContext) {
    parts.push(`Context: ${args.extraContext}`);
  }
  parts.push('Use the available operation tools, then submit_collected_patch.');
  parts.push('add_standard_node creates exactly one empty node; node.children must be []. Existing components are placed with move_node, not by embedding them in children.');
  return parts.join('\n\n');
}

function patchToolPriority(name: string): number {
  const priority: Record<string, number> = {
    get_component_detail: 0,
    create_component_draft: 1,
    create_component_update_draft: 1,
    update_component_draft_metadata: 2,
    clear_component_code: 3,
    append_component_code_chunk: 4,
    read_component_draft: 5,
    validate_component_draft: 6,
    submit_component_draft: 7,
    submit_prepared_patch: 7,
    submit_no_changes: 7,
    submit_collected_patch: 7,
  };
  return priority[name] ?? 4;
}

function orderToolCallsForExecution(toolCalls: NativeToolCall[]): NativeToolCall[] {
  return [...toolCalls].sort((left, right) => patchToolPriority(left.function.name) - patchToolPriority(right.function.name));
}

async function executeTool(args: NativePatchArgs, tool: PatchToolName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (
    tool === 'add_standard_node' ||
    tool === 'update_node' ||
    tool === 'move_node' ||
    tool === 'remove_node' ||
    tool === 'set_theme_tokens' ||
    tool === 'set_behavior_state_defaults'
  ) {
    try {
      const operation = operationFromCollectedTool(tool, input);
      args.collectedPatch?.push(operation);
      try {
        assertCollectedPatchCanApply(args);
      } catch (error) {
        args.collectedPatch?.pop();
        throw error;
      }
      return { ok: true, collectedPatchCount: args.collectedPatch?.length ?? 0 };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Tool input does not match the native operation schema or patch workspace state: ${enrichOperationWorkspaceError(args, tool, input, rawMessage)}`,
      };
    }
  }

  if (
    tool === 'create_component_draft' ||
    tool === 'create_component_update_draft' ||
    tool === 'update_component_draft_metadata' ||
    tool === 'append_component_code_chunk' ||
    tool === 'read_component_draft' ||
    tool === 'clear_component_code' ||
    tool === 'validate_component_draft'
  ) {
    try {
      if (tool === 'create_component_draft') {
        return createComponentDraft(args, input);
      }
      if (tool === 'create_component_update_draft') {
        return createComponentUpdateDraft(args, input);
      }
      if (tool === 'update_component_draft_metadata') {
        return updateComponentDraftMetadata(args, input);
      }
      if (tool === 'append_component_code_chunk') {
        return appendComponentCodeChunk(args, input);
      }
      if (tool === 'read_component_draft') {
        return readComponentDraft(args, input);
      }
      if (tool === 'clear_component_code') {
        return clearComponentCode(args, input);
      }
      const draft = draftFromComponentDraft(args, input);
      const parsed = validateOrSubmitComponentDraftToolInputSchema.parse(input);
      const componentDraft = getComponentDraft(args, parsed.draftId);
      const result = validateDraftWithPlan(args, draft, planForDraftValidation(args, [componentDraft]));
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          ...(shouldClearAndRewriteDraftAfterValidationError(result.error)
            ? {
                requiresClearAndRewrite: true,
                nextAction: `Call clear_component_code for ${parsed.draftId}, then append a complete corrected component body and validate again before submitting.`,
              }
            : {}),
        };
      }
      return { ok: true, patchCount: result.response.patch.length, changeSummary: result.response.changeSummary };
    } catch (error) {
      return {
        ok: false,
        error: `Component draft tool failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (
    tool === 'submit_component_draft' ||
    tool === 'submit_prepared_patch' ||
    tool === 'submit_no_changes' ||
    tool === 'submit_collected_patch'
  ) {
    let draft: PatchResponseDraft;
    try {
      if (tool === 'submit_component_draft') {
        draft = draftFromValidatedWorkspace(args, input);
      } else if (tool === 'submit_prepared_patch') {
        draft = draftFromPreparedPatchInput(input, args.toolResults);
      } else if (tool === 'submit_no_changes') {
        draft = draftFromNoChangesInput(input);
      } else if (tool === 'submit_collected_patch') {
        draft = draftFromCollectedPatchInput(input, args.collectedPatch);
      } else {
        throw new Error(`Unsupported submit tool: ${tool}`);
      }
    } catch (error) {
      return {
        ok: false,
        error: `Tool input does not match the native patch schema: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const result = validateDraft(args, draft);
    if (!result.ok) {
      return { ok: false, error: result.error, draft };
    }
    return { ok: true, patchCount: result.response.patch.length, changeSummary: result.response.changeSummary, draft };
  }

  if (tool === 'get_component_detail') {
    const nodeId = typeof input.nodeId === 'string' ? input.nodeId : '';
    return getComponentDetail(args.pageState, nodeId) as Record<string, unknown>;
  }

  return { ok: false, error: `Unknown tool: ${tool}` };
}

export async function generateNativeToolPatchResponse(args: NativePatchArgs): Promise<AiMessageResponse> {
  const maxAttempts = Number(process.env.AI_PATCH_REPAIR_ATTEMPTS ?? defaultPatchRepairAttempts);
  args.collectedPatch = [];
  args.componentDrafts = new Map();
  args.validatedComponentDraftIds = new Set();
  args.failedComponentDraftIds = new Set();
  args.clearRequiredComponentDraftIds = new Set();
  const loopMessages: NativeToolLoopMessage[] = [];
  let lastError = '';
  let lastToolSucceeded = false;

  const recoverExistingWorkspace = (assistantText?: string, changeSummary?: string) => {
    const recoveredCollectedPatch = recoverCollectedPatchWorkspace(args, assistantText, changeSummary);
    logWorkflow(args.workflowId ?? 'noctx', 'tool_result', {
      tool: 'collected_patch_recovery',
      ok: recoveredCollectedPatch.ok,
      error: recoveredCollectedPatch.ok ? undefined : recoveredCollectedPatch.error,
      skipped: recoveredCollectedPatch.ok ? undefined : recoveredCollectedPatch.skipped,
    });
    if (recoveredCollectedPatch.ok) {
      return recoveredCollectedPatch.response;
    }

    const recoveredDraft = recoverValidatedDraftWorkspace(args, assistantText, changeSummary);
    logWorkflow(args.workflowId ?? 'noctx', 'tool_result', {
      tool: 'component_draft_recovery',
      ok: recoveredDraft.ok,
      error: recoveredDraft.ok ? undefined : recoveredDraft.error,
      skipped: recoveredDraft.ok ? undefined : recoveredDraft.skipped,
    });
    if (recoveredDraft.ok) {
      return recoveredDraft.response;
    }

    if (recoveredCollectedPatch.error) {
      lastError = recoveredCollectedPatch.error;
    } else if (recoveredDraft.error) {
      lastError = recoveredDraft.error;
    }
    return null;
  };

  if (args.initialDraft) {
    const validation = validateDraft(args, args.initialDraft);
    logWorkflow(args.workflowId ?? 'noctx', 'tool_result', {
      tool: 'initial_patch_check',
      ok: validation.ok,
      attempt: 0,
      error: validation.ok ? undefined : validation.error,
    });
    if (validation.ok) {
      return validation.response;
    }
    lastError = validation.error;
    loopMessages.push({
      role: 'user',
      content: `Initial candidate failed validation:\n${validation.error}\n\nRepair it using tools, then submit a valid patch.`,
    });
  }

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const stage = getPatchToolStage(args, args.plan, args.pageState, args.toolResults);
    const tools = buildPatchToolsForTurn(args, args.plan, args.pageState, args.toolResults);
    const allowedTools = new Set(tools.map((tool) => tool.name));
    const messages: NativeToolLoopMessage[] = [
      { role: 'system', content: buildPatchSystemPrompt(stage) },
      { role: 'user', content: buildPatchUserMessage(args, stage) },
      ...loopMessages,
    ];
    let assistantMessage: Awaited<ReturnType<TextModelClient['createToolTurn']>>;
    try {
      assistantMessage = await args.textProvider.createToolTurn({
        messages,
        tools,
        workflowId: args.workflowId,
        source: args.source,
      });
    } catch (error) {
      const recoveredResponse = recoverExistingWorkspace();
      if (recoveredResponse) {
        return recoveredResponse;
      }
      throw error;
    }
    loopMessages.push({
      role: 'assistant',
      content: assistantMessage.content ?? '',
      ...(assistantMessage.tool_calls?.length ? { tool_calls: assistantMessage.tool_calls.map(summarizeToolCallForModel) } : {}),
    });

    if (!assistantMessage.tool_calls?.length) {
      lastError = 'Patch agent returned no tool call.';
      loopMessages.push({
        role: 'user',
        content: `You must use function tools. Call one of: ${tools.map((tool) => tool.name).join(', ')}.`,
      });
      continue;
    }

    const toolResultsById = new Map<string, { tool: PatchToolName; result: Record<string, unknown> }>();
    let pendingResponse: AiMessageResponse | null = null;
    let stopExecutingToolCalls = false;

    for (const toolCall of orderToolCallsForExecution(assistantMessage.tool_calls)) {
      const tool = toolCall.function.name as PatchToolName;
      if (stopExecutingToolCalls) {
        const result = {
          ok: false,
          error: `Skipped because an earlier tool call in this turn failed: ${lastError || 'unknown error'}`,
        };
        logWorkflow(args.workflowId ?? 'noctx', 'tool_result', {
          tool,
          ok: false,
          result,
        });
        toolResultsById.set(toolCall.id, { tool, result });
        continue;
      }
      if (!allowedTools.has(tool)) {
        lastError = `Tool ${toolCall.function.name} is not available in the current workflow stage.`;
        const result = {
          ok: false,
          error: `${lastError} Call one of: ${tools.map((allowedTool) => allowedTool.name).join(', ')}.`,
        };
        logWorkflow(args.workflowId ?? 'noctx', 'tool_result', {
          tool,
          ok: false,
          result,
        });
        toolResultsById.set(toolCall.id, { tool, result });
        stopExecutingToolCalls = true;
        continue;
      }
      const input = (() => {
        try {
          return asRecord(normalizeNativeToolValue(JSON.parse(toolCall.function.arguments)));
        } catch {
          return {};
        }
      })();
      logWorkflow(args.workflowId ?? 'noctx', 'tool_call', { tool, input });
      const result = await executeTool(args, tool, input);
      if (result.ok !== false) {
        lastToolSucceeded = true;
        lastError = '';
      }
      logWorkflow(args.workflowId ?? 'noctx', 'tool_result', {
        tool,
        ok: result.ok !== false,
        result,
      });

      if (tool === 'validate_component_draft' && result.ok === false) {
        lastError = typeof result.error === 'string' ? result.error : 'Component draft validation failed.';
        if (typeof input.draftId === 'string') {
          args.failedComponentDraftIds.add(input.draftId);
          args.validatedComponentDraftIds.delete(input.draftId);
          if (result.requiresClearAndRewrite === true) {
            args.clearRequiredComponentDraftIds.add(input.draftId);
          }
        }
        stopExecutingToolCalls = true;
      }

      if (tool === 'validate_component_draft' && result.ok !== false && typeof input.draftId === 'string') {
        args.validatedComponentDraftIds.add(input.draftId);
        args.failedComponentDraftIds.delete(input.draftId);
        args.clearRequiredComponentDraftIds.delete(input.draftId);
      }

      toolResultsById.set(toolCall.id, { tool, result });

      if (
        tool === 'submit_component_draft' ||
        tool === 'submit_prepared_patch' ||
        tool === 'submit_no_changes' ||
        tool === 'submit_collected_patch'
      ) {
        if (result.ok === false) {
          lastError = typeof result.error === 'string' ? result.error : 'Submitted patch failed validation.';
          args.collectedPatch = [];
          if (tool === 'submit_prepared_patch') {
            throw new Error(lastError);
          }
          stopExecutingToolCalls = true;
          continue;
        }
        const draft = patchResponseDraftSchema.parse(result.draft);
        const validation = validateDraft(args, draft);
        if (validation.ok) {
          pendingResponse = validation.response;
          stopExecutingToolCalls = true;
          continue;
        }
        lastError = validation.error;
        args.collectedPatch = [];
        if (tool === 'submit_prepared_patch') {
          throw new Error(lastError);
        }
        stopExecutingToolCalls = true;
      } else if (result.ok === false && typeof result.error === 'string') {
        lastToolSucceeded = false;
        lastError = result.error;
        stopExecutingToolCalls = true;
      }
    }

    for (const toolCall of assistantMessage.tool_calls) {
      const toolResult = toolResultsById.get(toolCall.id);
      const result = toolResult?.result ?? {
        ok: false,
        error: 'Tool call was not executed.',
      };
      loopMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: serializeToolResultForModel(args, result),
      });
    }

    if (pendingResponse) {
      return pendingResponse;
    }
  }

  const recoveredResponse = recoverExistingWorkspace();
  if (recoveredResponse) {
    return recoveredResponse;
  }

  throw new Error(lastError || (lastToolSucceeded ? 'Patch agent exhausted tool turns before submitting a final patch.' : 'AI returned an invalid page patch.'));
}

export async function finalizeWorkflowPatch(
  textProvider: TextModelClient,
  prompt: string,
  pageState: PageState,
  transcript: string,
  plan: WorkflowPlan,
  toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
  imageRefs: ImageRefMap,
  workflowId?: string,
  repairOnlyInstruction = '',
): Promise<AiMessageResponse> {
  const modelSafeToolResults = sanitizeToolResultsForModel(toolResults, imageRefs);
  const hasPreparedPatch = Boolean(getCandidatePatch(toolResults));
  const extraContext = hasPreparedPatch
    ? [
        'A server-prepared patch is available from prior tool results.',
        'Do not inspect, rewrite, or reconstruct the patch.',
        'Call submit_prepared_patch with concise assistantText and changeSummary.',
        `Image refs available: ${JSON.stringify([...imageRefs.keys()])}`,
      ].join('\n')
    : `Tool results:\n${JSON.stringify(modelSafeToolResults)}`;
  return generateNativeToolPatchResponse({
    textProvider,
    prompt,
    pageState,
    transcript,
    plan,
    source: 'finalizer',
    workflowId,
    imageRefs,
    toolResults,
    extraContext: extraContext + (repairOnlyInstruction ? `\n\n${repairOnlyInstruction}` : ''),
  });
}
