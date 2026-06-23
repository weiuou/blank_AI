import vm from 'node:vm';
import { defaultTheme } from '../../src/shared/defaults';
import { applyPatchOperations, validatePatchOperations } from '../../src/shared/patches';
import type { AiMessageResponse, PageNode, PagePatchOperation, PageState } from '../../src/shared/types';
import { aiMessageResponseSchema } from '../../src/shared/types';
import type { PatchResponseDraft, WorkflowPlan, WorkflowTask } from './contracts';
import { currentRequestId, logWorkflow } from './logging';
import { getPatchValidationErrorMessage } from './outputFirewall';
import { findNodeById } from './tools';

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

function collectAddedNodes(node: PageNode, nodes: PageNode[] = []): PageNode[] {
  nodes.push(node);
  node.children.forEach((child) => collectAddedNodes(child, nodes));
  return nodes;
}

function getPatchNodeIds(patch: PagePatchOperation[]): Set<string> {
  const ids = new Set<string>();
  for (const operation of patch) {
    if (operation.type === 'add_node') {
      collectAddedNodes(operation.node).forEach((node) => ids.add(node.id));
    }
    if (operation.type === 'update_node' || operation.type === 'remove_node' || operation.type === 'move_node') {
      ids.add(operation.nodeId);
    }
  }
  return ids;
}

