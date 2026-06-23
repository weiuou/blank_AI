import { applyPatchOperations, validatePatchOperations } from '../src/shared/patches';
import type { AiMessageResponse, ConversationMessage, PagePatchOperation, PageState } from '../src/shared/types';
import { aiMessageResponseSchema } from '../src/shared/types';
import {
  getFirstImageWorkflowTask,
  type AiRequestContext,
  type ImageRefMap,
  type TextModelClient,
  type WorkflowPlan,
  type WorkflowToolName,
  type WorkflowToolResult,
  type WorkflowTraceStep,
  workflowPlanNeedsImage,
} from './ai/contracts';
import { buildMockPatch } from './ai/fallbacks';
import { finalizeWorkflowPatch } from './ai/finalizer';
import { logWorkflow } from './ai/logging';
import { generateWorkflowPlan } from './ai/planner';
import { createImageModelProvider, createTextModelProvider } from './ai/providers';
import {
  addImageRef,
  buildComponentImagePrompt,
  buildImageEditPrompt,
  buildImagePrompt,
  findNodeById,
  getComponentDetail,
  getExistingImageBackground,
  inspectPageState,
  listComponents,
  prepareComponentBackgroundPatch,
} from './ai/tools';
import { preflightAiMessageResponse } from './ai/validation';

