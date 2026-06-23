import { z } from 'zod';
import type { PageState } from '../../src/shared/types';
import type { NativeToolDefinition, NativeToolLoopMessage, TextModelClient, WorkflowPlan, WorkflowTask } from './contracts';
import {
  workflowComponentCategorySchema,
  workflowConfidenceSchema,
  workflowImageTargetSchema,
  workflowIntentSchema,
  workflowPlanToolInputSchema,
  workflowPlanSchema,
  workflowReferenceRelationSchema,
  workflowSubjectSchema,
} from './contracts';
import { currentRequestId, logWorkflow } from './logging';
import { findNodeById, listComponents } from './tools';

type PlannerNormalizeOptions = {
  pageState?: PageState;
};

const plannerTools: NativeToolDefinition<'submit_plan'>[] = [
  {
    name: 'submit_plan',
    description: 'Submit the complete semantic workflow plan for the current user request.',
    inputSchema: workflowPlanToolInputSchema,
  },
];

const legacyKeyMap: Record<string, string> = {
  target_node_id: 'targetNodeId',
  node_id: 'targetNodeId',
  nodeId: 'targetNodeId',
  reference_node_id: 'referenceNodeId',
  relation_to_reference: 'relationToReference',
  component_category: 'componentCategory',
  component_type: 'componentArchetype',
  componentType: 'componentArchetype',
  component_kind: 'componentArchetype',
  componentKind: 'componentArchetype',
  user_visible_goal: 'userVisibleGoal',
  behavioral_requirements: 'behavioralRequirements',
  visual_requirements: 'visualRequirements',
  acceptance_criteria: 'acceptanceCriteria',
  needs_image: 'needsImage',
  image_target: 'imageTarget',
  image_prompt: 'imagePrompt',
  requires_generated_code: 'requiresGeneratedCode',
  should_edit_existing_image: 'shouldEditExistingImage',
  should_rewrite_component_code: 'shouldRewriteComponentCode',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeJsonShape(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonShape);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const nextKey = legacyKeyMap[key] ?? key;
    const nextValue = normalizeJsonShape(nestedValue);
    if (nextValue !== undefined) {
      normalized[nextKey] = nextValue;
    }
  }
  return normalized;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function enumValueOrUndefined<T extends z.ZodEnum<[string, ...string[]]>>(schema: T, value: unknown): z.infer<T> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function deriveTargetFromSubject(subject: WorkflowTask['subject']): 'page_background' | 'component' | 'none' {
  if (subject === 'page_background') {
    return 'page_background';
  }
  if (subject === 'text_response') {
    return 'none';
  }
  return 'component';
}

function validateNodeId(pageState: PageState | undefined, nodeId: string | undefined, fieldName: string): void {
  if (!pageState || !nodeId) {
    return;
  }
  const node = findNodeById(pageState.root, nodeId);
  if (!node) {
    throw new Error(`Planner returned invalid ${fieldName}: ${nodeId}`);
  }
  if (fieldName === 'referenceNodeId' && (node.type === 'system_prompt' || node.type === 'system_timeline')) {
    throw new Error(`Planner returned invalid ${fieldName}: ${nodeId} is a system control, not a layout reference component.`);
  }
}

