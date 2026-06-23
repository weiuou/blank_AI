import {
  defaultGeminiImageBaseUrl,
  defaultImageModel,
  defaultImageTimeoutMs,
  defaultMiniMaxBaseUrl,
  defaultModel,
  defaultTextTimeoutMs,
  type NativeAssistantMessage,
  type NativeToolLoopMessage,
  type ImageModelClient,
  type TextModelClient,
} from './contracts';
import { currentRequestId, logWorkflow, shouldLogAiHttp } from './logging';
import { logEvent } from '../logger';

type MiniMaxChatProvider = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  path: '/chat/completions';
  provider: 'minimax-chat';
};

type GeminiNativeImageProvider = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  path: string;
  provider: 'gemini-native-image';
};

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlash(baseUrl);
  return trimmed.endsWith('/v1') || trimmed.endsWith('/v1beta') ? trimmed : `${trimmed}/v1`;
}

function normalizeGeminiBaseUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlash(baseUrl);
  return /\/v\d+(?:beta)?$/i.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
}

function getOptionalProviderApiKey(envNames: string[]): string | undefined {
  return envNames.map((name) => process.env[name]).find((value): value is string => typeof value === 'string' && value.length > 0);
}

function getTextModel(): string {
  return process.env.LANGUAGE_MODEL ?? defaultModel;
}

function getImageModel(): string {
  return process.env.IMAGE_MODEL ?? defaultImageModel;
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
    const requestId = currentRequestId();
    logEvent({
      event: 'ai.http.start',
      requestId,
      status: 'start',
      method,
      path,
      model,
    });

    try {
      const response = await fetch(url, init);
      logEvent({
        event: 'ai.http.end',
        requestId,
        status: response.ok ? 'success' : 'error',
        method,
        path,
        model,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent({
        event: 'ai.http.error',
        requestId,
        status: 'error',
        method,
        path,
        model,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      throw error;
    }
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label = 'AI request'): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const requestFetch = shouldLogAiHttp() ? createLoggedFetch() : fetch;

  try {
    return await requestFetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function textFromHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTextEndpointError(status: number, responseText: string): string {
  if (!responseText) {
    return `${status} status code (no body)`;
  }

  const cleaned = responseText.includes('<') ? textFromHtml(responseText) : responseText.replace(/\s+/g, ' ').trim();
  const preview = cleaned.slice(0, 240);
  return `${status} status code from text endpoint${preview ? `: ${preview}` : ''}`;
}

async function postChatCompletionsRequest(provider: MiniMaxChatProvider, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetchWithTimeout(
    `${provider.baseUrl}${provider.path}`,
    {
      method: 'POST',
      headers: withOptionalBearerAuth(
        {
          'Content-Type': 'application/json',
        },
        provider.apiKey,
      ),
      body: JSON.stringify(body),
    },
    defaultTextTimeoutMs,
    'Text model request',
  );
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(formatTextEndpointError(response.status, responseText));
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error('Chat endpoint returned non-JSON response.');
  }
}

function createMiniMaxChatProvider(model: string): MiniMaxChatProvider {
  return {
    apiKey: getOptionalProviderApiKey(['MINIMAX_API_KEY']),
    baseUrl: normalizeBaseUrl(process.env.MINIMAX_BASE_URL ?? defaultMiniMaxBaseUrl),
    model,
    path: '/chat/completions',
    provider: 'minimax-chat',
  };
}

export function createTextModelProvider(model = getTextModel()): TextModelClient {
  if (model !== 'MiniMax-M3' && !model.startsWith('MiniMax-')) {
    throw new Error(`Unsupported language model "${model}". Add a provider mapping in createTextModelProvider.`);
  }

  const chatProvider = createMiniMaxChatProvider(model);
  return {
    baseUrl: chatProvider.baseUrl,
    model: chatProvider.model,
    provider: chatProvider.provider,
    createToolTurn: async ({ messages, tools, workflowId, source }): Promise<NativeAssistantMessage> => {
      const response = await postChatCompletionsRequest(chatProvider, {
        model: chatProvider.model,
        messages: messages.map((message) => {
          if (message.role === 'tool') {
            return {
              role: 'tool',
              tool_call_id: message.tool_call_id,
              content: message.content,
            };
          }
          if (message.role === 'assistant') {
            return {
              role: 'assistant',
              content: message.content ?? '',
              ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
            };
          }
          return {
            role: message.role,
            content: message.content,
          };
        }),
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: 'required',
      });
      const parsed = response as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      const message = parsed.choices?.[0]?.message ?? {};
      logWorkflow(workflowId ?? 'noctx', 'tool_result', {
        tool: 'patch_tool_turn',
        ok: true,
        source,
        provider: chatProvider.provider,
      });
      return {
        content: message.content ?? null,
        tool_calls: Array.isArray(message.tool_calls)
          ? message.tool_calls
              .filter((call): call is { id: string; type: 'function'; function: { name: string; arguments: string } } => {
                return typeof call.id === 'string' && typeof call.function?.name === 'string' && typeof call.function?.arguments === 'string';
              })
              .map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              }))
          : [],
      };
    },
  };
}

function parseImageDataUrl(dataUrl: string): { base64: string; mimeType: string } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) {
    throw new Error('Existing image background is not an editable data URL.');
  }

  return {
    base64: match[2],
    mimeType: match[1] === 'image/jpg' ? 'image/jpeg' : match[1],
  };
}