function nodeLooksLikeTable(node: PageNode): boolean {
  const haystack = [
    node.id,
    node.type,
    node.props.name,
    node.props.title,
    node.props.label,
    node.props.code,
    JSON.stringify(node.props.mountProps ?? {}),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return node.type === 'generated_react_component' && /table|grid|row|column|表格/.test(haystack);
}

function patchCreatesTableLikeComponent(patch: PagePatchOperation[]): boolean {
  return patch.some((operation) => operation.type === 'add_node' && collectAddedNodes(operation.node).some(nodeLooksLikeTable));
}

function getAddedGeneratedComponentNodes(patch: PagePatchOperation[]): PageNode[] {
  return patch.flatMap((operation) => (operation.type === 'add_node' ? collectGeneratedComponentNodes(operation.node) : []));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function objectHasKeys(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function patchCreatesGeneratedComponentWithTaskMeta(patch: PagePatchOperation[], task: WorkflowTask): boolean {
  return getAddedGeneratedComponentNodes(patch).some((node) => {
    const meta = asRecord(node.props.componentMeta);
    return meta.category === task.componentCategory && meta.archetype === task.componentArchetype;
  });
}

function patchTouchesPageBackground(patch: PagePatchOperation[], nextState: PageState): boolean {
  return patch.some((operation) => {
    if (operation.type === 'set_theme_tokens') {
      return true;
    }
    if (operation.type === 'add_node') {
      return collectAddedNodes(operation.node).some((node) => node.type === 'image_background');
    }
    if (operation.type === 'update_node') {
      const node = findNodeById(nextState.root, operation.nodeId);
      return node?.type === 'image_background';
    }
    return false;
  });
}

function operationHasSubstantiveNodeChange(operation: PagePatchOperation, nodeId: string): boolean {
  if (operation.type === 'move_node') {
    return operation.nodeId === nodeId;
  }
  if (operation.type === 'update_node') {
    return (
      operation.nodeId === nodeId &&
      (objectHasKeys(operation.props) || objectHasKeys(operation.styleTokens) || objectHasKeys(operation.behavior))
    );
  }
  if (operation.type === 'add_node') {
    return collectAddedNodes(operation.node).some((node) => node.id === nodeId);
  }
  return false;
}

function styleString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).toLowerCase() : '';
}

function nodeHasLayoutContainerStyle(node?: PageNode): boolean {
  if (!node) {
    return false;
  }
  const style = asRecord(node.styleTokens);
  const props = asRecord(node.props);
  const display = styleString(style.display);
  const gridTemplateColumns = styleString(style.gridTemplateColumns);
  const flexDirection = styleString(style.flexDirection);
  const layout = styleString(props.layout);
  const hasGrid = display.includes('grid') && (gridTemplateColumns.includes('fr') || gridTemplateColumns.includes('minmax') || gridTemplateColumns.includes('repeat'));
  const hasFlexRow = display.includes('flex') && !flexDirection.includes('column');
  const hasColumnsComponent = node.type === 'columns' && Number(props.columns ?? 0) >= 2;
  return hasGrid || hasFlexRow || hasColumnsComponent || layout === 'columns';
}

function nodeHasDirectionalPositionStyle(node?: PageNode, direction?: 'left' | 'right' | 'top' | 'bottom'): boolean {
  if (!node || !direction) {
    return false;
  }
  const style = asRecord(node.styleTokens);
  const position = styleString(style.position);
  const justifySelf = styleString(style.justifySelf);
  const alignSelf = styleString(style.alignSelf);
  const width = styleString(style.width);
  const maxWidth = styleString(style.maxWidth);
  if (direction === 'left') {
    return style.left !== undefined || justifySelf.includes('start') || position === 'absolute' || position === 'fixed' || width.includes('50');
  }
  if (direction === 'right') {
    return style.right !== undefined || justifySelf.includes('end') || position === 'absolute' || position === 'fixed' || width.includes('50');
  }
  if (direction === 'top') {
    return style.top !== undefined || alignSelf.includes('start') || position === 'absolute' || position === 'fixed';
  }
  if (direction === 'bottom') {
    return style.bottom !== undefined || alignSelf.includes('end') || position === 'absolute' || position === 'fixed';
  }
  return maxWidth.length > 0;
}

function desiredDirection(task: WorkflowTask): 'left' | 'right' | 'top' | 'bottom' | undefined {
  const text = [
    task.relationToReference,
    task.userVisibleGoal,
    ...task.visualRequirements,
    ...task.acceptanceCriteria,
  ]
    .join(' ')
    .toLowerCase();
  if (/\bleft\b|left_of|左侧|左边|左方|放.*左|移.*左|置于.*左|位于.*左/.test(text)) {
    return 'left';
  }
  if (/\bright\b|right_of|右侧|右边|右方|放.*右|移.*右|置于.*右|位于.*右/.test(text)) {
    return 'right';
  }
  if (/\btop\b|above|上方|上面|顶部|放.*上|移.*上|置于.*上|位于.*上/.test(text)) {
    return 'top';
  }
  if (/\bbottom\b|below|下方|下面|底部|放.*下|移.*下|置于.*下|位于.*下/.test(text)) {
    return 'bottom';
  }
  return undefined;
}

function taskMentionsNoOverlap(task: WorkflowTask): boolean {
  return [
    task.userVisibleGoal,
    ...task.visualRequirements,
    ...task.acceptanceCriteria,
  ]
    .join(' ')
    .toLowerCase()
    .match(/\b(no overlap|without overlap|avoid overlap|not overlap)\b|不遮挡|不要.*遮挡|互不遮挡/) !== null;
}

function patchAddsOrUpdatesLayoutContainer(patch: PagePatchOperation[], nextState: PageState): boolean {
  return patch.some((operation) => {
    if (operation.type === 'add_node') {
      return collectAddedNodes(operation.node).some(nodeHasLayoutContainerStyle);
    }
    if (operation.type === 'update_node') {
      const node = findNodeById(nextState.root, operation.nodeId);
      return nodeHasLayoutContainerStyle(node);
    }
    return false;
  });
}

function assertMultiComponentNoOverlapLayout(nextState: PageState, patch: PagePatchOperation[], tasks: WorkflowTask[]): void {
  const directionalTasks = tasks.filter((task) => task.subject === 'existing_component' && task.targetNodeId && desiredDirection(task));
  if (directionalTasks.length < 2 || !directionalTasks.some(taskMentionsNoOverlap)) {
    return;
  }

  const directions = new Set(directionalTasks.map((task) => desiredDirection(task)));
  const requiresTwoAxisSeparation =
    (directions.has('left') && directions.has('right')) || (directions.has('top') && directions.has('bottom'));
  if (!requiresTwoAxisSeparation || patchAddsOrUpdatesLayoutContainer(patch, nextState)) {
    return;
  }

  throw new Error(
    'Plan requires multiple components to be arranged without overlap, but patch does not create or update a real grid/flex/columns layout container.',
  );
}

function taskHasReferenceLayoutRelation(task: WorkflowTask): boolean {
  return Boolean(task.referenceNodeId && task.relationToReference !== 'none' && task.relationToReference !== 'inside');
}

function collectMoveOperations(patch: PagePatchOperation[]): PagePatchOperation[] {
  return patch.filter((operation) => operation.type === 'move_node');
}

function patchProvidesReferenceLayoutEvidence(
  pageState: PageState,
  nextState: PageState,
  patch: PagePatchOperation[],
  task: WorkflowTask,
): boolean {
  if (!task.referenceNodeId || !taskHasReferenceLayoutRelation(task)) {
    return true;
  }

  const addedGeneratedNodes = getAddedGeneratedComponentNodes(patch);
  const matchingAddedNodes = addedGeneratedNodes.filter((node) => {
    const meta = asRecord(node.props.componentMeta);
    return meta.category === task.componentCategory && meta.archetype === task.componentArchetype;
  });
  if (matchingAddedNodes.length === 0) {
    return false;
  }

  const relation = task.relationToReference;
  const sameParentEvidence = matchingAddedNodes.some((node) => {
    const newNodeParentId = parentIdOfNode(nextState.root, node.id);
    const referenceParentId = parentIdOfNode(nextState.root, task.referenceNodeId!);
    if (!newNodeParentId || newNodeParentId !== referenceParentId) {
      return false;
    }
    const parent = findNodeById(nextState.root, newNodeParentId);
    return nodeHasLayoutContainerStyle(parent);
  });
  if (sameParentEvidence) {
    return true;
  }

  const moves = collectMoveOperations(patch);
  const movesNewAndReferenceTogether = matchingAddedNodes.some((node) =>
    moves.some((operation) => operation.type === 'move_node' && operation.nodeId === node.id) &&
    moves.some((operation) => operation.type === 'move_node' && operation.nodeId === task.referenceNodeId),
  );
  if (movesNewAndReferenceTogether && patchAddsOrUpdatesLayoutContainer(patch, nextState)) {
    return true;
  }

  const direction = desiredDirection(task);
  const positionEvidence = matchingAddedNodes.some((node) => {
    if (nodeHasDirectionalPositionStyle(node, direction)) {
      return true;
    }
    const previousParentId = parentIdOfNode(pageState.root, node.id);
    const nextParentId = parentIdOfNode(nextState.root, node.id);
    const nextParent = nextParentId ? findNodeById(nextState.root, nextParentId) : undefined;
    return previousParentId !== nextParentId && nodeHasLayoutContainerStyle(nextParent);
  });
  if (positionEvidence && (relation === 'near' || relation === 'same_position' || relation === 'custom')) {
    return true;
  }

  return false;
}

function parentIdOfNode(node: PageNode, nodeId: string, parentId?: string): string | undefined {
  for (const child of node.children) {
    if (child.id === nodeId) {
      return parentId ?? node.id;
    }
    const match = parentIdOfNode(child, nodeId, child.id);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function patchProvidesDirectionalLayoutEvidence(pageState: PageState, nextState: PageState, patch: PagePatchOperation[], task: WorkflowTask): boolean {
  if (!task.targetNodeId) {
    return false;
  }
  const direction = desiredDirection(task);
  if (!direction) {
    return true;
  }
  const nextNode = findNodeById(nextState.root, task.targetNodeId);
  if (nodeHasDirectionalPositionStyle(nextNode, direction)) {
    return true;
  }
  const previousParentId = parentIdOfNode(pageState.root, task.targetNodeId);
  const nextParentId = parentIdOfNode(nextState.root, task.targetNodeId);
  const nextParent = nextParentId ? findNodeById(nextState.root, nextParentId) : undefined;
  const parentChanged = previousParentId !== undefined && nextParentId !== undefined && previousParentId !== nextParentId;
  const parentTouched = patch.some(
    (operation) =>
      nextParentId &&
      ((operation.type === 'add_node' && collectAddedNodes(operation.node).some((node) => node.id === nextParentId)) ||
        (operation.type === 'update_node' && operation.nodeId === nextParentId && objectHasKeys(operation.styleTokens))),
  );
  return (parentChanged || parentTouched) && nodeHasLayoutContainerStyle(nextParent);
}

function patchSubstantivelyTouchesNode(patch: PagePatchOperation[], nodeId: string): boolean {
  return patch.some((operation) => operationHasSubstantiveNodeChange(operation, nodeId));
}

function taskRequiresSubstantiveLayoutChange(task: WorkflowTask): boolean {
  const text = [
    task.intent,
    task.relationToReference,
    task.userVisibleGoal,
    ...task.behavioralRequirements,
    ...task.visualRequirements,
    ...task.acceptanceCriteria,
  ]
    .join(' ')
    .toLowerCase();
  return (
    task.intent === 'move' ||
    task.relationToReference !== 'none' ||
    /\b(left|right|top|bottom|above|below|near|position|layout|align|overlap|side by side)\b|左|右|上|下|并排|布局|位置|遮挡/.test(text)
  );
}

function assertPatchSatisfiesWorkflowPlan(pageState: PageState, nextState: PageState, patch: PagePatchOperation[], plan?: WorkflowPlan): void {
  if (!plan) {
    return;
  }

  const requestId = currentRequestId();
  logWorkflow(requestId, 'patch_contract_check', {
    tool: 'patch_contract_check',
    taskCount: plan.tasks.length,
    tasks: plan.tasks.map((task) => ({
      intent: task.intent,
      subject: task.subject,
      componentCategory: task.componentCategory,
      componentArchetype: task.componentArchetype,
      targetNodeId: task.targetNodeId ?? null,
      referenceNodeId: task.referenceNodeId ?? null,
    })),
  });

  try {
    const touchedIds = getPatchNodeIds(patch);
    const taskTargetIds = new Set(plan.tasks.map((task) => task.targetNodeId).filter((id): id is string => Boolean(id)));

    assertMultiComponentNoOverlapLayout(nextState, patch, plan.tasks);

    for (const task of plan.tasks) {
      if (task.intent === 'answer_only') {
        if (patch.length > 0) {
          throw new Error('Plan task is answer_only but patch changes the page.');
        }
        continue;
      }

      if (task.intent === 'create' && task.subject === 'new_component') {
        if (!patchCreatesGeneratedComponentWithTaskMeta(patch, task)) {
          throw new Error(
            `Plan requires creating ${task.componentArchetype} with componentMeta, but patch did not add a matching generated component.`,
          );
        }
        if (!patchProvidesReferenceLayoutEvidence(pageState, nextState, patch, task)) {
          throw new Error(
            `Plan requires creating ${task.componentArchetype} ${task.relationToReference} ${task.referenceNodeId}, but patch does not create or update a real grid/flex/columns layout container that positions the new component with its reference.`,
          );
        }
      }

      if (
        task.intent === 'create' &&
        task.subject === 'new_component' &&
        task.componentArchetype.toLowerCase().includes('table') &&
        !patchCreatesTableLikeComponent(patch)
      ) {
        throw new Error('Plan requires creating a table component, but patch did not add a table-like generated component.');
      }

      if (task.subject === 'page_background') {
        if (!patchTouchesPageBackground(patch, nextState)) {
          throw new Error('Plan targets page background, but patch did not update page background.');
        }
        if (patch.some((operation) => operation.type === 'add_node' && collectAddedNodes(operation.node).some((node) => node.type === 'generated_react_component'))) {
          throw new Error('Plan targets page background, but patch added a generated component.');
        }
      }

      if (task.imageTarget === 'component') {
        if (!task.targetNodeId && task.subject === 'existing_component') {
          throw new Error('Plan targets a component image update but has no resolved target node.');
        }
        if (patch.some((operation) => operation.type === 'add_node' && collectAddedNodes(operation.node).some((node) => node.type === 'image_background'))) {
          throw new Error('Plan targets component background, but patch added a page image background.');
        }
        if (patch.some((operation) => operation.type === 'set_theme_tokens')) {
          throw new Error('Plan targets component background, but patch updates page theme/background tokens.');
        }
        if (task.targetNodeId && !touchedIds.has(task.targetNodeId)) {
          throw new Error(`Plan targets component ${task.targetNodeId}, but patch does not touch it.`);
        }
      }

      if (task.subject === 'existing_component' && task.targetNodeId && !touchedIds.has(task.targetNodeId)) {
        throw new Error(`Plan targets existing component ${task.targetNodeId}, but patch does not touch it.`);
      }

      if (
        task.subject === 'existing_component' &&
        task.targetNodeId &&
        taskRequiresSubstantiveLayoutChange(task) &&
        !patchSubstantivelyTouchesNode(patch, task.targetNodeId)
      ) {
        throw new Error(`Plan requires a substantive layout change for ${task.targetNodeId}, but patch only touched it without props, styleTokens, behavior, or move_node.`);
      }

      if (
        task.subject === 'existing_component' &&
        task.targetNodeId &&
        taskRequiresSubstantiveLayoutChange(task) &&
        desiredDirection(task) &&
        !patchProvidesDirectionalLayoutEvidence(pageState, nextState, patch, task)
      ) {
        throw new Error(
          `Plan requires directional layout for ${task.targetNodeId}, but patch does not provide target positioning or a real grid/flex/columns layout container.`,
        );
      }

      if (
        task.referenceNodeId &&
        touchedIds.has(task.referenceNodeId) &&
        !taskTargetIds.has(task.referenceNodeId) &&
        !patch.some((operation) => operation.type === 'move_node' && operation.nodeId === task.referenceNodeId)
      ) {
        throw new Error(`Plan uses ${task.referenceNodeId} as reference only, but patch touches it.`);
      }

      if (task.intent === 'repair' && patch.some((operation) => operation.type === 'move_node')) {
        throw new Error('Plan is repair, but patch moves a component.');
      }
    }

    if (plan.tasks.some((task) => task.intent === 'repair') && patch.some((operation) => operation.type === 'move_node')) {
      throw new Error('Plan is repair, but patch moves a component.');
    }

    for (const id of touchedIds) {
      const previousNode = findNodeById(pageState.root, id);
      if (previousNode?.type === 'system_prompt' && !plan.tasks.some((task) => task.subject === 'system_prompt' && task.targetNodeId === id)) {
        throw new Error('Patch touches system prompt, but plan does not target system_prompt.');
      }
      if (previousNode?.type === 'system_timeline' && !plan.tasks.some((task) => task.subject === 'system_timeline' && task.targetNodeId === id)) {
        throw new Error('Patch touches system timeline, but plan does not target system_timeline.');
      }
    }

    logWorkflow(requestId, 'patch_contract_check', {
      tool: 'patch_contract_check',
      ok: true,
    });
  } catch (error) {
    logWorkflow(requestId, 'patch_contract_check', {
      tool: 'patch_contract_check',
      ok: false,
      error: getPatchValidationErrorMessage(error),
    });
    throw error;
  }
}

const reservedRuntimeBindings = [
  'React',
  'props',
  'theme',
  'system',
  'sdk',
  'createElement',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
];

const reservedRuntimeBindingSet = new Set(reservedRuntimeBindings);
const reservedRuntimeBindingPattern = new RegExp(`\\b(${reservedRuntimeBindings.join('|')})\\b`);

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_$]/.test(char));
}

