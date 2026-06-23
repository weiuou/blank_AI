import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';

function userNodes(children: Array<{ type: string; props?: Record<string, unknown> }>) {
  return children.filter((node) => !node.type.startsWith('system_'));
}

describe('server app', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.USE_AI_MOCK;
  });

  it('starts a session and accepts a prompt', async () => {
    const app = createApp();
    const start = await request(app).post('/api/session/start').expect(200);
    expect(start.body.sessionId).toBeTruthy();

    const sessionId = start.body.sessionId as string;
    const response = await request(app)
      .post('/api/session/message')
      .send({
        sessionId,
        prompt: 'Create a calm portfolio hero',
      })
      .expect(200);

    expect(userNodes(response.body.pageState.root.children).length).toBeGreaterThan(0);
    expect(response.body.messages.some((message: { role: string }) => message.role === 'assistant')).toBe(true);
  });

  it('supports undo and redo after a prompt', async () => {
    const app = createApp();
    const start = await request(app).post('/api/session/start').expect(200);
    const sessionId = start.body.sessionId as string;

    await request(app)
      .post('/api/session/message')
      .send({
        sessionId,
        prompt: 'Make a travel layout',
      })
      .expect(200);

    const undo = await request(app).post('/api/session/undo').send({ sessionId }).expect(200);
    expect(userNodes(undo.body.pageState.root.children)).toHaveLength(0);

    const redo = await request(app).post('/api/session/redo').send({ sessionId }).expect(200);
    expect(userNodes(redo.body.pageState.root.children).length).toBeGreaterThan(0);
  });

  it('switches to a previous timeline snapshot', async () => {
    const app = createApp();
    const start = await request(app).post('/api/session/start').expect(200);
    const sessionId = start.body.sessionId as string;
    expect(start.body.snapshots).toHaveLength(1);

    const generated = await request(app)
      .post('/api/session/message')
      .send({
        sessionId,
        prompt: 'Make a travel layout',
      })
      .expect(200);

    expect(generated.body.snapshots).toHaveLength(2);
    expect(userNodes(generated.body.pageState.root.children).length).toBeGreaterThan(0);

    const jump = await request(app)
      .post('/api/session/jump')
      .send({ sessionId, snapshotId: generated.body.snapshots[0].id })
      .expect(200);

    expect(jump.body.activeSnapshotId).toBe(generated.body.snapshots[0].id);
    expect(userNodes(jump.body.pageState.root.children)).toHaveLength(0);
  });

  it('creates a graffiti background from a graffiti prompt', async () => {
    const app = createApp();
    const start = await request(app).post('/api/session/start').expect(200);
    const sessionId = start.body.sessionId as string;

    const response = await request(app)
      .post('/api/session/message')
      .send({
        sessionId,
        prompt: '帮我在这个页面的背景加上“Weiuou”6个字母，街头涂鸦风格',
      })
      .expect(200);

    const graffiti = userNodes(response.body.pageState.root.children)[0];
    expect(graffiti.type).toBe('graffiti_word');
    expect(graffiti.props?.text).toBe('Weiuou');
  });

  it('does not commit messages or snapshots when AI generation fails', async () => {
    process.env.USE_AI_MOCK = 'false';
    process.env.MINIMAX_API_KEY = 'test-key';
    process.env.MINIMAX_BASE_URL = 'https://api.minimaxi.test/v1';
    process.env.LANGUAGE_MODEL = 'MiniMax-M3';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'upstream failed' }), { status: 500 })),
    );

    const app = createApp();
    const start = await request(app).post('/api/session/start').expect(200);
    const sessionId = start.body.sessionId as string;

    const failed = await request(app)
      .post('/api/session/message')
      .send({
        sessionId,
        prompt: 'Create a failing layout',
      })
      .expect(400);

    expect(failed.body).toMatchObject({
      error: expect.any(String),
      requestId: expect.any(String),
      retryable: true,
    });

    const undo = await request(app).post('/api/session/undo').send({ sessionId }).expect(400);
    expect(undo.body.error).toBe('Nothing to undo');

    const traces = await request(app).get('/api/debug/traces').expect(200);
    const trace = traces.body.traces.find((item: { requestId: string }) => item.requestId === failed.body.requestId);
    expect(trace).toMatchObject({
      requestId: failed.body.requestId,
      sessionId,
      status: 'error',
    });
  });
});
