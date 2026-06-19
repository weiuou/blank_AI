import dotenv from 'dotenv';
import { createApp } from './app';
import { getActiveLogPath, logLine } from './logger';

dotenv.config({ override: true });

const port = Number(process.env.PORT ?? 8787);
const app = createApp();

app.listen(port, () => {
  logLine(`Blank AI server listening on http://localhost:${port}`);
  logLine(`Blank AI log file: ${getActiveLogPath()}`);
  logLine(
    `[ai:config] baseUrl=${process.env.OPENAI_BASE_URL ?? '<default>'} textModel=${process.env.OPENAI_MODEL ?? '<default>'} imageModel=${
      process.env.OPENAI_IMAGE_MODEL ?? '<default>'
    } imageSize=${process.env.OPENAI_IMAGE_SIZE ?? '<default>'} imageTimeoutMs=${process.env.OPENAI_IMAGE_TIMEOUT_MS ?? '<default>'}`,
  );
});