function isIdentifierPart(char: string | undefined): boolean {
  return Boolean(char && /[\w$]/.test(char));
}

function skipWhitespace(source: string, index: number): number {
  let next = index;
  while (/\s/.test(source[next] ?? '')) {
    next += 1;
  }
  return next;
}

function readIdentifier(source: string, index: number): { name: string; end: number } | null {
  if (!isIdentifierStart(source[index])) {
    return null;
  }
  let end = index + 1;
  while (isIdentifierPart(source[end])) {
    end += 1;
  }
  return { name: source.slice(index, end), end };
}

function readBalancedText(source: string, start: number, open: string, close: string): { text: string; end: number } {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
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
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return { text: source.slice(start, index + 1), end: index + 1 };
      }
    }
  }

  return { text: source.slice(start), end: source.length };
}

function findNextDeclaratorBoundary(source: string, start: number): { end: number; hasMore: boolean } {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
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
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      if (char === ',') {
        return { end: index, hasMore: true };
      }
      if (char === ';') {
        return { end: index, hasMore: false };
      }
    }
  }

  return { end: source.length, hasMore: false };
}

function findTopLevelReservedBindingIssue(code: string): string | null {
  let curlyDepth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];

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
      curlyDepth += 1;
      continue;
    }
    if (char === '}') {
      curlyDepth = Math.max(0, curlyDepth - 1);
      continue;
    }
    if (curlyDepth !== 0 || !isIdentifierStart(char)) {
      continue;
    }

    const word = readIdentifier(code, index);
    if (!word) {
      continue;
    }

    if (word.name === 'function' || word.name === 'class') {
      let nameStart = skipWhitespace(code, word.end);
      if (word.name === 'function' && code[nameStart] === '*') {
        nameStart = skipWhitespace(code, nameStart + 1);
      }
      const name = readIdentifier(code, nameStart);
      if (name && reservedRuntimeBindingSet.has(name.name)) {
        return `reserved runtime/helper ${word.name} declaration (${name.name})`;
      }
      index = word.end - 1;
      continue;
    }

    if (word.name === 'const' || word.name === 'let' || word.name === 'var') {
      let cursor = skipWhitespace(code, word.end);
      while (cursor < code.length) {
        const bindingStart = skipWhitespace(code, cursor);
        const bindingChar = code[bindingStart];
        let bindingEnd = bindingStart;
        if (bindingChar === '{' || bindingChar === '[') {
          const balanced = readBalancedText(code, bindingStart, bindingChar, bindingChar === '{' ? '}' : ']');
          const match = reservedRuntimeBindingPattern.exec(balanced.text);
          if (match) {
            return `reserved runtime/helper ${bindingChar === '{' ? 'destructuring' : 'array destructuring'} declaration (${match[1]})`;
          }
          bindingEnd = balanced.end;
        } else {
          const binding = readIdentifier(code, bindingStart);
          if (!binding) {
            break;
          }
          if (reservedRuntimeBindingSet.has(binding.name)) {
            return `reserved runtime/helper redeclaration (${binding.name})`;
          }
          bindingEnd = binding.end;
        }

        const boundary = findNextDeclaratorBoundary(code, bindingEnd);
        cursor = boundary.end + 1;
        if (!boundary.hasMore) {
          index = boundary.end;
          break;
        }
      }
      continue;
    }

    if (reservedRuntimeBindingSet.has(word.name)) {
      const assignmentStart = skipWhitespace(code, word.end);
      if (code[assignmentStart] === '=' && code[assignmentStart + 1] !== '=' && code[assignmentStart - 1] !== '.') {
        return `reserved runtime/helper reassignment (${word.name})`;
      }
    }

    index = word.end - 1;
  }

  return null;
}

