import { createWorker } from 'tesseract.js';
import path from 'path';

const IMG = '/private/tmp/claude-501/-Users-tusharmahajan-Ai-Ally-Medical-Vault/4c8d9934-1efc-44ec-a1ff-d2a194cad582/scratchpad/test-huge-scan.png';
const CURRENT_DIR = path.resolve('.');
const FAST_DIR = '/private/tmp/claude-501/-Users-tusharmahajan-Ai-Ally-Medical-Vault/4c8d9934-1efc-44ec-a1ff-d2a194cad582/scratchpad/tessdata_fast';

async function bench(label, langPath, langs) {
  const t0 = Date.now();
  const worker = await createWorker(langs, undefined, { langPath, cachePath: langPath });
  const initMs = Date.now() - t0;
  const t1 = Date.now();
  const { data: { text } } = await worker.recognize(IMG);
  const recognizeMs = Date.now() - t1;
  await worker.terminate();
  console.log(`${label}: init=${initMs}ms recognize=${recognizeMs}ms total=${initMs+recognizeMs}ms textLen=${text.trim().length}`);
}

await bench('CURRENT eng+hin (huge img)', CURRENT_DIR, 'eng+hin');
await bench('FAST    eng+hin (huge img)', FAST_DIR, 'eng+hin');
await bench('FAST    eng-only (huge img)', FAST_DIR, 'eng');
process.exit(0);
