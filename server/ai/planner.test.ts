import { describe, expect, it, vi } from 'vitest';
import { createInitialPageState } from '../../src/shared/defaults';
import type { TextModelClient } from './contracts';
import { generateWorkflowPlan, normalizeWorkflowPlan } from './planner';

type MockTextModelClient = TextModelClient & {
  createToolTurn: ReturnType<typeof vi.fn>;
};

function createTextProviderReturning(...values: unknown[]): MockTextModelClient {
  const createToolTurn = vi.fn();
  values.forEach((value, index) =>
    createToolTurn.mockResolvedValueOnce({
      content: '',
      tool_calls: [
        {
          id: `call-${index + 1}`,
          type: 'function',
          function: {
            name: 'submit_plan',
            arguments: JSON.stringify(value),
          },
        },
      ],
    }),
  );
  createToolTurn.mockResolvedValue({
    content: '',
    tool_calls: [
      {
        id: 'call-final',
        type: 'function',
        function: {
          name: 'submit_plan',
          arguments: JSON.stringify(values[values.length - 1]),
        },
      },
    ],
  });
  return {
    baseUrl: 'https://text.local/v1',
    model: 'MiniMax-M3',
    provider: 'test-provider',
    createToolTurn: createToolTurn as unknown as TextModelClient['createToolTurn'],
  } as MockTextModelClient;
}

function pomodoroTask(overrides: Record<string, unknown> = {}) {
  return {
    intent: 'create',
    subject: 'new_component',
    targetNodeId: null,
    referenceNodeId: null,
    relationToReference: 'none',
    componentCategory: 'time_based',
    componentArchetype: 'pomodoro_timer',
    userVisibleGoal: 'Create a Pomodoro timer component.',
    behavioralRequirements: ['configurable focus duration', 'start pause reset', 'focus and rest phases'],
    visualRequirements: ['clear countdown display'],
    acceptanceCriteria: ['User can start, pause, and reset the timer.'],
    needsImage: false,
    imageTarget: 'none',
    imagePrompt: null,
    requiresGeneratedCode: true,
    shouldEditExistingImage: false,
    shouldRewriteComponentCode: true,
    ...overrides,
  };
}