function assertGeneratedComponentCodeIsSafe(nodeId: string, code: string): void {
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bimport\b/, 'import'],
    [/\bexport\b/, 'export'],
    [/\bdocument\b/, 'document'],
    [/\bwindow\b/, 'window'],
    [/\bglobalThis\b/, 'globalThis'],
    [/\bself\b/, 'self'],
    [/\bparent\b/, 'parent'],
    [/\bframes\b/, 'frames'],
    [/\blocation\b/, 'location'],
    [/\bnavigator\b/, 'navigator'],
    [/\bhistory\b/, 'history'],
    [/\bwindow\s*\.\s*parent\b/, 'window.parent'],
    [/\bwindow\s*\.\s*top\b/, 'window.top'],
    [/(?:^|[^\w$.])top\s*(?:[.[(]|$)/, 'top'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bsessionStorage\b/, 'sessionStorage'],
    [/\bcookie\b/, 'cookie'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bEventSource\b/, 'EventSource'],
    [/\beval\s*\(/, 'eval'],
    [/\bFunction\s*\(/, 'Function'],
  ];

  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(code)) {
      throw new Error(`Generated component ${nodeId} code uses forbidden API: ${label}.`);
    }
  }

  const reservedBindingIssue = findTopLevelReservedBindingIssue(code);
  if (reservedBindingIssue) {
    throw new Error(`Generated component ${nodeId} code shadows reserved runtime binding: ${reservedBindingIssue}.`);
  }
}

