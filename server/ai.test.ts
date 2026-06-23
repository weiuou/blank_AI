import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPageState } from '../src/shared/defaults';
import type { PagePatchOperation, PageState } from '../src/shared/types';

const chatCompletionsMock = vi.fn();
const imageFetchMock = vi.fn();

describe('generateAssistantResponse native patch tools', () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};

    if (url.endsWith('/chat/completions')) {
      const result = await chatCompletionsMock(body, input, init);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    }

    if (url.includes(':generateContent')) {
      return imageFetchMock(input, init);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    chatCompletionsMock.mockReset();
    imageFetchMock.mockReset();
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    process.env.MINIMAX_BASE_URL = 'https://api.minimaxi.test/v1';
    process.env.GEMINI_IMAGE_API_KEY = 'test-gemini-key';
    process.env.GEMINI_IMAGE_BASE_URL = 'https://gemini.local/v1beta';
    process.env.LANGUAGE_MODEL = 'MiniMax-M3';
    process.env.IMAGE_MODEL = 'gemini-3.1-flash-image';
    process.env.USE_AI_MOCK = 'false';
    delete process.env.AI_PATCH_REPAIR_ATTEMPTS;
    vi.stubGlobal('fetch', fetchMock);
  });

  function plannerPlan(taskOverrides: Record<string, unknown> = {}, reasoning = 'Test planner task plan.') {
    return {
      reasoning,
      tasks: [
        {
          intent: 'create',
          subject: 'new_component',
          targetNodeId: null,
          referenceNodeId: null,
          relationToReference: 'none',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: reasoning,
          behavioralRequirements: [],
          visualRequirements: [],
          acceptanceCriteria: [],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: true,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
          ...taskOverrides,
        },
      ],
      confidence: 'high',
    };
  }

  function componentMeta(category: string, archetype: string, goal = 'Generated component') {
    return {
      category,
      archetype,
      userVisibleGoal: goal,
      behavioralRequirements: [],
      acceptanceCriteria: [],
    };
  }

  function generatedComponentPatch(overrides: Partial<PagePatchOperation> = {}): PagePatchOperation[] {
    return [
      {
        type: 'add_node',
        target: { parentId: 'root', index: 0 },
        node: {
          id: 'generated-widget',
          type: 'generated_react_component',
          props: {
            name: 'Generated widget',
            code: "return React.createElement('section', null, props.title || 'Generated widget');",
            mountProps: { title: 'Generated widget' },
            capabilities: [],
            componentMeta: componentMeta('display', 'custom_widget'),
          },
          styleTokens: {},
          children: [],
        },
        ...overrides,
      } as PagePatchOperation,
    ];
  }

  function generatedComponentArgs(overrides: Record<string, unknown> = {}) {
    return {
      assistantText: 'Created the widget.',
      changeSummary: 'Added a generated widget.',
      target: { parentId: 'root', index: 0 },
      nodeId: 'generated-widget',
      name: 'Generated widget',
      code: "return React.createElement('section', null, props.title || 'Generated widget');",
      mountProps: { title: 'Generated widget' },
      capabilities: [],
      styleTokens: {},
      componentMeta: componentMeta('display', 'custom_widget'),
      ...overrides,
    };
  }

  function generatedComponentDraftArgs(overrides: Record<string, unknown> = {}) {
    const { code: _code, assistantText: _assistantText, changeSummary: _changeSummary, ...draftArgs } = generatedComponentArgs(overrides);
    return {
      draftId: 'draft-widget',
      ...draftArgs,
    };
  }

  function toolCallResponse(name: string, args: Record<string, unknown>, id = `call-${chatCompletionsMock.mock.calls.length + 1}`) {
    return {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id,
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        },
      ],
    };
  }

  function multiToolCallResponse(calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>) {
    return {
      choices: [
        {
          message: {
            content: '',
            tool_calls: calls.map((call, index) => ({
              id: call.id ?? `call-${chatCompletionsMock.mock.calls.length + 1}-${index}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            })),
          },
        },
      ],
    };
  }

  function generatedComponentDraftToolTurn(overrides: Record<string, unknown> = {}) {
    const args = generatedComponentArgs(overrides);
    return toolCallResponse('create_component_draft', generatedComponentDraftArgs(overrides));
  }

  function generatedComponentCodeToolTurn(overrides: Record<string, unknown> = {}) {
    const args = generatedComponentArgs(overrides);
    return multiToolCallResponse([
      { name: 'append_component_code_chunk', args: { draftId: 'draft-widget', codeChunk: String(args.code) } },
      {
        name: 'validate_component_draft',
        args: {
          draftId: 'draft-widget',
          assistantText: String(args.assistantText),
          changeSummary: String(args.changeSummary),
        },
      },
    ]);
  }

  function submitComponentDraftToolTurn(overrides: Record<string, unknown> = {}) {
    const args = generatedComponentArgs(overrides);
    return toolCallResponse('submit_component_draft', {
      draftId: 'draft-widget',
      assistantText: String(args.assistantText),
      changeSummary: String(args.changeSummary),
    });
  }

  function mockPlanner(plan: unknown) {
    chatCompletionsMock.mockResolvedValueOnce(toolCallResponse('submit_plan', plan as Record<string, unknown>));
  }

  it('uses native chat function calling for final patches', async () => {
    mockPlanner(plannerPlan());
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn())
      .mockResolvedValueOnce(submitComponentDraftToolTurn());

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(chatCompletionsMock).toHaveBeenCalledTimes(4);
    expect(response.patch).toHaveLength(1);
    expect(response.patch[0]).toMatchObject({ type: 'add_node' });

    const chatBody = chatCompletionsMock.mock.calls[1]?.[0];
    expect(chatBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['create_component_draft']);
    const codeBody = chatCompletionsMock.mock.calls[2]?.[0];
    expect(codeBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'append_component_code_chunk',
      'validate_component_draft',
    ]);
    expect(JSON.stringify(chatBody)).not.toContain('submit_pomodoro_timer_component');
    expect(JSON.stringify(chatBody)).not.toContain('submit_generated_component');
    expect(JSON.stringify(chatBody)).not.toContain('patchJson');
    expect(JSON.stringify(chatBody)).not.toContain('repair_patch');
    expect(JSON.stringify(chatBody.messages)).not.toContain('Workflow plan');
    expect(JSON.stringify(chatBody.messages)).not.toContain('Current page summary');
    expect(JSON.stringify(chatBody.messages)).not.toContain('Conversation transcript');
    expect(JSON.stringify(chatBody.messages)).not.toContain('For Pomodoro');
    expect(JSON.stringify(chatBody.messages)).toContain('Task contract');
  });

  it('uses generic component draft tools for Pomodoro components without archetype-specific tools', async () => {
    mockPlanner(
      plannerPlan({
        componentCategory: 'time_based',
        componentArchetype: 'pomodoro_timer',
        userVisibleGoal: 'Create a Pomodoro timer.',
        behavioralRequirements: ['start pause reset', 'focus and break phases'],
        acceptanceCriteria: ['renders as a Pomodoro timer'],
      }),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        generatedComponentDraftToolTurn({
          componentMeta: componentMeta('time_based', 'pomodoro_timer', 'Create a Pomodoro timer.'),
          code: "return React.createElement('section', null, 'Pomodoro timer start pause reset focus break');",
        }),
      )
      .mockResolvedValueOnce(
        generatedComponentCodeToolTurn({
          componentMeta: componentMeta('time_based', 'pomodoro_timer', 'Create a Pomodoro timer.'),
          code: "return React.createElement('section', null, 'Pomodoro timer start pause reset focus break');",
        }),
      )
      .mockResolvedValueOnce(
        submitComponentDraftToolTurn({
          componentMeta: componentMeta('time_based', 'pomodoro_timer', 'Create a Pomodoro timer.'),
          code: "return React.createElement('section', null, 'Pomodoro timer start pause reset focus break');",
        }),
      );

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个番茄钟', createInitialPageState(), []);

    const finalizerBody = chatCompletionsMock.mock.calls[1]?.[0];
    const toolNames = finalizerBody.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(toolNames).toEqual(['create_component_draft']);
    const submitToolNames = chatCompletionsMock.mock.calls[3]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(submitToolNames).toContain('submit_component_draft');
    expect(toolNames).not.toContain('submit_pomodoro_timer_component');
    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      node: {
        type: 'generated_react_component',
        props: {
          componentMeta: {
            archetype: 'pomodoro_timer',
          },
        },
      },
    });
  });

  it('routes mixed new generated component tasks through draft tools instead of add_standard_node', async () => {
    mockPlanner({
      reasoning: 'Create a generated calendar and reposition an existing widget.',
      tasks: [
        {
          intent: 'create',
          subject: 'new_component',
          targetNodeId: null,
          referenceNodeId: 'generated-widget',
          relationToReference: 'left_of',
          componentCategory: 'data',
          componentArchetype: 'calendar',
          userVisibleGoal: 'Create a calendar next to the existing widget.',
          behavioralRequirements: [],
          visualRequirements: ['Place it left of the existing widget'],
          acceptanceCriteria: ['Calendar is visible'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: true,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          referenceNodeId: null,
          relationToReference: 'right_of',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget right of the calendar.',
          behavioralRequirements: [],
          visualRequirements: ['Place it right of the calendar'],
          acceptanceCriteria: ['Widget remains visible'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: false,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
      ],
      confidence: 'high',
    });
    chatCompletionsMock
      .mockResolvedValueOnce(
        generatedComponentDraftToolTurn({
          nodeId: 'calendar-widget',
          componentMeta: componentMeta('data', 'calendar', 'Create a calendar next to the existing widget.'),
        }),
      )
      .mockResolvedValueOnce(
        generatedComponentCodeToolTurn({
          nodeId: 'calendar-widget',
          code: "return React.createElement('section', null, 'Calendar');",
          componentMeta: componentMeta('data', 'calendar', 'Create a calendar next to the existing widget.'),
        }),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'calendar-widget-layout',
                type: 'section',
                props: {},
                styleTokens: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: '24px',
                  width: 'min(920px, 100%)',
                },
                children: [],
              },
            },
          },
          { name: 'move_node', args: { nodeId: 'calendar-widget', target: { parentId: 'calendar-widget-layout', index: 0 } } },
          { name: 'move_node', args: { nodeId: 'generated-widget', target: { parentId: 'calendar-widget-layout', index: 1 } } },
        ]),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_component_draft', {
          draftId: 'draft-widget',
          assistantText: 'Created the calendar next to the widget.',
          changeSummary: 'Added a calendar and positioned the existing widget.',
        }),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建日历放在这个组件左边', pageState, []);

    const firstFinalizerBody = chatCompletionsMock.mock.calls[1]?.[0];
    expect(firstFinalizerBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['create_component_draft']);
    expect(JSON.stringify(firstFinalizerBody)).not.toContain('add_standard_node');
    expect(chatCompletionsMock.mock.calls[2]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'append_component_code_chunk',
      'validate_component_draft',
    ]);
    expect(chatCompletionsMock.mock.calls[3]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'add_standard_node',
      'move_node',
      'read_component_draft',
    ]);
    const submitTurn = chatCompletionsMock.mock.calls[4]?.[0];
    expect(submitTurn.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('submit_component_draft');
    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      node: {
        id: 'calendar-widget',
        type: 'generated_react_component',
      },
    });
    expect(response.patch[1]).toMatchObject({
      type: 'add_node',
      node: {
        id: 'calendar-widget-layout',
      },
    });
  });

  it('requires real reference layout operations when creating a new component next to an existing one', async () => {
    mockPlanner({
      reasoning: 'Create a stats card right of the existing widget.',
      tasks: [
        {
          intent: 'create',
          subject: 'new_component',
          targetNodeId: null,
          referenceNodeId: 'generated-widget',
          relationToReference: 'right_of',
          componentCategory: 'display',
          componentArchetype: 'stats_card',
          userVisibleGoal: 'Create a stats card right of the existing widget without overlap.',
          behavioralRequirements: [],
          visualRequirements: ['Place it right of generated-widget', 'No overlap'],
          acceptanceCriteria: ['Stats card is right of generated-widget'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: true,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        },
      ],
      confidence: 'high',
    });

    const statsCode = "return React.createElement('section', null, 'Stats card');";
    chatCompletionsMock
      .mockResolvedValueOnce(
        generatedComponentDraftToolTurn({
          nodeId: 'stats-card',
          componentMeta: componentMeta('display', 'stats_card', 'Create a stats card right of the existing widget without overlap.'),
        }),
      )
      .mockResolvedValueOnce(
        generatedComponentCodeToolTurn({
          nodeId: 'stats-card',
          code: statsCode,
          componentMeta: componentMeta('display', 'stats_card', 'Create a stats card right of the existing widget without overlap.'),
        }),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'stats-card-layout',
                type: 'section',
                props: {},
                styleTokens: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: '24px',
                  width: 'min(920px, 100%)',
                },
                children: [],
              },
            },
          },
          { name: 'move_node', args: { nodeId: 'generated-widget', target: { parentId: 'stats-card-layout', index: 0 } } },
          { name: 'move_node', args: { nodeId: 'stats-card', target: { parentId: 'stats-card-layout', index: 1 } } },
        ]),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_component_draft', {
          draftId: 'draft-widget',
          assistantText: 'Created the stats card beside the widget.',
          changeSummary: 'Added stats card and arranged it beside the widget.',
        }),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('再创建一个统计卡片，放在这个组件右侧并排，不要重叠', pageState, []);

    expect(JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages)).toContain('Reference layout still required');
    expect(chatCompletionsMock.mock.calls[3]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'add_standard_node',
      'move_node',
      'read_component_draft',
    ]);
    expect(JSON.stringify(chatCompletionsMock.mock.calls[4]?.[0]?.messages)).toContain('Collected operations');
    expect(response.patch).toMatchObject([
      { type: 'add_node', node: { id: 'stats-card' } },
      { type: 'add_node', node: { id: 'stats-card-layout' } },
      { type: 'move_node', nodeId: 'generated-widget', target: { parentId: 'stats-card-layout' } },
      { type: 'move_node', nodeId: 'stats-card', target: { parentId: 'stats-card-layout' } },
    ]);
  });

  it('keeps reference layout tools active until both the draft and reference nodes are moved', async () => {
    mockPlanner({
      reasoning: 'Create a stats card right of the existing widget.',
      tasks: [
        {
          intent: 'create',
          subject: 'new_component',
          targetNodeId: null,
          referenceNodeId: 'generated-widget',
          relationToReference: 'right_of',
          componentCategory: 'display',
          componentArchetype: 'stats_card',
          userVisibleGoal: 'Create a stats card right of the existing widget without overlap.',
          behavioralRequirements: [],
          visualRequirements: ['Place it right of generated-widget', 'No overlap'],
          acceptanceCriteria: ['Stats card is right of generated-widget'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: true,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        },
      ],
      confidence: 'high',
    });

    chatCompletionsMock
      .mockResolvedValueOnce(
        generatedComponentDraftToolTurn({
          nodeId: 'stats-card',
          componentMeta: componentMeta('display', 'stats_card', 'Create a stats card right of the existing widget without overlap.'),
        }),
      )
      .mockResolvedValueOnce(
        generatedComponentCodeToolTurn({
          nodeId: 'stats-card',
          code: "return React.createElement('section', null, 'Stats card');",
          componentMeta: componentMeta('display', 'stats_card', 'Create a stats card right of the existing widget without overlap.'),
        }),
      )
      .mockResolvedValueOnce(
        toolCallResponse('add_standard_node', {
          target: { parentId: 'root', index: 0 },
          node: {
            id: 'stats-card-layout',
            type: 'section',
            props: {},
            styleTokens: {
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '24px',
              width: 'min(920px, 100%)',
            },
            children: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          { name: 'move_node', args: { nodeId: 'generated-widget', target: { parentId: 'stats-card-layout', index: 0 } } },
          { name: 'move_node', args: { nodeId: 'stats-card', target: { parentId: 'stats-card-layout', index: 1 } } },
        ]),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_component_draft', {
          draftId: 'draft-widget',
          assistantText: 'Created the stats card beside the widget.',
          changeSummary: 'Added stats card and arranged it beside the widget.',
        }),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('再创建一个统计卡片，放在这个组件右侧并排，不要重叠', pageState, []);

    expect(chatCompletionsMock.mock.calls[3]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'add_standard_node',
      'move_node',
      'read_component_draft',
    ]);
    expect(chatCompletionsMock.mock.calls[4]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'add_standard_node',
      'move_node',
      'read_component_draft',
    ]);
    expect(response.patch).toMatchObject([
      { type: 'add_node', node: { id: 'stats-card' } },
      { type: 'add_node', node: { id: 'stats-card-layout' } },
      { type: 'move_node', nodeId: 'generated-widget', target: { parentId: 'stats-card-layout' } },
      { type: 'move_node', nodeId: 'stats-card', target: { parentId: 'stats-card-layout' } },
    ]);
  });

  it('rejects old patchJson tool calls and lets the model use component draft tools', async () => {
    mockPlanner(plannerPlan());
    chatCompletionsMock
      .mockResolvedValueOnce(
        toolCallResponse('submit_generated_component' as string, {
          assistantText: 'Created the widget.',
          changeSummary: 'Old JSON protocol.',
          patchJson: JSON.stringify(generatedComponentPatch()),
        }),
      )
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn())
      .mockResolvedValueOnce(submitComponentDraftToolTurn());

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(response.changeSummary).toBe('Added a generated widget.');
    expect(chatCompletionsMock).toHaveBeenCalledTimes(5);
    const retryMessages = chatCompletionsMock.mock.calls[2]?.[0]?.messages ?? [];
    expect(JSON.stringify(retryMessages)).toContain('Tool submit_generated_component is not available in the current workflow stage');
  });

  it('validates component drafts so React redeclarations can be repaired before submit', async () => {
    mockPlanner(plannerPlan());

    chatCompletionsMock
      .mockResolvedValueOnce(
        generatedComponentDraftToolTurn({
          changeSummary: 'Unsafe generated code.',
          code: "var React = React;\nreturn React.createElement('section', null, 'Bad');",
        }),
      )
      .mockResolvedValueOnce(
        generatedComponentCodeToolTurn({
          changeSummary: 'Unsafe generated code.',
          code: "var React = React;\nreturn React.createElement('section', null, 'Bad');",
        }),
      )
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: { draftId: 'draft-widget', codeChunk: String(generatedComponentArgs({ changeSummary: 'Added safe generated code.' }).code) },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Added safe generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ changeSummary: 'Added safe generated code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(chatCompletionsMock).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages)).toContain('reserved runtime/helper redeclaration (React)');
    expect(JSON.stringify(response.patch)).not.toContain('var React');
  });

  it('rejects component drafts that compile but do not return renderable output', async () => {
    mockPlanner(plannerPlan());

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(
        generatedComponentCodeToolTurn({
          changeSummary: 'Invalid generated code.',
          code: 'return [];',
        }),
      )
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: "return React.createElement('table', null, React.createElement('tbody', null, React.createElement('tr', null, React.createElement('td', null, 'Cell'))));",
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Added safe generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ changeSummary: 'Added safe generated code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(chatCompletionsMock).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages)).toContain('returned an empty array');
    expect(JSON.stringify(response.patch)).toContain('return React.createElement');
  });

  it('returns line-level compile diagnostics for invalid generated component code', async () => {
    mockPlanner(plannerPlan());

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(
        generatedComponentCodeToolTurn({
          changeSummary: 'Invalid generated code.',
          code: "const bad = 'first line\nsecond line';\nreturn createElement('section', null, bad);",
        }),
      )
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: "return React.createElement('section', null, 'Fixed');",
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Fixed generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: "return React.createElement('section', null, 'Fixed');", changeSummary: 'Fixed generated code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const repairMessages = JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages ?? []);
    expect(repairMessages).toContain('near generated code line');
    expect(repairMessages).toContain('const bad');
    expect(JSON.stringify(response.patch)).toContain('Fixed');
  });

  it('unwraps anonymous component function wrappers in drafts', async () => {
    mockPlanner(plannerPlan());

    const wrappedCode = "function(props, theme, system, sdk) {\n  return React.createElement('section', null, props.title || 'Wrapped');\n}";
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn({ code: wrappedCode }))
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: "return React.createElement('section', null, props.title || 'Wrapped');" }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(JSON.stringify(response.patch)).toContain('Wrapped');
    expect(JSON.stringify(response.patch)).not.toContain('function(props');
  });

  it('validates generated component drafts that use provided bare React helpers', async () => {
    mockPlanner(plannerPlan());

    const bareHelperCode = [
      "const titleRef = useRef(props.title || 'Generated widget');",
      "return createElement('section', null, titleRef.current);",
    ].join('\n');
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn({ code: bareHelperCode }))
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: bareHelperCode }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(response.changeSummary).toBe('Added a generated widget.');
    expect(JSON.stringify(response.patch)).toContain('useRef');
    expect(JSON.stringify(response.patch)).toContain('createElement');
  });

  it('validates generated component drafts that read default theme tokens', async () => {
    mockPlanner(plannerPlan());

    const themedCode = [
      "return React.createElement('section', {",
      "  style: { border: '1px solid ' + theme.border, borderRadius: theme.radius, color: theme.textPrimary }",
      "}, props.title || 'Themed widget');",
    ].join('\n');
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn({ code: themedCode }))
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: themedCode }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(response.changeSummary).toBe('Added a generated widget.');
    expect(JSON.stringify(response.patch)).toContain('theme.border');
    expect(JSON.stringify(response.patch)).toContain('theme.radius');
  });

  it('allows ordinary nested component parameters while still reserving top-level runtime bindings', async () => {
    mockPlanner(plannerPlan());

    const nestedComponentCode = [
      'function Widget(props) {',
      "  const localTheme = props.theme || {};",
      "  return React.createElement('section', { style: { color: localTheme.text || '#111' } }, props.title || 'Nested widget');",
      '}',
      'return React.createElement(Widget, { title: props.title });',
    ].join('\n');

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn({ code: nestedComponentCode }))
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: nestedComponentCode }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(response.changeSummary).toBe('Added a generated widget.');
    expect(JSON.stringify(response.patch)).toContain('Nested widget');
  });

  it('rejects top-level reserved runtime binding declarations in drafts', async () => {
    mockPlanner(plannerPlan());

    const invalidCode = "const theme = props.theme || {};\nreturn React.createElement('section', null, 'Bad');";
    const repairedCode = "const localTheme = props.theme || {};\nreturn React.createElement('section', null, localTheme.title || 'Fixed');";

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn({ code: invalidCode }))
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: repairedCode,
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Repaired top-level reserved binding.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: repairedCode, changeSummary: 'Repaired top-level reserved binding.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const repairMessages = JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages ?? []);
    expect(repairMessages).toContain('reserved runtime/helper redeclaration (theme)');
    expect(JSON.stringify(response.patch)).toContain('localTheme');
  });

  it('rejects reserved helper destructuring in drafts and lets the model rewrite the code', async () => {
    mockPlanner(plannerPlan());

    const invalidCode = [
      'const { createElement: h, useState } = React;',
      'const state = useState(0);',
      "return h('section', null, 'Count ' + state[0]);",
    ].join('\n');
    const repairedCode = [
      'const state = useState(0);',
      "return createElement('section', null, 'Count ' + state[0]);",
    ].join('\n');

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn({ code: invalidCode }))
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: repairedCode,
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Repaired reserved helper bindings.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: repairedCode, changeSummary: 'Repaired reserved helper bindings.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const repairMessages = JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages ?? []);
    expect(repairMessages).toContain('reserved runtime/helper destructuring declaration');
    expect(repairMessages).toContain('useState(...) or React.useState(...)');
    expect(JSON.stringify(response.patch)).toContain('Count');
    expect(JSON.stringify(response.patch)).not.toContain('createElement: h');
  });

  it('stops same-turn draft submission after validation fails so the model clears and rewrites first', async () => {
    mockPlanner(plannerPlan());

    const invalidCode = [
      'const { createElement: h, useState } = React;',
      "return h('section', null, 'Bad');",
    ].join('\n');
    const repairedCode = "return React.createElement('section', null, 'Recovered after validation failure');";

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(
        multiToolCallResponse([
          { name: 'append_component_code_chunk', args: { draftId: 'draft-widget', codeChunk: invalidCode } },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Bad generated code.',
            },
          },
          {
            name: 'submit_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Bad generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: repairedCode,
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Recovered generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: repairedCode, changeSummary: 'Recovered generated code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const repairMessages = JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages ?? []);
    expect(repairMessages).toContain('requiresClearAndRewrite');
    expect(repairMessages).toContain('clear_component_code');
    expect(repairMessages).toContain('Skipped because an earlier tool call in this turn failed');
    expect(JSON.stringify(response.patch)).toContain('Recovered after validation failure');
  });

  it('omits large appended code chunks from repair chat history while preserving the draft', async () => {
    mockPlanner(plannerPlan());

    const oversizedInvalidCode = `var React = React;\nreturn React.createElement('section', null, 'Bad');\n${'x'.repeat(5000)}`;
    const repairedCode = "return React.createElement('section', null, 'Repaired');";
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(generatedComponentCodeToolTurn({ code: oversizedInvalidCode }))
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: repairedCode,
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Repaired generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: repairedCode, changeSummary: 'Repaired generated code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const repairMessages = JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages ?? []);
    expect(repairMessages).toContain('reserved runtime/helper redeclaration (React)');
    expect(repairMessages).toContain('[omitted');
    expect(repairMessages).not.toContain('x'.repeat(5000));
    expect(JSON.stringify(response.patch)).toContain('Repaired');
  });

  it('ignores replayed omitted code placeholders without polluting non-empty drafts', async () => {
    mockPlanner(plannerPlan());

    const completeCode = "return React.createElement('section', null, 'Recovered');";
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: completeCode,
      }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: '[omitted 5120 character code chunk already appended to draft-widget; call read_component_draft if exact code is needed, or clear_component_code before rewriting]',
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Recovered generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: completeCode, changeSummary: 'Recovered generated code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(JSON.stringify(response.patch)).toContain('Recovered');
    expect(JSON.stringify(response.patch)).not.toContain('[omitted');
  });

  it('rejects tool-history placeholder chunks before they can pollute empty drafts', async () => {
    mockPlanner(plannerPlan());

    const completeCode = "return React.createElement('section', null, 'Recovered after placeholder');";
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: '[see chunk below]',
      }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: completeCode,
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Recovered after placeholder.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: completeCode, changeSummary: 'Recovered after placeholder.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages)).toContain('tool-history placeholder');
    expect(JSON.stringify(response.patch)).toContain('Recovered after placeholder');
    expect(JSON.stringify(response.patch)).not.toContain('[see chunk below]');
  });

  it('rejects placeholders in empty component drafts but allows declaration chunks before a return chunk', async () => {
    process.env.AI_PATCH_REPAIR_ATTEMPTS = '3';
    mockPlanner(plannerPlan());

    const declarationCode = "const items0 = [{ id: 1, text: 'Task', done: false }];";
    const returnCode = "\nreturn React.createElement('section', null, items0[0].text);";
    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: 'function Widget(props) { /* placeholder */ return null; }',
      }))
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: declarationCode,
      }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: returnCode,
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Completed the generated code.',
            },
          },
        ]),
      );

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const allMessages = JSON.stringify(chatCompletionsMock.mock.calls.map((call) => call[0]?.messages ?? []));
    expect(allMessages).toContain('placeholder');
    expect(JSON.stringify(response.patch)).toContain('items0');
  });

  it('requires validation before replacing an existing complete draft', async () => {
    mockPlanner(plannerPlan());

    const initialCode = "const title = props.title || 'First';\nreturn React.createElement('section', null, title);";

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: initialCode,
      }))
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        toolCallResponse('validate_component_draft', {
          draftId: 'draft-widget',
          assistantText: 'Created the widget.',
          changeSummary: 'Validated generated code before replacement.',
        }),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: initialCode, changeSummary: 'Validated generated code before replacement.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const thirdTurnTools = chatCompletionsMock.mock.calls[3]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(thirdTurnTools).toEqual(['validate_component_draft', 'read_component_draft']);
    expect(JSON.stringify(chatCompletionsMock.mock.calls[4]?.[0]?.messages)).toContain('Tool clear_component_code is not available in the current workflow stage');
    expect(JSON.stringify(response.patch)).toContain('First');
  });

  it('requires clearing a draft before rewriting after forbidden API validation failure', async () => {
    process.env.AI_PATCH_REPAIR_ATTEMPTS = '5';
    mockPlanner(plannerPlan({ componentArchetype: 'sticky_note', userVisibleGoal: 'Create a sticky note component.' }));

    const unsafeCode =
      "const saved = localStorage.getItem('note') || 'Note';\nreturn React.createElement('section', null, saved);";
    const safeCode =
      "const note = props.initialNote || 'Note';\nreturn React.createElement('section', null, note);";

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn({ componentMeta: componentMeta('display', 'sticky_note', 'Create a sticky note component.') }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: { draftId: 'draft-widget', codeChunk: unsafeCode },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the note.',
              changeSummary: 'Validated sticky note.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: safeCode,
      }))
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: { draftId: 'draft-widget', codeChunk: safeCode },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the note.',
              changeSummary: 'Rewrote without forbidden APIs.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({
        code: safeCode,
        componentMeta: componentMeta('display', 'sticky_note', 'Create a sticky note component.'),
        changeSummary: 'Rewrote without forbidden APIs.',
      }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个便签组件', createInitialPageState(), []);

    const repairTools = chatCompletionsMock.mock.calls[3]?.[0]?.tools.map((tool: { function: { name: string } }) => tool.function.name);
    expect(repairTools).toEqual(['clear_component_code', 'read_component_draft']);
    expect(JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages)).toContain('cannot be fixed by appending');
    expect(JSON.stringify(chatCompletionsMock.mock.calls[4]?.[0]?.messages)).toContain('Tool append_component_code_chunk is not available in the current workflow stage');
    expect(JSON.stringify(response.patch)).toContain('initialNote');
    expect(JSON.stringify(response.patch)).not.toContain('localStorage');
  });

  it('rejects explanatory continuation comments after a complete draft and prompts validation', async () => {
    mockPlanner(plannerPlan());

    const completeCode = "return React.createElement('section', null, 'Already complete');";

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: completeCode,
      }))
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: '// continuation - no additional code needed',
      }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Validated complete code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: completeCode, changeSummary: 'Validated complete code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    const allMessages = JSON.stringify(chatCompletionsMock.mock.calls.map((call) => call[0]?.messages ?? []));
    expect(allMessages).toContain('continuation');
    expect(allMessages).toContain('Tool append_component_code_chunk is not available in the current workflow stage');
    expect(allMessages).toContain('validate_component_draft');
    expect(JSON.stringify(response.patch)).toContain('Already complete');
  });

  it('recovers by validating and submitting an existing complete draft when the model exhausts before submit', async () => {
    process.env.AI_PATCH_REPAIR_ATTEMPTS = '1';
    mockPlanner(plannerPlan());

    const completeCode = "return React.createElement('section', null, 'Recoverable complete draft');";

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: completeCode,
      }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(JSON.stringify(response.patch)).toContain('Recoverable complete draft');
    expect(response.changeSummary).toBe('Test planner task plan.');
  });

  it('does not recover invalid component drafts that were never validated successfully', async () => {
    process.env.AI_PATCH_REPAIR_ATTEMPTS = '1';
    mockPlanner(plannerPlan());

    chatCompletionsMock
      .mockResolvedValueOnce(generatedComponentDraftToolTurn())
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', {
        draftId: 'draft-widget',
        codeChunk: "var React = React;\nreturn React.createElement('section', null, 'Unsafe draft');",
      }));

    const { generateAssistantResponse } = await import('./ai');
    let caughtError: unknown;

    try {
      await generateAssistantResponse('创建一个组件', createInitialPageState(), []);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(String(caughtError)).toContain('reserved runtime/helper redeclaration (React)');
    expect(String(caughtError)).not.toContain('Patch agent exhausted tool turns');
  });

  it('rejects component drafts that would exceed the final generated code limit before submit', async () => {
    mockPlanner(plannerPlan());
    const tooLongCode = `return React.createElement('section', null, 'Too long');${' '.repeat(12_050)}`;
    const compactCode = "return React.createElement('section', null, 'Compact rewrite');";
    chatCompletionsMock
      .mockResolvedValueOnce(toolCallResponse('create_component_draft', generatedComponentDraftArgs()))
      .mockResolvedValueOnce(toolCallResponse('append_component_code_chunk', { draftId: 'draft-widget', codeChunk: tooLongCode }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          { name: 'append_component_code_chunk', args: { draftId: 'draft-widget', codeChunk: compactCode } },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Rewrote compact generated code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn({ code: compactCode, changeSummary: 'Rewrote compact generated code.' }));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages)).toContain('exceeding the generated component code limit');
    expect(JSON.stringify(response.patch)).toContain('Compact rewrite');
    expect(JSON.stringify(response.patch)).not.toContain('Too long');
  });

  it('accepts large component code chunks that normalize under the final code limit', async () => {
    mockPlanner(plannerPlan());
    const visibleText = 'Large chunk accepted';
    const longCode = `function OversizedWidget() { return React.createElement('section', null, ${JSON.stringify(visibleText)}); }${' '.repeat(13_000)}`;
    chatCompletionsMock
      .mockResolvedValueOnce(toolCallResponse('create_component_draft', generatedComponentDraftArgs()))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          { name: 'append_component_code_chunk', args: { draftId: 'draft-widget', codeChunk: longCode } },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Created the widget.',
              changeSummary: 'Added a generated widget.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(submitComponentDraftToolTurn());

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个组件', createInitialPageState(), []);

    expect(response.changeSummary).toBe('Added a generated widget.');
    expect(JSON.stringify(response.patch)).toContain(visibleText);
    expect(JSON.stringify(response.patch)).not.toContain('function OversizedWidget');
    expect(JSON.stringify(chatCompletionsMock.mock.calls)).not.toContain('String must contain at most 4000 character');
    expect(JSON.stringify(chatCompletionsMock.mock.calls)).not.toContain('String must contain at most 12000 character');
  });

  it('rejects invalid component draft parents before code generation so the model can retry metadata', async () => {
    mockPlanner(plannerPlan());
    chatCompletionsMock
      .mockResolvedValueOnce(toolCallResponse('create_component_draft', generatedComponentDraftArgs({ target: { parentId: 'page' } })))
      .mockResolvedValueOnce(toolCallResponse('create_component_draft', generatedComponentDraftArgs({ target: { parentId: 'root', index: 0 } })))
      .mockResolvedValueOnce(generatedComponentCodeToolTurn())
      .mockResolvedValueOnce(submitComponentDraftToolTurn());

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个表格', createInitialPageState(), []);

    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      target: { parentId: 'root', index: 0 },
    });
    expect(JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages)).toContain('Parent node not found: page');
  });

  it('rejects nested draft styleTokens early so the model can retry flat CSS metadata', async () => {
    mockPlanner(plannerPlan());
    chatCompletionsMock
      .mockResolvedValueOnce(
        toolCallResponse('create_component_draft', generatedComponentDraftArgs({ styleTokens: { typography: { fontSize: '14px' } } })),
      )
      .mockResolvedValueOnce(toolCallResponse('create_component_draft', generatedComponentDraftArgs({ styleTokens: { fontSize: '14px', fontWeight: 600 } })))
      .mockResolvedValueOnce(generatedComponentCodeToolTurn())
      .mockResolvedValueOnce(submitComponentDraftToolTurn());

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个日历', createInitialPageState(), []);

    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      node: {
        styleTokens: {
          fontSize: '14px',
          fontWeight: 600,
        },
      },
    });
    expect(JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages)).toContain('styleTokens must be a flat object');
    expect(JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages)).toContain('Invalid keys: typography');
  });

  it('does not report a stale draft metadata error after a later draft can be recovered', async () => {
    process.env.AI_PATCH_REPAIR_ATTEMPTS = '2';
    mockPlanner(plannerPlan());
    chatCompletionsMock
      .mockResolvedValueOnce(
        toolCallResponse('create_component_draft', generatedComponentDraftArgs({ styleTokens: { typography: { fontSize: '14px' } } })),
      )
      .mockResolvedValueOnce(toolCallResponse('create_component_draft', generatedComponentDraftArgs({ styleTokens: { fontSize: '14px' } })))
      .mockResolvedValueOnce(
        toolCallResponse('append_component_code_chunk', {
          draftId: 'draft-widget',
          codeChunk: "return React.createElement('section', null, 'Calendar');",
        }),
    );

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个日历', createInitialPageState(), []);

    expect(JSON.stringify(response.patch)).toContain('Calendar');
    expect(JSON.stringify(response.patch)).not.toContain('Invalid component draft styleTokens');
  });

  it('uses component update drafts for existing generated components', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget.',
          requiresGeneratedCode: true,
          shouldRewriteComponentCode: true,
        },
        'Move the existing generated widget.',
      ),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        toolCallResponse('create_component_update_draft', {
          draftId: 'draft-widget',
          nodeId: 'generated-widget',
          mountProps: { title: 'Generated widget' },
          capabilities: [],
          componentMeta: componentMeta('display', 'custom_widget', 'Move the existing widget.'),
        }),
      )
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: "return React.createElement('section', { style: { position: 'fixed', top: 0, left: 0 } }, props.title || 'Generated widget');",
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Moved the widget.',
              changeSummary: 'Updated generated widget code.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(toolCallResponse('submit_component_draft', {
        draftId: 'draft-widget',
        assistantText: 'Moved the widget.',
        changeSummary: 'Updated generated widget code.',
      }));

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件移到左上角', pageState, []);

    const finalizerBody = chatCompletionsMock.mock.calls[1]?.[0];
    expect(finalizerBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'create_component_update_draft',
      'get_component_detail',
    ]);
    const codeBody = chatCompletionsMock.mock.calls[2]?.[0];
    expect(codeBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'clear_component_code',
      'validate_component_draft',
      'read_component_draft',
    ]);
    const rewriteBody = chatCompletionsMock.mock.calls[3]?.[0];
    expect(rewriteBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'append_component_code_chunk',
      'validate_component_draft',
    ]);
    expect(response.patch[0]).toMatchObject({
      type: 'update_node',
      nodeId: 'generated-widget',
      props: {
        code: expect.stringContaining('position'),
      },
    });
  });

  it('normalizes MiniMax item-wrapped arrays before validating component update drafts', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'data',
          componentArchetype: 'table',
          userVisibleGoal: 'Restyle the existing table.',
          requiresGeneratedCode: true,
          shouldRewriteComponentCode: true,
        },
        'Restyle the existing generated table.',
      ),
    );

    const tableCode = [
      "const rows = Array.isArray(props.rows) ? props.rows : [];",
      "const body = rows.map((row, rowIndex) => React.createElement('tr', { key: rowIndex }, (Array.isArray(row) ? row : []).map((cell, cellIndex) => React.createElement('td', { key: cellIndex }, String(cell)))));",
      "return React.createElement('table', null, React.createElement('tbody', null, body));",
    ].join('\n');

    chatCompletionsMock
      .mockResolvedValueOnce(
        toolCallResponse('create_component_update_draft', {
          draftId: 'draft-widget',
          nodeId: 'generated-widget',
          mountProps: {
            rows: {
              item: [
                { item: ['A', 'Doing', 'High'] },
                { item: ['B', 'Done', 'Low'] },
              ],
            },
          },
          capabilities: [],
          componentMeta: componentMeta('data', 'table', 'Restyle the existing table.'),
        }),
      )
      .mockResolvedValueOnce(
        toolCallResponse('validate_component_draft', {
          draftId: 'draft-widget',
          assistantText: 'Updated the table.',
          changeSummary: 'Validated item-wrapped rows.',
        }),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_component_draft', {
          draftId: 'draft-widget',
          assistantText: 'Updated the table.',
          changeSummary: 'Validated item-wrapped rows.',
        }),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch({
      node: {
        id: 'generated-widget',
        type: 'generated_react_component',
        props: {
          name: 'Generated table',
          code: tableCode,
          mountProps: {
            rows: [
              ['A', 'Doing', 'High'],
              ['B', 'Done', 'Low'],
            ],
          },
          capabilities: [],
          componentMeta: componentMeta('data', 'table'),
        },
        styleTokens: {},
        children: [],
      },
    } as Partial<PagePatchOperation>)[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把表格改成紧凑风格', pageState, []);

    expect(response.patch[0]).toMatchObject({
      type: 'update_node',
      nodeId: 'generated-widget',
      props: {
        mountProps: {
          rows: [
            ['A', 'Doing', 'High'],
            ['B', 'Done', 'Low'],
          ],
        },
      },
    });
  });

  it('exposes full component draft tools after an existing complete update draft has been cleared', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Rewrite the existing widget.',
          requiresGeneratedCode: true,
          shouldRewriteComponentCode: true,
        },
        'Rewrite the existing generated widget.',
      ),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        toolCallResponse('create_component_update_draft', {
          draftId: 'draft-widget',
          nodeId: 'generated-widget',
          componentMeta: componentMeta('display', 'custom_widget', 'Rewrite the existing widget.'),
        }),
      )
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'append_component_code_chunk',
            args: {
              draftId: 'draft-widget',
              codeChunk: "return React.createElement('section', null, 'Rewritten');",
            },
          },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Rewritten.',
              changeSummary: 'Rewrote the widget.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(toolCallResponse('submit_component_draft', {
        draftId: 'draft-widget',
        assistantText: 'Rewritten.',
        changeSummary: 'Rewrote the widget.',
      }));

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('重写这个组件', pageState, []);

    const clearBody = chatCompletionsMock.mock.calls[2]?.[0];
    expect(clearBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'clear_component_code',
      'validate_component_draft',
      'read_component_draft',
    ]);
    const rewriteBody = chatCompletionsMock.mock.calls[3]?.[0];
    expect(rewriteBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'append_component_code_chunk',
      'validate_component_draft',
    ]);
    expect(response.patch[0]).toMatchObject({
      type: 'update_node',
      nodeId: 'generated-widget',
      props: {
        code: expect.stringContaining('Rewritten'),
      },
    });
  });

  it('does not require directional layout evidence for compact visual component updates', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'time_based',
          componentArchetype: 'simple_calendar',
          userVisibleGoal: 'Make the calendar more compact and emphasize today.',
          visualRequirements: ['Reduce spacing', 'Highlight today', 'No changes to the surrounding columns layout'],
          acceptanceCriteria: ['Calendar is more compact', 'Today is prominent'],
          requiresGeneratedCode: true,
          shouldRewriteComponentCode: true,
        },
        'Make the calendar more compact and emphasize today.',
      ),
    );
    const compactCode = "return React.createElement('section', null, 'Compact today highlight');";
    chatCompletionsMock
      .mockResolvedValueOnce(
        toolCallResponse('create_component_update_draft', {
          draftId: 'draft-widget',
          nodeId: 'generated-widget',
          mountProps: { title: 'Generated widget' },
          capabilities: [],
          componentMeta: componentMeta('time_based', 'simple_calendar', 'Make the calendar compact.'),
        }),
      )
      .mockResolvedValueOnce(toolCallResponse('clear_component_code', { draftId: 'draft-widget' }))
      .mockResolvedValueOnce(
        multiToolCallResponse([
          { name: 'append_component_code_chunk', args: { draftId: 'draft-widget', codeChunk: compactCode } },
          {
            name: 'validate_component_draft',
            args: {
              draftId: 'draft-widget',
              assistantText: 'Updated the calendar.',
              changeSummary: 'Made the calendar compact.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_component_draft', {
          draftId: 'draft-widget',
          assistantText: 'Updated the calendar.',
          changeSummary: 'Made the calendar compact.',
        }),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把日历改得更紧凑一点，并突出今天', pageState, []);

    expect(JSON.stringify(response.patch)).toContain('Compact today highlight');
    expect(JSON.stringify(chatCompletionsMock.mock.calls)).not.toContain('requires directional layout');
  });

  it('uses operation tools for generated component moves instead of rewriting code', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget.',
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'Move the existing generated widget.',
      ),
    );
    chatCompletionsMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call-move',
                type: 'function',
                function: {
                  name: 'move_node',
                  arguments: JSON.stringify({
                    nodeId: 'generated-widget',
                    target: { parentId: 'root', index: 0 },
                  }),
                },
              },
              {
                id: 'call-submit',
                type: 'function',
                function: {
                  name: 'submit_collected_patch',
                  arguments: JSON.stringify({
                    assistantText: 'Moved the widget.',
                    changeSummary: 'Moved generated widget within the root.',
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件移动到最前面', pageState, []);

    const finalizerBody = chatCompletionsMock.mock.calls[1]?.[0];
    expect(finalizerBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(expect.arrayContaining([
      'add_standard_node',
      'update_node',
      'move_node',
      'remove_node',
      'set_theme_tokens',
      'set_behavior_state_defaults',
      'submit_collected_patch',
      'get_component_detail',
    ]));
    expect(response.patch).toEqual([
      {
        type: 'move_node',
        nodeId: 'generated-widget',
        target: { parentId: 'root', index: 0 },
      },
    ]);
  });

  it('forces operation workflows to submit collected operations instead of looping on more moves', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget.',
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'Move the existing generated widget.',
      ),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'move_node',
            args: {
              nodeId: 'generated-widget',
              target: { parentId: 'root', index: 0 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_collected_patch', {
          assistantText: 'Moved the widget.',
          changeSummary: 'Submitted the collected move operation.',
        }),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件移动到最前面', pageState, []);

    const submitTurn = chatCompletionsMock.mock.calls[2]?.[0];
    expect(submitTurn.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['submit_collected_patch']);
    expect(JSON.stringify(submitTurn.messages)).toContain('Call submit_collected_patch now');
    expect(response.patch).toEqual([
      {
        type: 'move_node',
        nodeId: 'generated-widget',
        target: { parentId: 'root', index: 0 },
      },
    ]);
  });

  it('recovers valid collected operation workspaces when the model exhausts before submit', async () => {
    process.env.AI_PATCH_REPAIR_ATTEMPTS = '0';
    mockPlanner({
      reasoning: 'Place calendar left and todo right without overlap.',
      tasks: [
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'simple-calendar',
          referenceNodeId: null,
          relationToReference: 'none',
          componentCategory: 'data',
          componentArchetype: 'simple_calendar',
          userVisibleGoal: 'Move the calendar to the top-left.',
          behavioralRequirements: [],
          visualRequirements: ['Top aligned', 'Left side', 'No overlap'],
          acceptanceCriteria: ['Calendar is in the left half'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: false,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'todo-list-001',
          referenceNodeId: null,
          relationToReference: 'none',
          componentCategory: 'data',
          componentArchetype: 'todo_list',
          userVisibleGoal: 'Move the todo list to the top-right.',
          behavioralRequirements: [],
          visualRequirements: ['Top aligned', 'Right side', 'No overlap'],
          acceptanceCriteria: ['Todo list is in the right half'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: false,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
      ],
      confidence: 'high',
    });
    chatCompletionsMock.mockResolvedValueOnce(
      multiToolCallResponse([
        {
          name: 'add_standard_node',
          args: {
            target: { parentId: 'root', index: 0 },
            node: {
              id: 'calendar-todo-grid',
              type: 'columns',
              props: { columns: 2 },
              styleTokens: {
                gap: '24px',
                width: 'min(1120px, calc(100vw - 64px))',
                alignItems: 'start',
              },
              children: [],
            },
          },
        },
        { name: 'move_node', args: { nodeId: 'simple-calendar', target: { parentId: 'calendar-todo-grid', index: 0 } } },
        { name: 'move_node', args: { nodeId: 'todo-list-001', target: { parentId: 'calendar-todo-grid', index: 1 } } },
      ]),
    );

    const pageState: PageState = createInitialPageState();
    const calendarPatch = generatedComponentPatch({
      node: {
        id: 'simple-calendar',
        type: 'generated_react_component',
        props: {
          name: 'SimpleCalendar',
          code: "return React.createElement('section', null, 'Calendar');",
          mountProps: {},
          capabilities: [],
          componentMeta: componentMeta('data', 'simple_calendar'),
        },
        styleTokens: {},
        children: [],
      },
    } as Partial<PagePatchOperation>)[0];
    const todoPatch = generatedComponentPatch({
      node: {
        id: 'todo-list-001',
        type: 'generated_react_component',
        props: {
          name: 'TodoList',
          code: "return React.createElement('section', null, 'Todo');",
          mountProps: {},
          capabilities: [],
          componentMeta: componentMeta('data', 'todo_list'),
        },
        styleTokens: {},
        children: [],
      },
    } as Partial<PagePatchOperation>)[0];
    if (calendarPatch.type === 'add_node') {
      pageState.root.children.push(calendarPatch.node);
    }
    if (todoPatch.type === 'add_node') {
      pageState.root.children.push(todoPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把日历放左上，待办清单放右上，不要互相遮挡', pageState, []);

    expect(chatCompletionsMock).toHaveBeenCalledTimes(2);
    expect(response.patch).toMatchObject([
      {
        type: 'add_node',
        node: {
          id: 'calendar-todo-grid',
          type: 'columns',
          props: { columns: 2 },
        },
      },
      { type: 'move_node', nodeId: 'simple-calendar', target: { parentId: 'calendar-todo-grid' } },
      { type: 'move_node', nodeId: 'todo-list-001', target: { parentId: 'calendar-todo-grid' } },
    ]);
  });

  it('rejects empty update_node layout patches so the model must make a real change', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          referenceNodeId: null,
          relationToReference: 'none',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget to the top-left.',
          visualRequirements: ['Place it at top-left without overlap'],
          acceptanceCriteria: ['Widget is visually positioned at top-left'],
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'Move the existing generated widget to the top-left.',
      ),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        multiToolCallResponse([
          { name: 'update_node', args: { nodeId: 'generated-widget' } },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Moved the widget.',
              changeSummary: 'Touched the widget.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'update_node',
            args: {
              nodeId: 'generated-widget',
              styleTokens: {
                position: 'fixed',
                top: '24px',
                left: '24px',
                width: 'min(360px, calc(100vw - 48px))',
              },
            },
          },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Moved the widget.',
              changeSummary: 'Positioned the widget at top-left.',
            },
          },
        ]),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件放到左上角', pageState, []);

    expect(JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages)).toContain('update_node requires');
    expect(response.patch).toEqual([
      {
        type: 'update_node',
        nodeId: 'generated-widget',
        styleTokens: {
          position: 'fixed',
          top: '24px',
          left: '24px',
          width: 'min(360px, calc(100vw - 48px))',
        },
      },
    ]);
  });

  it('rejects fake multi-component layout patches without real layout styles', async () => {
    mockPlanner({
      reasoning: 'Place calendar left and todo right without overlap.',
      tasks: [
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'simple-calendar',
          referenceNodeId: null,
          relationToReference: 'none',
          componentCategory: 'data',
          componentArchetype: 'simple_calendar',
          userVisibleGoal: 'Move the calendar to the top-left.',
          behavioralRequirements: [],
          visualRequirements: ['Top aligned', 'Left side', 'No overlap'],
          acceptanceCriteria: ['Calendar is in the left half'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: false,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'todo-list-001',
          referenceNodeId: null,
          relationToReference: 'none',
          componentCategory: 'data',
          componentArchetype: 'todo_list',
          userVisibleGoal: 'Move the todo list to the top-right.',
          behavioralRequirements: [],
          visualRequirements: ['Top aligned', 'Right side', 'No overlap'],
          acceptanceCriteria: ['Todo list is in the right half'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: false,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
      ],
      confidence: 'high',
    });
    chatCompletionsMock
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root' },
              node: {
                id: 'calendar-todo-container',
                type: 'section',
                props: {},
                styleTokens: {},
                children: [],
              },
            },
          },
          { name: 'move_node', args: { nodeId: 'simple-calendar', target: { parentId: 'calendar-todo-container', index: 0 } } },
          { name: 'move_node', args: { nodeId: 'todo-list-001', target: { parentId: 'calendar-todo-container', index: 1 } } },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Arranged the components.',
              changeSummary: 'Moved components into a container.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root' },
              node: {
                id: 'calendar-todo-grid',
                type: 'section',
                props: {},
                styleTokens: {
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                  gap: '24px',
                  alignItems: 'start',
                  width: 'min(1120px, calc(100vw - 64px))',
                },
                children: [],
              },
            },
          },
          { name: 'move_node', args: { nodeId: 'simple-calendar', target: { parentId: 'calendar-todo-grid', index: 0 } } },
          { name: 'move_node', args: { nodeId: 'todo-list-001', target: { parentId: 'calendar-todo-grid', index: 1 } } },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Arranged the components.',
              changeSummary: 'Placed both components in a grid container.',
            },
          },
        ]),
      );

    const pageState: PageState = createInitialPageState();
    const calendarPatch = generatedComponentPatch({
      node: {
        id: 'simple-calendar',
        type: 'generated_react_component',
        props: {
          name: 'SimpleCalendar',
          code: "return React.createElement('section', null, 'Calendar');",
          mountProps: {},
          capabilities: [],
          componentMeta: componentMeta('data', 'simple_calendar'),
        },
        styleTokens: {},
        children: [],
      },
    } as Partial<PagePatchOperation>)[0];
    const todoPatch = generatedComponentPatch({
      node: {
        id: 'todo-list-001',
        type: 'generated_react_component',
        props: {
          name: 'TodoList',
          code: "return React.createElement('section', null, 'Todo');",
          mountProps: {},
          capabilities: [],
          componentMeta: componentMeta('data', 'todo_list'),
        },
        styleTokens: {},
        children: [],
      },
    } as Partial<PagePatchOperation>)[0];
    if (calendarPatch.type === 'add_node') {
      pageState.root.children.push(calendarPatch.node);
    }
    if (todoPatch.type === 'add_node') {
      pageState.root.children.push(todoPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把日历放左上，待办清单放右上，不要互相遮挡', pageState, []);

    expect(JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages)).toContain('real grid/flex/columns layout container');
    expect(response.patch).toMatchObject([
      {
        type: 'add_node',
        node: {
          id: 'calendar-todo-grid',
          styleTokens: {
            display: 'grid',
          },
        },
      },
      { type: 'move_node', nodeId: 'simple-calendar' },
      { type: 'move_node', nodeId: 'todo-list-001' },
    ]);
  });

  it('rejects multi-component no-overlap layouts that only anchor wide components to opposite sides', async () => {
    mockPlanner({
      reasoning: 'Place calendar left and todo right without overlap.',
      tasks: [
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'simple-calendar',
          referenceNodeId: 'todo-list-001',
          relationToReference: 'left_of',
          componentCategory: 'data',
          componentArchetype: 'simple_calendar',
          userVisibleGoal: 'Move the calendar to the top-left without overlap.',
          behavioralRequirements: [],
          visualRequirements: ['Top aligned', 'Left side', 'No overlap'],
          acceptanceCriteria: ['Calendar is in the left half and does not overlap todo'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: false,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'todo-list-001',
          referenceNodeId: 'simple-calendar',
          relationToReference: 'right_of',
          componentCategory: 'data',
          componentArchetype: 'todo_list',
          userVisibleGoal: 'Move the todo list to the top-right without overlap.',
          behavioralRequirements: [],
          visualRequirements: ['Top aligned', 'Right side', 'No overlap'],
          acceptanceCriteria: ['Todo list is in the right half and does not overlap calendar'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: null,
          requiresGeneratedCode: false,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        },
      ],
      confidence: 'high',
    });
    chatCompletionsMock
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'update_node',
            args: {
              nodeId: 'simple-calendar',
              styleTokens: {
                position: 'fixed',
                top: '16px',
                left: '16px',
                width: '420px',
              },
            },
          },
          {
            name: 'update_node',
            args: {
              nodeId: 'todo-list-001',
              styleTokens: {
                position: 'fixed',
                top: '16px',
                right: '16px',
                width: '420px',
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_collected_patch', {
          assistantText: 'Arranged the components.',
          changeSummary: 'Anchored both components to opposite sides.',
        }),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root' },
              node: {
                id: 'calendar-todo-grid',
                type: 'section',
                props: {},
                styleTokens: {
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                  gap: '24px',
                  alignItems: 'start',
                  width: 'min(1120px, calc(100vw - 64px))',
                },
                children: [],
              },
            },
          },
          { name: 'move_node', args: { nodeId: 'simple-calendar', target: { parentId: 'calendar-todo-grid', index: 0 } } },
          { name: 'move_node', args: { nodeId: 'todo-list-001', target: { parentId: 'calendar-todo-grid', index: 1 } } },
        ]),
      )
      .mockResolvedValueOnce(
        toolCallResponse('submit_collected_patch', {
          assistantText: 'Arranged the components.',
          changeSummary: 'Moved both components into a grid container.',
        }),
      );

    const pageState: PageState = createInitialPageState();
    const calendarPatch = generatedComponentPatch({
      node: {
        id: 'simple-calendar',
        type: 'generated_react_component',
        props: {
          name: 'SimpleCalendar',
          code: "return React.createElement('section', null, 'Calendar');",
          mountProps: {},
          capabilities: [],
          componentMeta: componentMeta('data', 'simple_calendar'),
        },
        styleTokens: {},
        children: [],
      },
    } as Partial<PagePatchOperation>)[0];
    const todoPatch = generatedComponentPatch({
      node: {
        id: 'todo-list-001',
        type: 'generated_react_component',
        props: {
          name: 'TodoList',
          code: "return React.createElement('section', null, 'Todo');",
          mountProps: {},
          capabilities: [],
          componentMeta: componentMeta('data', 'todo_list'),
        },
        styleTokens: {},
        children: [],
      },
    } as Partial<PagePatchOperation>)[0];
    if (calendarPatch.type === 'add_node') {
      pageState.root.children.push(calendarPatch.node);
    }
    if (todoPatch.type === 'add_node') {
      pageState.root.children.push(todoPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把日历放左上，待办清单放右上，不要互相遮挡', pageState, []);

    expect(JSON.stringify(chatCompletionsMock.mock.calls[3]?.[0]?.messages)).toContain('without overlap');
    expect(response.patch).toMatchObject([
      {
        type: 'add_node',
        node: {
          id: 'calendar-todo-grid',
          styleTokens: {
            display: 'grid',
          },
        },
      },
      { type: 'move_node', nodeId: 'simple-calendar' },
      { type: 'move_node', nodeId: 'todo-list-001' },
    ]);
  });

  it('validates operation tool payloads before collecting malformed nodes', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget into a layout container.',
          visualRequirements: ['Use a layout container'],
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'Move the existing generated widget into a layout container.',
      ),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'bad-layout',
                type: 'section',
                props: {},
                styleTokens: { display: 'grid', gridTemplateColumns: '1fr' },
                children: ['generated-widget'],
              },
            },
          },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Moved the widget.',
              changeSummary: 'Bad layout.',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'good-layout',
                type: 'section',
                props: {},
                styleTokens: { display: 'grid', gridTemplateColumns: '1fr' },
                children: [],
              },
            },
          },
          {
            name: 'move_node',
            args: {
              nodeId: 'generated-widget',
              target: { parentId: 'good-layout', index: 0 },
            },
          },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Moved the widget.',
              changeSummary: 'Moved widget into a valid layout.',
            },
          },
        ]),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件放进一个布局容器', pageState, []);

    expect(JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages)).toContain('add_standard_node only creates one empty node at a time');
    expect(response.patch).toMatchObject([
      {
        type: 'add_node',
        node: {
          id: 'good-layout',
          children: [],
        },
      },
      {
        type: 'move_node',
        nodeId: 'generated-widget',
      },
    ]);
  });

  it('normalizes generated-like props on standard layout nodes from add_standard_node', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'layout',
          componentArchetype: 'columns_layout',
          userVisibleGoal: 'Move the existing widget into a columns layout.',
          visualRequirements: ['Use a two-column layout container'],
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'Move the existing generated widget into a columns layout.',
      ),
    );
    chatCompletionsMock.mockResolvedValueOnce(
      multiToolCallResponse([
        {
          name: 'add_standard_node',
          args: {
            target: { parentId: 'root', index: 0 },
            node: {
              id: 'generated-like-layout',
              type: 'columns',
              props: {
                name: 'Generated-like layout',
                code: '',
                mountProps: {},
                capabilities: [],
                componentMeta: { category: 'layout', archetype: 'columns_layout' },
              },
              behavior: {
                layout: 'flex-row',
                columns: 2,
                columnGap: 16,
                alignItems: 'flex-start',
              },
              children: [],
            },
          },
        },
        {
          name: 'move_node',
          args: {
            nodeId: 'generated-widget',
            target: { parentId: 'generated-like-layout', index: 0 },
          },
        },
        {
          name: 'submit_collected_patch',
          args: {
            assistantText: 'Moved the widget.',
            changeSummary: 'Moved widget into normalized layout.',
          },
        },
      ]),
    );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件放进两列布局容器', pageState, []);

    expect(response.patch).toMatchObject([
      {
        type: 'add_node',
        node: {
          id: 'generated-like-layout',
          type: 'columns',
          props: { columns: 2 },
          children: [],
        },
      },
      {
        type: 'move_node',
        nodeId: 'generated-widget',
        target: { parentId: 'generated-like-layout' },
      },
    ]);
    expect(JSON.stringify(response.patch)).not.toContain('componentMeta');
    expect(JSON.stringify(response.patch)).not.toContain('mountProps');
  });

  it('keeps add_standard_node atomic so layout children are created with move_node operations', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget into a layout container.',
          visualRequirements: ['Use a layout container'],
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'Move the existing generated widget into a layout container.',
      ),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'bad-layout',
                type: 'section',
                props: {},
                styleTokens: { display: 'grid', gridTemplateColumns: '1fr' },
                children: [
                  {
                    id: 'bad-child',
                    type: 'section',
                    props: {},
                    styleTokens: {},
                    children: [],
                  },
                ],
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'good-layout',
                type: 'section',
                props: {},
                styleTokens: { display: 'grid', gridTemplateColumns: '1fr' },
                children: [],
              },
            },
          },
          {
            name: 'move_node',
            args: {
              nodeId: 'generated-widget',
              target: { parentId: 'good-layout', index: 0 },
            },
          },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Moved the widget.',
              changeSummary: 'Moved widget with atomic layout operations.',
            },
          },
        ]),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件放进一个布局容器', pageState, []);

    const repairMessages = JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages);
    expect(repairMessages).toContain('add_standard_node only creates one empty node at a time');
    expect(response.patch).toMatchObject([
      {
        type: 'add_node',
        node: {
          id: 'good-layout',
          children: [],
        },
      },
      {
        type: 'move_node',
        nodeId: 'generated-widget',
      },
    ]);
  });

  it('rolls back collected operations that reference nodes not yet present in the patch workspace', async () => {
    mockPlanner(
      plannerPlan(
        {
          intent: 'move',
          subject: 'existing_component',
          targetNodeId: 'generated-widget',
          componentCategory: 'display',
          componentArchetype: 'custom_widget',
          userVisibleGoal: 'Move the existing widget into a layout container.',
          visualRequirements: ['Use a layout container'],
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'Move the existing generated widget into a layout container.',
      ),
    );
    chatCompletionsMock
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'move_node',
            args: {
              nodeId: 'generated-widget',
              target: { parentId: 'missing-layout', index: 0 },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        multiToolCallResponse([
          {
            name: 'add_standard_node',
            args: {
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'good-layout',
                type: 'section',
                props: {},
                styleTokens: { display: 'grid', gridTemplateColumns: '1fr' },
                children: [],
              },
            },
          },
          {
            name: 'move_node',
            args: {
              nodeId: 'generated-widget',
              target: { parentId: 'good-layout', index: 0 },
            },
          },
          {
            name: 'submit_collected_patch',
            args: {
              assistantText: 'Moved the widget.',
              changeSummary: 'Moved widget into a valid layout.',
            },
          },
        ]),
      );

    const pageState: PageState = createInitialPageState();
    const addPatch = generatedComponentPatch()[0];
    if (addPatch.type === 'add_node') {
      pageState.root.children.push(addPatch.node);
    }

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('把这个组件放进一个布局容器', pageState, []);

    const repairMessages = JSON.stringify(chatCompletionsMock.mock.calls[2]?.[0]?.messages);
    expect(repairMessages).toContain('Unable to move node');
    expect(repairMessages).toContain('No existing or collected parent node has parentId');
    expect(repairMessages).toContain('current component inventory');
    expect(repairMessages).toContain('generated-widget');
    expect(response.patch).toMatchObject([
      {
        type: 'add_node',
        node: { id: 'good-layout' },
      },
      {
        type: 'move_node',
        nodeId: 'generated-widget',
        target: { parentId: 'good-layout' },
      },
    ]);
  });

  it('applies component image results through native patch tools', async () => {
    const imageData = Buffer.from('table background').toString('base64');
    imageFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inline_data: {
                      mime_type: 'image/png',
                      data: imageData,
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    mockPlanner(
      plannerPlan(
        {
          intent: 'update',
          subject: 'existing_component',
          targetNodeId: 'table-1',
          componentCategory: 'data',
          componentArchetype: 'table_background_image',
          userVisibleGoal: 'Generate an image as the table background.',
          needsImage: true,
          imageTarget: 'component',
          imagePrompt: 'Subtle abstract texture for a table background',
          requiresGeneratedCode: true,
        },
        'The user wants a generated image as the table background.',
      ),
    );
    chatCompletionsMock.mockResolvedValueOnce(
      toolCallResponse('submit_prepared_patch', {
        assistantText: 'Updated the table background.',
        changeSummary: 'Applied generated image to the table component.',
      }),
    );

    const pageState: PageState = createInitialPageState();
    pageState.root.children.push({
      id: 'table-1',
      type: 'generated_react_component',
      props: {
        name: '3x3 Table',
        code: [
          'const e = React.createElement;',
          "const columns = Array.isArray(props.columns) ? props.columns : [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }];",
          "const rows = Array.isArray(props.rows) ? props.rows : [{ id: 1, name: 'Alice Chen', status: 'Active' }];",
          "return e('table', null,",
          "  e('thead', null, e('tr', null, columns.map((column) => e('th', { key: column.key }, column.label)))),",
          "  e('tbody', null, rows.map((row) => e('tr', { key: row.id }, columns.map((column) => e('td', { key: column.key }, String(row[column.key] ?? ''))))))",
          ');',
        ].join('\n'),
        mountProps: {
          columns: [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status' },
          ],
          rows: [
            { id: 1, name: 'Alice Chen', status: 'Active' },
            { id: 2, name: 'Bob Martinez', status: 'Review' },
          ],
        },
        capabilities: [],
        componentMeta: componentMeta('data', '3x3_table'),
      },
      styleTokens: {},
      children: [],
    });

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('给表格背景生成一张图片', pageState, []);

    expect(imageFetchMock).toHaveBeenCalledTimes(1);
    const finalizerBody = chatCompletionsMock.mock.calls[1]?.[0];
    expect(finalizerBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['submit_prepared_patch']);
    expect(JSON.stringify(finalizerBody)).not.toContain('data:image');
    expect(JSON.stringify(finalizerBody)).toContain('__workflow_image_1__');
    expect(response.patch[0]).toMatchObject({
      type: 'update_node',
      nodeId: 'table-1',
      props: {
        mountProps: {
          backgroundImage: expect.stringMatching(/^data:image\/png;base64,/),
        },
      },
    });
    expect(JSON.stringify(response.patch)).not.toContain('__renderOriginalComponent');
    expect(response.patch[0]).not.toMatchObject({
      type: 'update_node',
      props: {
        code: expect.any(String),
      },
    });
    expect(JSON.stringify(response.patch)).not.toContain('row.map');
  });

  it('applies prepared page background image patches without asking the model to rebuild nested patch JSON', async () => {
    const imageData = Buffer.from('page background').toString('base64');
    imageFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inline_data: {
                      mime_type: 'image/png',
                      data: imageData,
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    mockPlanner(
      plannerPlan(
        {
          intent: 'create',
          subject: 'page_background',
          componentCategory: 'unknown',
          componentArchetype: 'page_background',
          userVisibleGoal: 'Create a themed page background image.',
          needsImage: true,
          imageTarget: 'page',
          imagePrompt: 'Pokemon style background featuring Gengar',
          requiresGeneratedCode: false,
          shouldRewriteComponentCode: false,
        },
        'The user wants a generated page background.',
      ),
    );
    chatCompletionsMock.mockResolvedValueOnce(
      toolCallResponse('submit_prepared_patch', {
        assistantText: 'Updated the page background.',
        changeSummary: 'Applied the generated page background image.',
      }),
    );

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('背景改成宝可梦风格，主角是耿鬼', createInitialPageState(), []);

    expect(imageFetchMock).toHaveBeenCalledTimes(1);
    const finalizerBody = chatCompletionsMock.mock.calls[1]?.[0];
    expect(finalizerBody.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['submit_prepared_patch']);
    expect(JSON.stringify(finalizerBody)).not.toContain('patchJson');
    expect(response.patch).toMatchObject([
      { type: 'set_theme_tokens' },
      {
        type: 'add_node',
        node: {
          type: 'image_background',
          props: {
            src: expect.stringMatching(/^data:image\/png;base64,/),
          },
        },
      },
    ]);
  });
});