describe('workflow planner contract', () => {
  it('accepts the canonical task-based workflow plan schema', () => {
    const plan = normalizeWorkflowPlan({
      reasoning: 'Create a generated component.',
      tasks: [pomodoroTask()],
      confidence: 'high',
    });

    expect(plan).toEqual({
      reasoning: 'Create a generated component.',
      tasks: [
        {
          intent: 'create',
          subject: 'new_component',
          targetNodeId: undefined,
          referenceNodeId: undefined,
          relationToReference: 'none',
          componentCategory: 'time_based',
          componentArchetype: 'pomodoro_timer',
          userVisibleGoal: 'Create a Pomodoro timer component.',
          behavioralRequirements: ['configurable focus duration', 'start pause reset', 'focus and rest phases'],
          visualRequirements: ['clear countdown display'],
          acceptanceCriteria: ['User can start, pause, and reset the timer.'],
          needsImage: false,
          imageTarget: 'none',
          imagePrompt: undefined,
          requiresGeneratedCode: true,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        },
      ],
      confidence: 'high',
    });
  });

  it('adapts snake_case and legacy component_type fields without prompt semantic inference', () => {
    const plan = normalizeWorkflowPlan({
      reasoning: 'Create a Pomodoro timer.',
      confidence: 'medium',
      tasks: [
        {
          intent: 'create',
          subject: 'new_component',
          target_node_id: null,
          reference_node_id: null,
          relation_to_reference: 'none',
          component_category: 'time_based',
          component_type: 'pomodoro_timer',
          user_visible_goal: 'Create a Pomodoro timer.',
          behavioral_requirements: ['start pause reset'],
          visual_requirements: ['readable countdown'],
          acceptance_criteria: ['Timer has focus and rest phases.'],
          needs_image: false,
          image_target: 'none',
          image_prompt: null,
          requires_generated_code: true,
          should_edit_existing_image: false,
          should_rewrite_component_code: true,
        },
      ],
    });

    expect(plan.tasks[0]).toMatchObject({
      componentCategory: 'time_based',
      componentArchetype: 'pomodoro_timer',
      needsImage: false,
      imageTarget: 'none',
      requiresGeneratedCode: true,
    });
  });

  it('rejects semantic-incomplete legacy planner output instead of guessing from the prompt', () => {
    expect(() =>
      normalizeWorkflowPlan(
        {
          action: 'create_component',
          target: 'new_component',
          component_type: 'pomodoro_timer',
          reasoning: 'The user wants a Pomodoro timer component.',
        },
        '帮我创建一个番茄钟组件',
      ),
    ).toThrow(/Required/);
  });

  it('preserves referenceNodeId separately from targetNodeId for layout references', () => {
    const pageState = createInitialPageState();
    pageState.root.children.push({
      id: 'table-3x3',
      type: 'generated_react_component',
      props: {
        name: 'SimpleTable',
        componentMeta: {
          category: 'data',
          archetype: '3x3_table',
        },
      },
      styleTokens: {},
      children: [],
    });

    const plan = normalizeWorkflowPlan(
      {
        reasoning: 'Create a Pomodoro timer near the table.',
        tasks: [
          pomodoroTask({
            targetNodeId: null,
            referenceNodeId: 'table-3x3',
            relationToReference: 'near',
            userVisibleGoal: 'Create a Pomodoro timer beside the existing table.',
          }),
        ],
        confidence: 'high',
      },
      '创建一个番茄钟，挨着刚刚创建的表格',
      { pageState },
    );

    expect(plan.tasks[0]).toMatchObject({
      componentCategory: 'time_based',
      componentArchetype: 'pomodoro_timer',
      targetNodeId: undefined,
      referenceNodeId: 'table-3x3',
      relationToReference: 'near',
    });
  });

  it('rejects invalid target or reference node ids', () => {
    expect(() =>
      normalizeWorkflowPlan(
        {
          reasoning: 'Update a component.',
          tasks: [
            pomodoroTask({
              intent: 'update',
              subject: 'existing_component',
              targetNodeId: 'missing-node',
            }),
          ],
          confidence: 'high',
        },
        '番茄钟不像番茄钟，修改下',
        { pageState: createInitialPageState() },
      ),
    ).toThrow(/invalid targetNodeId/);
  });

  it('rejects system overlay controls as layout reference nodes', async () => {
    const provider = createTextProviderReturning(
      {
        reasoning: 'Create a table below the prompt.',
        tasks: [
          pomodoroTask({
            componentCategory: 'data',
            componentArchetype: '3x3_todo_table',
            referenceNodeId: 'system-prompt',
            relationToReference: 'below',
            userVisibleGoal: 'Create a 3x3 todo table.',
          }),
        ],
        confidence: 'high',
      },
      {
        reasoning: 'Create a table as page content.',
        tasks: [
          pomodoroTask({
            componentCategory: 'data',
            componentArchetype: '3x3_todo_table',
            referenceNodeId: null,
            relationToReference: 'none',
            userVisibleGoal: 'Create a 3x3 todo table.',
          }),
        ],
        confidence: 'high',
      },
    );

    const plan = await generateWorkflowPlan(provider, '创建一个3x3表格组件', createInitialPageState(), '');

    expect(provider.createToolTurn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(provider.createToolTurn.mock.calls[1]?.[0]?.messages)).toContain('system control');
    expect(plan.tasks[0]).toMatchObject({
      componentArchetype: '3x3_todo_table',
      referenceNodeId: undefined,
      relationToReference: 'none',
    });
  });

  it('builds planner requests with component inventory and retries incomplete planner output', async () => {
    const provider = createTextProviderReturning(
      {
        action: 'create_component',
        target: 'new_component',
        component_type: 'pomodoro_timer',
        reasoning: 'Missing required semantic fields.',
      },
      {
        reasoning: 'Create a Pomodoro timer.',
        tasks: [pomodoroTask()],
        confidence: 'high',
      },
    );

    const plan = await generateWorkflowPlan(provider, '帮我创建一个番茄钟组件', createInitialPageState(), '');

    expect(provider.createToolTurn).toHaveBeenCalledTimes(2);
    const firstCallText = provider.createToolTurn.mock.calls[0]?.[0]?.messages?.[1]?.content ?? '';
    expect(firstCallText).toContain('Component inventory from list_components');
    expect(plan.tasks[0]).toMatchObject({
      intent: 'create',
      subject: 'new_component',
      componentCategory: 'time_based',
      componentArchetype: 'pomodoro_timer',
      needsImage: false,
      shouldRewriteComponentCode: true,
    });
  });
});