function createSmokeTestReactRuntime() {
  return {
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
      return {
        type,
        props: props && typeof props === 'object' ? props : {},
        children,
      };
    },
    useState(initialValue: unknown) {
      return [typeof initialValue === 'function' ? (initialValue as () => unknown)() : initialValue, () => undefined];
    },
    useEffect() {
      return undefined;
    },
    useMemo(factory: () => unknown) {
      return typeof factory === 'function' ? factory() : undefined;
    },
    useCallback(callback: unknown) {
      return callback;
    },
    useRef(initialValue: unknown) {
      return { current: initialValue };
    },
  };
}

type SmokeTestReactRuntime = ReturnType<typeof createSmokeTestReactRuntime>;
const generatedRuntimeBindings = [
  'React',
  'props',
  'theme',
  'system',
  'sdk',
  'createElement',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'useRef',
] as const;

function createGeneratedComponentFunctionBody(code: string): string {
  return `"use strict";\n${code}`;
}

function formatCompileError(error: unknown, code: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? String(error.stack ?? '') : '';
  const match = /generated-component\.js:(\d+)(?::(\d+))?/.exec(stack);
  if (!match) {
    return message;
  }

  const compiledLine = Number(match[1]);
  const compiledColumn = match[2] ? Number(match[2]) : undefined;
  const codeLine = Math.max(1, compiledLine - 1);
  const lines = code.split('\n');
  const start = Math.max(1, codeLine - 2);
  const end = Math.min(lines.length, codeLine + 2);
  const snippet = [];
  for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
    const prefix = lineNumber === codeLine ? '>' : ' ';
    snippet.push(`${prefix} ${lineNumber}: ${lines[lineNumber - 1] ?? ''}`);
    if (lineNumber === codeLine && compiledColumn && Number.isFinite(compiledColumn)) {
      snippet.push(`  ${' '.repeat(Math.max(0, String(lineNumber).length + compiledColumn + 1))}^`);
    }
  }

  return `${message} near generated code line ${codeLine}${compiledColumn ? `, column ${compiledColumn}` : ''}:\n${snippet.join('\n')}`;
}