async function runAiWorkflow(
  textProvider: TextModelClient,
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
  logWorkflow(workflowId, 'tool_call', { tool: 'planner', model: textProvider.model, provider: textProvider.provider });
  const plan = await generateWorkflowPlan(textProvider, prompt, pageState, transcript, workflowId);
  logWorkflow(workflowId, 'tool_result', {
    tool: 'planner',
    ok: true,
    durationMs: Date.now() - planStartedAt,
    plan,
  });
  trace.push({ type: 'reasoning', content: plan.reasoning });

  logWorkflow(workflowId, 'tool_call', { tool: 'list_components' });
  const componentInventoryResult = listComponents(pageState);
  toolResults.push({ tool: 'list_components', result: componentInventoryResult });
  logWorkflow(workflowId, 'tool_result', {
    tool: 'list_components',
    ok: componentInventoryResult.ok,
    summary: componentInventoryResult.ok ? 'Component inventory listed.' : (componentInventoryResult.error ?? 'Inventory failed.'),
  });
  trace.push({
    type: 'tool_call',
    tool: 'list_components',
    input: {},
  });
  trace.push({
    type: 'tool_result',
    tool: 'list_components',
    ok: componentInventoryResult.ok,
    summary: componentInventoryResult.ok ? 'Component inventory listed.' : (componentInventoryResult.error ?? 'Inventory failed.'),
  });

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

  addComponentDetailsForExistingTargets(pageState, plan, toolResults, trace, workflowId);

  if (!workflowPlanNeedsImage(plan)) {
    const directStartedAt = Date.now();
    logWorkflow(workflowId, 'tool_call', { tool: 'direct_patch', model: textProvider.model, provider: textProvider.provider });
    let directResponse: AiMessageResponse;
    try {
      directResponse = await generateDirectPatchResponse(textProvider, prompt, pageState, transcript, plan, workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logWorkflow(workflowId, 'tool_result', {
        tool: 'direct_patch',
        ok: false,
        durationMs: Date.now() - directStartedAt,
        error: message,
      });
      throw error;
    }
    directResponse = preflightAiMessageResponse(pageState, directResponse, plan);
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

  if (workflowPlanNeedsImage(plan)) {
    const imageClient = createImageModelProvider();
    for (const imageTask of plan.tasks.filter((task) => task.needsImage)) {
      const targetNode = imageTask.targetNodeId ? findNodeById(pageState.root, imageTask.targetNodeId) : undefined;
      const imagePrompt =
        imageTask.imageTarget === 'component'
          ? buildComponentImagePrompt(imageTask.imagePrompt ?? prompt, targetNode)
          : buildImagePrompt(imageTask.imagePrompt ?? prompt);
      const existingPageImage = getExistingImageBackground(pageState);
      const existingImageSrc = typeof existingPageImage?.props.src === 'string' ? existingPageImage.props.src : undefined;
      const shouldEditPageImage = imageTask.imageTarget === 'page' && imageTask.shouldEditExistingImage && existingImageSrc;

      trace.push({
        type: 'tool_call',
        tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
        input: { target: imageTask.subject, imageTarget: imageTask.imageTarget, targetNodeId: imageTask.targetNodeId, prompt: imagePrompt },
      });

      try {
      const imageStartedAt = Date.now();
      logWorkflow(workflowId, 'tool_call', {
        tool: shouldEditPageImage ? 'edit_image' : 'generate_image',
        model: imageClient.model,
        provider: imageClient.provider,
        target: imageTask.subject,
        imageTarget: imageTask.imageTarget,
        targetNodeId: imageTask.targetNodeId ?? null,
        promptLength: imagePrompt.length,
      });
      const imageDataUrl = shouldEditPageImage
        ? await imageClient.editBackground(imagePrompt, existingImageSrc)
        : await imageClient.generateBackground(imagePrompt);
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

      if (imageTask.imageTarget === 'component' && imageTask.targetNodeId) {
        logWorkflow(workflowId, 'tool_call', {
          tool: 'prepare_component_background_patch',
          targetNodeId: imageTask.targetNodeId,
        });
        trace.push({
          type: 'tool_call',
          tool: 'prepare_component_background_patch',
          input: { targetNodeId: imageTask.targetNodeId },
        });
        const componentPatchResult = prepareComponentBackgroundPatch(pageState, imageTask.targetNodeId, imageDataUrl);
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
      } else if (imageTask.imageTarget === 'page') {
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
  }

  try {
    const finalizerStartedAt = Date.now();
    logWorkflow(workflowId, 'tool_call', {
      tool: 'finalizer',
      model: textProvider.model,
      provider: textProvider.provider,
      toolResultCount: toolResults.length,
      imageRefCount: imageRefs.size,
    });
    const finalResponse = await finalizeWorkflowPatch(
      textProvider,
      prompt,
      pageState,
      transcript,
      plan,
      toolResults,
      imageRefs,
      workflowId,
    );
    const checkedFinalResponse = preflightAiMessageResponse(pageState, finalResponse, plan);
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
    throw error;
  }
}

function addComponentDetailsForExistingTargets(
  pageState: PageState,
  plan: WorkflowPlan,
  toolResults: Array<{ tool: WorkflowToolName; result: WorkflowToolResult }>,
  trace: WorkflowTraceStep[],
  workflowId: string,
): void {
  const targetIds = new Set(
    plan.tasks
      .filter((task) => task.subject === 'existing_component' && task.targetNodeId)
      .map((task) => task.targetNodeId as string),
  );

  for (const targetNodeId of targetIds) {
    logWorkflow(workflowId, 'tool_call', { tool: 'get_component_detail', targetNodeId });
    trace.push({
      type: 'tool_call',
      tool: 'get_component_detail',
      input: { targetNodeId },
    });
    const detailResult = getComponentDetail(pageState, targetNodeId);
    toolResults.push({ tool: 'get_component_detail', result: detailResult });
    logWorkflow(workflowId, 'tool_result', {
      tool: 'get_component_detail',
      ok: detailResult.ok,
      summary: detailResult.ok ? `Loaded component detail for ${targetNodeId}.` : (detailResult.error ?? 'Component detail failed.'),
    });
    trace.push({
      type: 'tool_result',
      tool: 'get_component_detail',
      ok: detailResult.ok,
      summary: detailResult.ok ? `Loaded component detail for ${targetNodeId}.` : (detailResult.error ?? 'Component detail failed.'),
    });
  }
}

export async function generateAssistantResponse(
  prompt: string,
  pageState: PageState,
  messages: ConversationMessage[],
  context: AiRequestContext = {},
): Promise<AiMessageResponse> {
  if ((process.env.NODE_ENV === 'test' && process.env.USE_AI_MOCK !== 'false') || process.env.USE_AI_MOCK === 'true') {
    return buildMockPatch(prompt, pageState);
  }

  const textProvider = createTextModelProvider();
  const response = await runAiWorkflow(textProvider, prompt, pageState, messages, context);
  return aiMessageResponseSchema.parse(response);
}

async function generateDirectPatchResponse(
  textProvider: TextModelClient,
  prompt: string,
  pageState: PageState,
  transcript: string,
  plan: WorkflowPlan,
  workflowId?: string,
): Promise<AiMessageResponse> {
  return finalizeWorkflowPatch(
    textProvider,
    prompt,
    pageState,
    transcript,
    plan,
    [],
    new Map(),
    workflowId,
  );
}

export function validateAndApplyAiResponse(pageState: PageState, response: AiMessageResponse): PageState {
  return applyPatchOperations(pageState, validatePatchOperations(response.patch));
}
