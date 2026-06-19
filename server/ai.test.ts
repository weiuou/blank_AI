import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialPageState } from '../src/shared/defaults';
import type { PageState } from '../src/shared/types';

const responsesCreateMock = vi.fn();

vi.mock('openai', () => {
  class MockOpenAI {
    responses = {
      create: responsesCreateMock,
    };
  }

  return {
    default: MockOpenAI,
  };
});

describe('generateAssistantResponse image continuity', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://cpa.weiuou.art/v1';
    process.env.OPENAI_IMAGE_MODEL = 'gpt-image-2';
    process.env.OPENAI_IMAGE_SIZE = '1536x1024';
    process.env.USE_AI_MOCK = 'false';
    global.fetch = originalFetch;
  });

  function mockImageFetch(base64 = Buffer.from('generated image').toString('base64')) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ data: [{ b64_json: base64 }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('edits an existing image background instead of adding a replacement', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user wants to edit the existing page image background.',
          target: 'page_background',
          targetNodeId: null,
          needsImage: true,
          imagePrompt: 'Add a minecraft icon into the current background',
          shouldEditExistingImage: true,
          shouldRewriteComponentCode: false,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I edited the existing background.',
          changeSummary: 'Edited page background image.',
          patchJson: JSON.stringify([
            {
              type: 'update_node',
              nodeId: 'generated-image-background',
              props: {
                src: `data:image/png;base64,${Buffer.from('edited background').toString('base64')}`,
                alt: 'AI edited page background',
              },
            },
          ]),
        }),
      });
    const fetchMock = mockImageFetch(Buffer.from('edited background').toString('base64'));

    const { generateAssistantResponse } = await import('./ai');
    const pageState: PageState = createInitialPageState();
    pageState.root.children.push({
      id: 'generated-image-background',
      type: 'image_background',
      props: {
        src: `data:image/png;base64,${Buffer.from('original background').toString('base64')}`,
        alt: 'AI generated page background',
      },
      styleTokens: {},
      children: [],
    });

    const response = await generateAssistantResponse('在中间加一个minecraft图标', pageState, []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://cpa.weiuou.art/v1/images/edits');
    const editBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(editBody).toBeInstanceOf(FormData);
    expect((editBody as FormData).get('model')).toBe('gpt-image-2');
    expect((editBody as FormData).get('background')).toBe('opaque');
    expect((editBody as FormData).get('output_format')).toBe('png');
    expect(response.patch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'update_node',
          nodeId: 'generated-image-background',
          props: expect.objectContaining({
            alt: 'AI edited page background',
            src: expect.stringMatching(/^data:image\/png;base64,/),
          }),
        }),
      ]),
    );
    expect(response.patch.some((operation) => operation.type === 'add_node')).toBe(false);
  });

  it('generates an image and applies it to an existing generated table component', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user wants a generated image as the table background.',
          target: 'component',
          targetNodeId: 'table-1',
          needsImage: true,
          imagePrompt: 'Subtle abstract texture for a table background',
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockRejectedValueOnce(new Error('finalizer unavailable'));
    const fetchMock = mockImageFetch(Buffer.from('table background').toString('base64'));

    const { generateAssistantResponse } = await import('./ai');
    const pageState: PageState = createInitialPageState();
    pageState.root.children.unshift({
      id: 'table-1',
      type: 'generated_react_component',
      props: {
        name: 'SimpleTable',
        code: "return React.createElement('table', null)",
        mountProps: {
          title: '数据表格',
          columns: ['姓名', '部门'],
          rows: [['张伟', '产品']],
        },
        capabilities: [],
      },
      styleTokens: {
        width: '100%',
        minHeight: '320px',
      },
      children: [],
    });

    const response = await generateAssistantResponse('修改表格的背景，希望生成一个图作为表格背景', pageState, []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://cpa.weiuou.art/v1/images/generations');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-image-2',
      size: '1536x1024',
      output_format: 'png',
    });
    expect(response.patch).toHaveLength(1);
    expect(response.patch[0]).toMatchObject({
      type: 'update_node',
      nodeId: 'table-1',
    });
    const operation = response.patch[0];
    expect(operation.type === 'update_node' ? operation.props?.mountProps : undefined).toEqual(
      expect.objectContaining({
        backgroundImage: expect.stringMatching(/^data:image\/png;base64,/),
      }),
    );
    expect(JSON.stringify(response.patch)).not.toContain('image_background');
  });

  it('does not send generated image base64 into the final text model request', async () => {
    const imageBase64 = Buffer.from('large generated image payload').toString('base64');
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user wants to create a new table with a generated background image.',
          target: 'component',
          targetNodeId: null,
          needsImage: true,
          imagePrompt: 'Pokemon themed background image for a 3 by 3 table',
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I created a Pokemon themed table.',
          changeSummary: 'Created a generated table with an image background.',
          patchJson: JSON.stringify([
            {
              type: 'add_node',
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'pokemon-table',
                type: 'generated_react_component',
                props: {
                  name: 'PokemonTable',
                  capabilities: [],
                  mountProps: {
                    title: 'Pokemon table',
                    backgroundImage: '__workflow_image_1__',
                  },
                  code:
                    "const e = React.createElement;\nreturn e('section', { style: { minHeight: 320, backgroundImage: props.backgroundImage ? `url(${props.backgroundImage})` : undefined } }, props.title);",
                },
                styleTokens: {
                  width: 'min(860px, calc(100vw - 56px))',
                  minHeight: '360px',
                },
                children: [],
              },
            },
          ]),
        }),
      });
    mockImageFetch(imageBase64);

    const { generateAssistantResponse } = await import('./ai');
    const pageState: PageState = createInitialPageState();

    const response = await generateAssistantResponse('帮我创建一个宝可梦主题背景的3×3表格，背景请生成一张图片', pageState, []);

    const finalizerInput = responsesCreateMock.mock.calls[1]?.[0]?.input?.[1]?.content?.[0]?.text ?? '';
    expect(finalizerInput).toContain('__workflow_image_1__');
    expect(finalizerInput).not.toContain(imageBase64);
    expect(JSON.stringify(response.patch)).toContain(`data:image/png;base64,${imageBase64}`);
    expect(JSON.stringify(response.patch)).not.toContain('__workflow_image_1__');
  });

  it('normalizes legacy op patch output from the finalizer', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user wants to create a new table with a generated background image.',
          target: 'component',
          targetNodeId: null,
          needsImage: true,
          imagePrompt: 'Pokemon themed background image for a 3 by 3 table',
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I created a Pokemon themed table.',
          changeSummary: 'Created a generated table with an image background.',
          patchJson: JSON.stringify([
            {
              op: 'add_node',
              parentId: 'root',
              index: 0,
              node: {
                id: 'legacy-pokemon-table',
                type: 'generated_react_component',
                props: {
                  name: 'PokemonTable',
                  capabilities: [],
                  mountProps: {
                    title: 'Pokemon table',
                    backgroundImage: '__workflow_image_1__',
                  },
                  code: "const e = React.createElement;\nreturn e('section', null, props.title);",
                },
                styleTokens: {
                  width: 'min(860px, calc(100vw - 56px))',
                  minHeight: '360px',
                },
                children: [],
              },
            },
          ]),
        }),
      });
    mockImageFetch(Buffer.from('legacy output image').toString('base64'));

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('帮我创建一个宝可梦主题背景的3×3表格，背景请生成一张图片', createInitialPageState(), []);

    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      target: { parentId: 'root', index: 0 },
    });
    expect(JSON.stringify(response.patch)).toContain('data:image/png;base64,');
  });

  it('falls back to a safe generated table when finalizer output is invalid after image generation', async () => {
    const imageBase64 = Buffer.from('fallback table image').toString('base64');
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user wants to create a new table with a generated background image.',
          target: 'component',
          targetNodeId: null,
          needsImage: true,
          imagePrompt: 'Pokemon themed background image for a 3 by 3 table',
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'Invalid patch',
          changeSummary: 'Invalid patch',
          patchJson: JSON.stringify([{ op: 'unknown' }]),
        }),
      });
    mockImageFetch(imageBase64);

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('帮我创建一个宝可梦主题背景的3×3表格，背景请生成一张图片', createInitialPageState(), []);

    expect(response.patch).toHaveLength(1);
    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      node: expect.objectContaining({
        type: 'generated_react_component',
      }),
    });
    expect(JSON.stringify(response.patch)).toContain(`data:image/png;base64,${imageBase64}`);
  });

  it('falls back to a safe timer component when direct component generation returns an invalid patch', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user wants a timer component and no image is needed.',
          target: 'component',
          targetNodeId: null,
          needsImage: false,
          imagePrompt: null,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'Invalid timer patch',
          changeSummary: 'Invalid timer patch',
          patchJson: JSON.stringify([{ op: 'unknown_timer' }]),
        }),
      });

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个计时器组件，放在屏幕下半部分', createInitialPageState(), []);

    expect(response.patch).toHaveLength(1);
    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      node: expect.objectContaining({
        type: 'generated_react_component',
        props: expect.objectContaining({
          name: 'TimerWidget',
        }),
      }),
    });
    expect(JSON.stringify(response.patch)).toContain('React.useState');
  });

  it('keeps generated component layout stable when the user only asks to repair it', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user says the timer is unusable, so repair the existing component without moving it.',
          target: 'component',
          targetNodeId: 'timer-1',
          needsImage: false,
          imagePrompt: null,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I repaired the timer interactions.',
          changeSummary: 'Repaired timer component code.',
          patchJson: JSON.stringify([
            {
              type: 'update_node',
              nodeId: 'timer-1',
              props: {
                code: "const e = React.createElement;\nreturn e('button', { type: 'button' }, 'Fixed timer');",
                mountProps: {
                  title: '修复后的计时器',
                  layout: { position: 'bottom' },
                  placement: 'bottom',
                },
              },
              styleTokens: {
                width: 'min(900px, calc(100vw - 56px))',
                minHeight: '420px',
                padding: '10vh 0 0',
              },
            },
            {
              type: 'move_node',
              nodeId: 'timer-1',
              target: { parentId: 'root', index: 0 },
            },
          ]),
        }),
      });

    const { generateAssistantResponse } = await import('./ai');
    const pageState: PageState = createInitialPageState();
    pageState.root.children.unshift({
      id: 'timer-1',
      type: 'generated_react_component',
      props: {
        name: 'TimerWidget',
        code: "const e = React.createElement;\nreturn e('button', { type: 'button' }, 'Timer');",
        mountProps: {
          title: '计时器',
          layout: { position: 'lower-half' },
          placement: 'lower-half',
        },
        capabilities: [],
      },
      styleTokens: {
        width: 'min(620px, calc(100vw - 56px))',
        minHeight: '280px',
        padding: '52vh 0 0',
      },
      children: [],
    });

    const response = await generateAssistantResponse('这个组件用不了啊', pageState, []);

    expect(response.patch).toHaveLength(1);
    expect(response.patch[0]).toMatchObject({
      type: 'update_node',
      nodeId: 'timer-1',
      styleTokens: {
        width: 'min(620px, calc(100vw - 56px))',
        minHeight: '280px',
        padding: '52vh 0 0',
      },
      props: {
        code: expect.stringContaining('Fixed timer'),
        mountProps: {
          title: '修复后的计时器',
          layout: { position: 'lower-half' },
          placement: 'lower-half',
        },
      },
    });
    expect(response.patch.some((operation) => operation.type === 'move_node')).toBe(false);
  });

  it('allows generated component layout changes when the user explicitly asks to move it', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user explicitly asks to move the timer component.',
          target: 'component',
          targetNodeId: 'timer-1',
          needsImage: false,
          imagePrompt: null,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: false,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I moved the timer lower.',
          changeSummary: 'Moved timer component to the bottom area.',
          patchJson: JSON.stringify([
            {
              type: 'update_node',
              nodeId: 'timer-1',
              styleTokens: {
                width: 'min(900px, calc(100vw - 56px))',
                minHeight: '420px',
                padding: '62vh 0 0',
              },
            },
          ]),
        }),
      });

    const { generateAssistantResponse } = await import('./ai');
    const pageState: PageState = createInitialPageState();
    pageState.root.children.unshift({
      id: 'timer-1',
      type: 'generated_react_component',
      props: {
        name: 'TimerWidget',
        code: "const e = React.createElement;\nreturn e('button', { type: 'button' }, 'Timer');",
        mountProps: {},
        capabilities: [],
      },
      styleTokens: {
        width: 'min(620px, calc(100vw - 56px))',
        minHeight: '280px',
        padding: '52vh 0 0',
      },
      children: [],
    });

    const response = await generateAssistantResponse('把这个组件移动到底部', pageState, []);

    expect(response.patch[0]).toMatchObject({
      type: 'update_node',
      nodeId: 'timer-1',
      styleTokens: {
        width: 'min(900px, calc(100vw - 56px))',
        minHeight: '420px',
        padding: '62vh 0 0',
      },
    });
  });

  it('accepts model-generated positioned calendar components', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user asks for a new calendar in the top-left corner.',
          target: 'component',
          targetNodeId: null,
          needsImage: false,
          imagePrompt: null,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I created a June 2026 calendar.',
          changeSummary: 'Added a positioned calendar component.',
          patchJson: JSON.stringify([
            {
              type: 'add_node',
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'calendar-2026-06',
                type: 'generated_react_component',
                props: {
                  name: 'CalendarJune2026',
                  mountProps: { year: 2026, month: 6 },
                  capabilities: [],
                  code:
                    "const e = React.createElement;\nreturn e('section', { style: { padding: 16, borderRadius: 24, background: 'rgba(255,255,255,0.7)' } }, 'June 2026');",
                },
                styleTokens: {
                  position: 'fixed',
                  top: '24px',
                  left: '24px',
                  width: 'min(360px, calc(100vw - 48px))',
                  minHeight: '320px',
                  zIndex: '10',
                },
                children: [],
              },
            },
          ]),
        }),
      });

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个日历组件，放在窗口左上角，默认显示2026年6月日历', createInitialPageState(), []);

    expect(response.patch).toHaveLength(1);
    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      node: {
        id: 'calendar-2026-06',
        type: 'generated_react_component',
        styleTokens: {
          position: 'fixed',
          top: '24px',
          left: '24px',
          zIndex: 10,
        },
      },
    });
  });

  it('repairs generated component syntax before returning a patch', async () => {
    responsesCreateMock
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          reasoning: 'The user wants a generated widget and no image is needed.',
          target: 'component',
          targetNodeId: null,
          needsImage: false,
          imagePrompt: null,
          shouldEditExistingImage: false,
          shouldRewriteComponentCode: true,
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I created a widget.',
          changeSummary: 'Added widget.',
          patchJson: JSON.stringify([
            {
              type: 'add_node',
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'broken-widget',
                type: 'generated_react_component',
                props: {
                  name: 'BrokenWidget',
                  mountProps: {},
                  capabilities: [],
                  code: "const e = React.createElement;\nreturn e('section', null, 'Broken widget'",
                },
                styleTokens: {
                  width: '320px',
                  minHeight: '160px',
                },
                children: [],
              },
            },
          ]),
        }),
      })
      .mockResolvedValueOnce({
        output_text: JSON.stringify({
          assistantText: 'I created a widget.',
          changeSummary: 'Added repaired widget.',
          patchJson: JSON.stringify([
            {
              type: 'add_node',
              target: { parentId: 'root', index: 0 },
              node: {
                id: 'broken-widget',
                type: 'generated_react_component',
                props: {
                  name: 'BrokenWidget',
                  mountProps: {},
                  capabilities: [],
                  code: "const e = React.createElement;\nreturn e('section', null, 'Repaired widget');",
                },
                styleTokens: {
                  width: '320px',
                  minHeight: '160px',
                },
                children: [],
              },
            },
          ]),
        }),
      });

    const { generateAssistantResponse } = await import('./ai');
    const response = await generateAssistantResponse('创建一个小组件', createInitialPageState(), []);

    expect(responsesCreateMock).toHaveBeenCalledTimes(3);
    expect(response.patch[0]).toMatchObject({
      type: 'add_node',
      node: {
        id: 'broken-widget',
        props: {
          code: expect.stringContaining('Repaired widget'),
        },
      },
    });
  });

  it('returns a readable error without patching when image generation fails', async () => {
    responsesCreateMock.mockResolvedValueOnce({
      output_text: JSON.stringify({
        reasoning: 'The user wants a generated image as a component background.',
        target: 'component',
        targetNodeId: 'table-1',
        needsImage: true,
        imagePrompt: 'Subtle table background',
        shouldEditExistingImage: false,
        shouldRewriteComponentCode: true,
      }),
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));

    const { generateAssistantResponse } = await import('./ai');
    const pageState: PageState = createInitialPageState();
    pageState.root.children.unshift({
      id: 'table-1',
      type: 'generated_react_component',
      props: {
        name: 'SimpleTable',
        code: "return React.createElement('table', null)",
        mountProps: {},
        capabilities: [],
      },
      styleTokens: {},
      children: [],
    });

    const response = await generateAssistantResponse('修改表格的背景，希望生成一个图作为表格背景', pageState, []);

    expect(response.patch).toHaveLength(0);
    expect(response.error).toContain('502 status code');
    expect(response.assistantText).toContain('图片生成失败');
  });
});
