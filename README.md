# Blank AI

An AI-driven blank canvas experience that starts as a pure white page with one centered input, then incrementally transforms into a controlled UI through structured patch operations.

## Stack

- React 19 + Vite + TypeScript
- Node + Express + TypeScript
- Native fetch-based model providers for text and image generation
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

Model selection lives in `.env.example`:

```bash
LANGUAGE_MODEL=MiniMax-M3
IMAGE_MODEL=gemini-3.1-flash-image
```

Keep private endpoints and keys in `.env.local`, which is ignored by git:

```bash
MINIMAX_API_KEY=...
GEMINI_IMAGE_BASE_URL=https://your-private-gemini-site/v1beta
GEMINI_IMAGE_API_KEY=...
```

The model config is just `LANGUAGE_MODEL` and `IMAGE_MODEL`; provider implementations resolve endpoints, authentication, request paths, and response parsing. `MiniMax-M3` posts to the MiniMax `/responses` endpoint, and `gemini-3.1-flash-image` posts to Gemini native `models/{model}:generateContent`.

## Scripts

```bash
npm run dev
npm run build
npm run test
```

## Current behavior

- Initial screen is a white stage with one centered prompt
- After the first prompt, the background is rendered from a controlled component tree
- Strong visual background prompts call `gemini-3.1-flash-image` and render the generated image behind the prompt
- The prompt stays centered while AI changes the page behind it
- `Ctrl+Z` / `Cmd+Z` undoes the last AI interaction
- The server validates patch operations before the client applies them