function normalizeTask(rawTask: Record<string, unknown>, options: PlannerNormalizeOptions): WorkflowTask {
  const intent = enumValueOrUndefined(workflowIntentSchema, rawTask.intent);
  const subject = enumValueOrUndefined(workflowSubjectSchema, rawTask.subject);
  const imageTarget = enumValueOrUndefined(workflowImageTargetSchema, rawTask.imageTarget);
  const relationToReference = enumValueOrUndefined(workflowReferenceRelationSchema, rawTask.relationToReference) ?? 'none';
  const componentCategory = enumValueOrUndefined(workflowComponentCategorySchema, rawTask.componentCategory);
  const componentArchetype = stringOrUndefined(rawTask.componentArchetype);
  const targetNodeId = stringOrUndefined(rawTask.targetNodeId);
  const referenceNodeId = stringOrUndefined(rawTask.referenceNodeId);

  validateNodeId(options.pageState, targetNodeId, 'targetNodeId');
  validateNodeId(options.pageState, referenceNodeId, 'referenceNodeId');

  if (subject === 'existing_component' && !targetNodeId) {
    throw new Error('Planner task targets an existing component but omitted targetNodeId.');
  }
  if (imageTarget === 'component' && subject === 'existing_component' && !targetNodeId) {
    throw new Error('Planner task targets a component image update but omitted targetNodeId.');
  }

  const normalized = {
    intent,
    subject,
    targetNodeId,
    referenceNodeId,
    relationToReference,
    componentCategory,
    componentArchetype,
    userVisibleGoal: stringOrUndefined(rawTask.userVisibleGoal),
    behavioralRequirements: arrayOfStrings(rawTask.behavioralRequirements),
    visualRequirements: arrayOfStrings(rawTask.visualRequirements),
    acceptanceCriteria: arrayOfStrings(rawTask.acceptanceCriteria),
    needsImage: booleanOrUndefined(rawTask.needsImage),
    imageTarget,
    imagePrompt: stringOrUndefined(rawTask.imagePrompt),
    requiresGeneratedCode: booleanOrUndefined(rawTask.requiresGeneratedCode),
    shouldEditExistingImage: booleanOrUndefined(rawTask.shouldEditExistingImage) ?? false,
    shouldRewriteComponentCode:
      booleanOrUndefined(rawTask.shouldRewriteComponentCode) ?? booleanOrUndefined(rawTask.requiresGeneratedCode) ?? false,
  };

  return workflowPlanSchema.shape.tasks.element.parse(normalized);
}

function normalizeLegacySingleTask(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    intent: raw.intent,
    subject: raw.subject,
    targetNodeId: raw.targetNodeId,
    referenceNodeId: raw.referenceNodeId,
    relationToReference: raw.relationToReference,
    componentCategory: raw.componentCategory,
    componentArchetype: raw.componentArchetype,
    userVisibleGoal: raw.userVisibleGoal ?? raw.reasoning,
    behavioralRequirements: raw.behavioralRequirements,
    visualRequirements: raw.visualRequirements,
    acceptanceCriteria: raw.acceptanceCriteria,
    needsImage: raw.needsImage,
    imageTarget: raw.imageTarget,
    imagePrompt: raw.imagePrompt,
    requiresGeneratedCode: raw.requiresGeneratedCode,
    shouldEditExistingImage: raw.shouldEditExistingImage,
    shouldRewriteComponentCode: raw.shouldRewriteComponentCode,
  };
}

export function normalizeWorkflowPlan(rawPlan: unknown, _prompt = '', options: PlannerNormalizeOptions = {}): WorkflowPlan {
  const normalizedShape = asRecord(normalizeJsonShape(rawPlan));
  const rawTasks = Array.isArray(normalizedShape.tasks) ? normalizedShape.tasks : [normalizeLegacySingleTask(normalizedShape)];
  const tasks = rawTasks.map((task) => normalizeTask(asRecord(task), options));
  const plan = workflowPlanSchema.parse({
    reasoning: stringOrUndefined(normalizedShape.reasoning) ?? 'Planner returned a task-based workflow plan.',
    tasks,
    confidence: enumValueOrUndefined(workflowConfidenceSchema, normalizedShape.confidence) ?? 'medium',
  });

  if (JSON.stringify(plan) !== JSON.stringify(rawPlan)) {
    logWorkflow(currentRequestId(), 'normalize_output', {
      tool: 'normalize_output',
      stage: 'planner',
      ok: true,
      reason: 'adapted planner JSON shape without semantic inference',
      plan,
    });
  }
  return plan;
}