function compileGeneratedComponentCode(code: string): void {
  const body = createGeneratedComponentFunctionBody(code);
  const wrapped = `(function(${generatedRuntimeBindings.join(',')}) {\n${body}\n})`;
  try {
    new vm.Script(wrapped, { filename: 'generated-component.js' });
  } catch (error) {
    throw new Error(formatCompileError(error, code));
  }
}

function assertRenderableSmokeValue(nodeId: string, value: unknown, depth = 0): void {
  if (depth > 20) {
    throw new Error(`Generated component ${nodeId} returned a render tree that is too deeply nested.`);
  }

  if (value === null || value === undefined || typeof value === 'boolean') {
    throw new Error(`Generated component ${nodeId} code must return a React element or renderable value at top level.`);
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(`Generated component ${nodeId} code returned an empty array; return a visible React element at top level.`);
    }
    value.forEach((child) => assertRenderableSmokeValue(nodeId, child, depth + 1));
    return;
  }

  if (typeof value !== 'object') {
    throw new Error(`Generated component ${nodeId} returned an unsupported value. Return a React element at top level.`);
  }

  const element = value as { type?: unknown; props?: unknown; children?: unknown };
  if (typeof element.type !== 'string' && typeof element.type !== 'function') {
    throw new Error(`Generated component ${nodeId} returned an invalid React element. Return React.createElement(...) at top level.`);
  }

  if (typeof element.type === 'function') {
    const props = element.props && typeof element.props === 'object' ? element.props : {};
    const children = Array.isArray(element.children) ? element.children : [];
    assertRenderableSmokeValue(nodeId, element.type({ ...props, children }), depth + 1);
  }
}

