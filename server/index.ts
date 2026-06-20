import dotenv from 'dotenv';
import { createApp } from './app';
import { getActiveLogPath, logLine } from './logger';

dotenv.config({ override: true });
dotenv.config({ path: '.env.local', override: true });

const port = Number(process.env.PORT ?? 8787);
const app = createApp();

app.listen(port, () => {
  logLine(`Blank AI server listening on http://localhost:${port}`);
  logLine(`Blank AI log file: ${getActiveLogPath()}`);
  logLine(`[ai:config] languageModel=${process.env.LANGUAGE_MODEL ?? '<default>'} imageModel=${process.env.IMAGE_MODEL ?? '<default>'}`);
});