function getPlannerSystemPrompt(retryError?: string): string {
  return [
    'You are a semantic planner for a page-editing agent. Return only the workflow plan JSON schema.',
    'Do not write code, do not design UI, and do not output page patches.',
    'Use tasks[] so one user request can update or create multiple objects.',
    'For every task, identify the subject being created or modified separately from layout/reference objects.',
    'targetNodeId is the existing component to modify. referenceNodeId is only a layout/reference object and must not be touched unless it is also a target in another task.',
    'Never use system_prompt or system_timeline as referenceNodeId for component layout; they are overlay controls, not page components.',
    'For new bespoke UI such as tables, Pomodoro timers, dashboards, forms, and custom controls, use subject=new_component and requiresGeneratedCode=true.',
    'Use componentCategory only for coarse routing: data, display, control, input, media, navigation, time_based, layout, system, or unknown.',
    'Use componentArchetype for the real user-visible semantic object, for example pomodoro_timer, 3x3_table, pokemon_table_background, or prompt_bar.',
    'A Pomodoro timer is componentCategory=time_based and componentArchetype=pomodoro_timer. Do not flatten it to a generic timer when the user says 番茄钟/Pomodoro.',
    'For component background image requests, set subject=existing_component, targetNodeId to that component, needsImage=true, and imageTarget=component.',
    'For whole page background image requests, set subject=page_background, needsImage=true, and imageTarget=page.',
    'If a request references an existing component, choose ids only from the component inventory.',
    'If the user asks to create a new component next to/near/above/below another component, keep targetNodeId null and put the existing component id in referenceNodeId.',
    'The current user request has priority over transcript context. Transcript is background only.',
    retryError ? `Previous planner output was rejected by the adapter/verifier: ${retryError}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function generateWorkflowPlan(
  textProvider: TextModelClient,
  prompt: string,
  pageState: PageState,
  transcript: string,
  workflowId?: string,
): Promise<WorkflowPlan> {
  const inventoryResult = listComponents(pageState);
  let lastError: unknown;
  const messages: NativeToolLoopMessage[] = [
    {
      role: 'system',
      content: getPlannerSystemPrompt(),
    },
    {
      role: 'user',
      content: `Current user request:\n${prompt}\n\nComponent inventory from list_components:\n${JSON.stringify(inventoryResult.data)}\n\nLow-priority transcript context:\n${transcript || 'No prior messages'}`,
    },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const assistantMessage = await textProvider.createToolTurn({
        messages,
        tools: plannerTools,
        source: 'planner',
        workflowId,
      });
      messages.push({
        role: 'assistant',
        content: assistantMessage.content ?? '',
        ...(assistantMessage.tool_calls?.length ? { tool_calls: assistantMessage.tool_calls } : {}),
      });

      const submitPlanCall = assistantMessage.tool_calls?.find((toolCall) => toolCall.function.name === 'submit_plan');
      if (!submitPlanCall) {
        throw new Error('Planner returned no submit_plan tool call.');
      }

      let rawPlan: unknown;
      try {
        rawPlan = JSON.parse(submitPlanCall.function.arguments);
      } catch (error) {
        throw new Error(`Planner submit_plan arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const plan = normalizeWorkflowPlan(rawPlan, prompt, { pageState });
        messages.push({
          role: 'tool',
          tool_call_id: submitPlanCall.id,
          content: JSON.stringify({ ok: true }),
        });
        return plan;
      } catch (error) {
        messages.push({
          role: 'tool',
          tool_call_id: submitPlanCall.id,
          content: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        });
        throw error;
      }
    } catch (error) {
      lastError = error;
      logWorkflow(workflowId ?? currentRequestId(), 'tool_result', {
        tool: 'planner',
        ok: false,
        retryable: attempt === 0,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt === 0 && (!messages[messages.length - 1] || messages[messages.length - 1].role !== 'tool')) {
        messages.push({
          role: 'user',
          content: `Planner output was rejected: ${error instanceof Error ? error.message : String(error)}. Call submit_plan with a complete valid plan.`,
        });
      }
    }
  }

  throw new Error(`Planner failed to return a complete semantic task plan: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export { deriveTargetFromSubject };