function extractInlineImageDataUrl(parsed: unknown): string {
  const candidates = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) {
    throw new Error('Image model did not return candidates.');
  }

  for (const candidate of candidates) {
    const parts = (candidate as { content?: { parts?: unknown } }).content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }

    for (const part of parts) {
      const typedPart = part as {
        inlineData?: { data?: unknown; mimeType?: unknown };
        inline_data?: { data?: unknown; mime_type?: unknown };
      };
      const inlineData = typedPart.inlineData ?? typedPart.inline_data;
      const data = inlineData?.data;
      if (typeof data === 'string' && data.length > 0) {
        const mimeType =
          typeof typedPart.inlineData?.mimeType === 'string'
            ? typedPart.inlineData.mimeType
            : typeof typedPart.inline_data?.mime_type === 'string'
              ? typedPart.inline_data.mime_type
              : 'image/png';
        return `data:${mimeType};base64,${data}`;
      }
    }
  }

  throw new Error('Image model did not return inline image data.');
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

function logDirectImageRequest(event: 'start' | 'end' | 'error', data: Record<string, unknown>): void {
  if (!shouldLogAiHttp()) {
    return;
  }
  const requestId = currentRequestId();
  logEvent({
    event: `ai.http.image.${event}`,
    requestId,
    status: event === 'start' ? 'start' : event === 'error' ? 'error' : 'success',
    ...data,
  });
}

function createGeminiNativeImageProvider(model: string): GeminiNativeImageProvider {
  return {
    apiKey: getOptionalProviderApiKey(['GEMINI_IMAGE_API_KEY', 'GEMINI_API_KEY']),
    baseUrl: normalizeGeminiBaseUrl(process.env.GEMINI_IMAGE_BASE_URL ?? defaultGeminiImageBaseUrl),
    model,
    path: `/models/${model}:generateContent`,
    provider: 'gemini-native-image',
  };
}

function withOptionalBearerAuth(headers: Record<string, string>, apiKey?: string): Record<string, string> {
  return apiKey
    ? {
        ...headers,
        Authorization: `Bearer ${apiKey}`,
      }
    : headers;
}

function withOptionalGeminiApiKey(headers: Record<string, string>, apiKey?: string): Record<string, string> {
  return apiKey
    ? {
        ...headers,
        'x-goog-api-key': apiKey,
      }
    : headers;
}

function buildGeminiTextToImageBody(prompt: string): Record<string, unknown> {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ],
  };
}

function buildGeminiImageEditBody(prompt: string, currentImageDataUrl: string): Record<string, unknown> {
  const { base64, mimeType } = parseImageDataUrl(currentImageDataUrl);
  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64,
            },
          },
          {
            text: prompt,
          },
        ],
      },
    ],
  };
}

async function parseGeminiImageResponse(response: Response): Promise<string> {
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

  return extractInlineImageDataUrl(parsed);
}

async function postGeminiImageRequest(
  provider: GeminiNativeImageProvider,
  body: Record<string, unknown>,
  logBody: Record<string, unknown>,
): Promise<string> {
  const startedAt = Date.now();
  const timeoutMs = defaultImageTimeoutMs;
  logDirectImageRequest('start', {
    method: 'POST',
    path: provider.path,
    model: provider.model,
    provider: provider.provider,
    body: logBody,
  });
  try {
    const response = await fetchWithTimeout(
      `${provider.baseUrl}${provider.path}`,
      {
        method: 'POST',
        headers: withOptionalGeminiApiKey(
          {
            'Content-Type': 'application/json',
          },
          provider.apiKey,
        ),
        body: JSON.stringify(body),
      },
      timeoutMs,
      'Image model request',
    );
    logDirectImageRequest('end', {
      method: 'POST',
      path: provider.path,
      model: provider.model,
      provider: provider.provider,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return await parseGeminiImageResponse(response);
  } catch (error) {
    logDirectImageRequest('error', {
      method: 'POST',
      path: provider.path,
      model: provider.model,
      provider: provider.provider,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function generateImageBackgroundForProvider(provider: GeminiNativeImageProvider, imagePrompt: string): Promise<string> {
  return postGeminiImageRequest(provider, buildGeminiTextToImageBody(imagePrompt), {
    contents: [{ role: 'user', parts: [{ text: imagePrompt }] }],
  });
}

async function editImageBackgroundForProvider(
  provider: GeminiNativeImageProvider,
  imagePrompt: string,
  currentImageDataUrl: string,
): Promise<string> {
  const { mimeType } = parseImageDataUrl(currentImageDataUrl);
  return postGeminiImageRequest(provider, buildGeminiImageEditBody(imagePrompt, currentImageDataUrl), {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: `[image-data-url length=${currentImageDataUrl.length}]`,
            },
          },
          {
            text: imagePrompt,
          },
        ],
      },
    ],
  });
}

export function createImageModelProvider(model = getImageModel()): ImageModelClient {
  if (model !== 'gemini-3.1-flash-image' && !model.startsWith('gemini-')) {
    throw new Error(`Unsupported image model "${model}". Add a provider mapping in createImageModelProvider.`);
  }

  const provider = createGeminiNativeImageProvider(model);
  return {
    model: provider.model,
    provider: provider.provider,
    generateBackground: (prompt) => generateImageBackgroundForProvider(provider, prompt),
    editBackground: (prompt, currentImageDataUrl) => editImageBackgroundForProvider(provider, prompt, currentImageDataUrl),
  };
}
