# Blank AI

An AI-driven blank canvas experience that starts as a pure white page with one centered input, then incrementally transforms into a controlled UI through structured patch operations.

## Stack

- React 19 + Vite + TypeScript
- Node + Express + TypeScript
- OpenAI-compatible Responses API through a configurable server-side proxy
- Vitest + Testing Library + Supertest

## Run locally

```bash
npm install
npm run dev
```

This starts:

- Frontend on `http://localhost:5173`
- API server on `http://localhost:8787`

## Environment

Create a `.env` file if you want real model responses:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_BASE_URL=https://cpa.weiuou.art/v1
OPENAI_MODEL=gpt-5
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1536x1024
OPENAI_IMAGE_QUALITY=medium
PORT=8787
```

`OPENAI_API_KEY` is required for local AI calls. Tests still use a deterministic local patch path so they do not need your key.

## Scripts

```bash
npm run dev
npm run build
npm run test
```

## Current behavior

- Initial screen is a white stage with one centered prompt
- After the first prompt, the background is rendered from a controlled component tree
- Strong visual background prompts call `gpt-image-2` and render the generated image behind the prompt
- The prompt stays centered while AI changes the page behind it
- `Ctrl+Z` / `Cmd+Z` undoes the last AI interaction
- The server validates patch operations before the client applies them