function assertGeneratedComponentCodeRenders(node: PageNode): void {
  const code = node.props.code;
  if (typeof code !== 'string') {
    throw new Error(`Generated component ${node.id} is missing code.`);
  }

  const factory = new Function(...generatedRuntimeBindings, createGeneratedComponentFunctionBody(code));
  const reactRuntime: SmokeTestReactRuntime = createSmokeTestReactRuntime();
  const result = factory(
    reactRuntime,
    node.props.mountProps && typeof node.props.mountProps === 'object' ? node.props.mountProps : {},
    defaultTheme,
    { snapshots: [], activeSnapshotId: null },
    {},
    reactRuntime.createElement,
    reactRuntime.useState,
    reactRuntime.useEffect,
    reactRuntime.useMemo,
    reactRuntime.useCallback,
    reactRuntime.useRef,
  );
  assertRenderableSmokeValue(node.id, result);
}

function assertGeneratedComponentCodeCompiles(node: PageNode): void {
  if (node.type !== 'generated_react_component') {
    return;
  }

  const requestId = currentRequestId();
  logWorkflow(requestId, 'code_safety_check', {
    tool: 'code_safety_check',
    nodeId: node.id,
  });
  const code = node.props.code;
  if (typeof code !== 'string' || code.trim() === '') {
    logWorkflow(requestId, 'code_safety_check', {
      tool: 'code_safety_check',
      ok: false,
      nodeId: node.id,
      error: `Generated component ${node.id} is missing code.`,
    });
    throw new Error(`Generated component ${node.id} is missing code.`);
  }

  let stage: 'safety' | 'compile' | 'render' = 'safety';
  try {
    assertGeneratedComponentCodeIsSafe(node.id, code);
    stage = 'compile';
    compileGeneratedComponentCode(code);
    stage = 'render';
    assertGeneratedComponentCodeRenders(node);
    logWorkflow(requestId, 'code_safety_check', {
      tool: 'code_safety_check',
      ok: true,
      nodeId: node.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefixedMessage =
      stage === 'safety'
        ? message
        : stage === 'compile'
          ? `Generated component ${node.id} code does not compile: ${message}`
          : message.startsWith(`Generated component ${node.id}`)
            ? message
            : `Generated component ${node.id} code failed render smoke test: ${message}`;
    logWorkflow(requestId, 'code_safety_check', {
      tool: 'code_safety_check',
      ok: false,
      nodeId: node.id,
      error: prefixedMessage,
    });
    throw new Error(prefixedMessage);
  }
}

export function assertPatchCanBeApplied(pageState: PageState, patch: PagePatchOperation[]): PageState {
  const requestId = currentRequestId();
  const startedAt = Date.now();
  logWorkflow(requestId, 'dry_run_patch', {
    tool: 'dry_run_patch',
    patchCount: patch.length,
  });
  try {
    const nextState = applyPatchOperations(pageState, validatePatchOperations(patch));
    const touchedGeneratedIds = collectTouchedGeneratedComponentIds(patch, nextState);
    for (const nodeId of touchedGeneratedIds) {
      const node = findNodeById(nextState.root, nodeId);
      if (node) {
        assertGeneratedComponentCodeCompiles(node);
      }
    }
    logWorkflow(requestId, 'dry_run_patch', {
      tool: 'dry_run_patch',
      ok: true,
      durationMs: Date.now() - startedAt,
      patchCount: patch.length,
    });
    return nextState;
  } catch (error) {
    logWorkflow(requestId, 'dry_run_patch', {
      tool: 'dry_run_patch',
      ok: false,
      durationMs: Date.now() - startedAt,
      patchCount: patch.length,
      error: getPatchValidationErrorMessage(error),
    });
    throw error;
  }
}

export function parseModelPatch(rawPatch: unknown): PagePatchOperation[] {
  return validatePatchOperations(rawPatch);
}

export function parseAndPreflightPatchResponse(pageState: PageState, draft: PatchResponseDraft, plan?: WorkflowPlan): AiMessageResponse {
  let patch: PagePatchOperation[];
  try {
    patch = parseModelPatch(draft.patch);
    const nextState = assertPatchCanBeApplied(pageState, patch);
    assertPatchSatisfiesWorkflowPlan(pageState, nextState, patch, plan);
  } catch (error) {
    throw new Error(`AI returned an invalid page patch: ${getPatchValidationErrorMessage(error)}`);
  }

  return aiMessageResponseSchema.parse({
    assistantText: draft.assistantText,
    changeSummary: draft.changeSummary,
    patch,
  });
}

export function preflightAiMessageResponse(pageState: PageState, response: AiMessageResponse, plan?: WorkflowPlan): AiMessageResponse {
  const patch = response.patch;
  const nextState = assertPatchCanBeApplied(pageState, patch);
  assertPatchSatisfiesWorkflowPlan(pageState, nextState, patch, plan);
  const normalizedResponse = {
    ...response,
    patch,
  };
  return aiMessageResponseSchema.parse(normalizedResponse);
}
