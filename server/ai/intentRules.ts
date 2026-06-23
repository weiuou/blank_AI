type KeywordRule = {
  any: string[];
  all?: string[][];
};

const includesAny = (text: string, terms: string[]): boolean => terms.some((term) => text.includes(term));

const matchesRule = (text: string, rule: KeywordRule): boolean =>
  includesAny(text, rule.any) && (!rule.all || rule.all.every((group) => includesAny(text, group)));

function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase();
}

const mockIntentRules = {
  graffitiBackground: {
    any: ['graffiti', 'street', '涂鸦', '街头'],
  },
  generatedComponent: {
    any: ['component', 'widget', 'react', '组件', '生成一个', '做一个'],
  },
  promptMovedBottom: {
    any: ['input', '输入框'],
    all: [['bottom', '下方', '底部']],
  },
  timelineLeft: {
    any: ['timeline', '时间轴'],
    all: [['left', '左侧', '左边']],
  },
} satisfies Record<string, KeywordRule>;

const fallbackIntentRules = {
  timerComponent: {
    any: ['timer', 'pomodoro', 'countdown', 'stopwatch', '计时器', '番茄钟', '倒计时', '秒表'],
  },
  tableComponent: {
    any: ['table', '表格', '3x3', '3×3'],
  },
} satisfies Record<string, KeywordRule>;

export function inferMockAccent(prompt: string): { accent: string; accentSoft: string } {
  const normalized = normalizePrompt(prompt);
  if (includesAny(normalized, ['ocean', 'blue'])) {
    return { accent: '#0057ff', accentSoft: '#e9f0ff' };
  }
  if (includesAny(normalized, ['warm', 'orange', 'sunset'])) {
    return { accent: '#c45a1e', accentSoft: '#fff1e8' };
  }
  if (includesAny(normalized, ['green', 'nature'])) {
    return { accent: '#1c7c54', accentSoft: '#eaf8ef' };
  }
  return { accent: '#111111', accentSoft: '#ececec' };
}

export function extractMockGraffitiWord(prompt: string): string {
  const quotedMatch = prompt.match(/[“"']([^”"']{1,24})[”"']/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }
  const asciiMatch = prompt.match(/\b[A-Za-z][A-Za-z0-9_-]{1,23}\b/);
  return asciiMatch?.[0] ?? 'Weiuou';
}

export function isMockGraffitiBackgroundRequest(prompt: string): boolean {
  return matchesRule(normalizePrompt(prompt), mockIntentRules.graffitiBackground);
}

export function isMockGeneratedComponentRequest(prompt: string): boolean {
  return matchesRule(normalizePrompt(prompt), mockIntentRules.generatedComponent);
}

export function isMockPromptMoveBottomRequest(prompt: string): boolean {
  return matchesRule(normalizePrompt(prompt), mockIntentRules.promptMovedBottom);
}

export function isMockTimelineMoveLeftRequest(prompt: string): boolean {
  return matchesRule(normalizePrompt(prompt), mockIntentRules.timelineLeft);
}

export function isTimerComponentFallback(prompt: string): boolean {
  return matchesRule(normalizePrompt(prompt), fallbackIntentRules.timerComponent);
}

export function isTableComponentFallback(prompt: string): boolean {
  return matchesRule(normalizePrompt(prompt), fallbackIntentRules.tableComponent);
}
