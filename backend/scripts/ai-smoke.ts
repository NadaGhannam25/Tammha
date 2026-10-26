/**
 * REAL Gemini smoke test (P13):  npm run ai:smoke  [-- --handbook path/to/handbook.pdf]
 *
 * Uses AI_ENABLED / AI_PROVIDER=gemini / GEMINI_API_KEY / GEMINI_MODEL from the project's .env
 * and the same adapter, prompt rules, JSON schema and validator as the API.
 *
 * SAFETY
 * - Sends ONE request with a SYNTHETIC project (no data from your database is read or sent).
 * - With --handbook, the PDF is read locally and only the selected excerpts are sent.
 * - Never prints the API key. Exit codes: 0 = passed, 1 = failed, 2 = NOT RUN.
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { readIntegrationsConfig } from '../src/integrations/integrations.config';
import { GeminiAiTextProvider } from '../src/integrations/ai/gemini-ai.provider';
import { AiProviderError } from '../src/integrations/ai/ai.provider';
import { AI_FEATURES } from '../src/modules/ai-support/features/ai-features';
import {
  buildPrompt,
  SYSTEM_INSTRUCTION,
} from '../src/modules/ai-support/features/prompt-builder';
import {
  GUIDANCE_RESPONSE_SCHEMA,
  parseGuidance,
} from '../src/modules/ai-support/guidance/guidance.schema';
import {
  chunkHandbook,
  HandbookExcerpt,
  selectExcerpts,
} from '../src/modules/ai-support/handbook/handbook-retrieval';
import { extractPdfText } from '../src/modules/ai-support/handbook/handbook-text';
import type { ProjectContext } from '../src/modules/ai-support/context/project-context.service';

loadEnv({ path: resolve(__dirname, '..', '.env') });

const { config, errors } = readIntegrationsConfig(process.env);
const ai = config.ai;
if (
  !ai.enabled ||
  ai.provider !== 'gemini' ||
  errors.some((e) => /^(AI_|GEMINI_)/.test(e))
) {
  console.log(
    '\nNOT RUN: real Gemini was NOT tested.\n' +
      (errors.length
        ? `  Problems (variable names only):\n  - ${errors.join('\n  - ')}\n`
        : '') +
      '  Set AI_ENABLED=true, AI_PROVIDER=gemini, GEMINI_API_KEY and GEMINI_MODEL in your local .env,\n' +
      '  then run: npm run ai:smoke\n',
  );
  process.exit(2);
}

const SAMPLE_HANDBOOK =
  '3. Final Report Requirements\nThe final report must follow the official template and must not exceed 80 pages. ' +
  'References use the IEEE citation style.\f5. Evaluation\nProposal 10 percent, progress 20 percent, report 40 percent, presentation 30 percent.';

const context: ProjectContext = {
  requesterRole: 'student',
  project: {
    name: 'Smoke Test Project',
    description: 'A synthetic project used only to test the AI connection.',
    status: 'IN_PROGRESS',
    startDate: '2026-09-01',
    endDate: '2027-05-30',
  },
  team: { studentCount: 3, hasSupervisor: true },
  progress: {
    percent: 35,
    readinessScore: 40,
    readinessLevel: 'IN_PROGRESS',
    missing: ['Upload: REPORT'],
  },
  tasks: {
    total: 4,
    completed: 1,
    open: 3,
    overdue: 1,
    openItems: [
      {
        title: 'Write methodology chapter',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        dueDate: '2026-11-01',
        overdue: false,
        milestone: 'Draft report',
      },
    ],
  },
  milestones: [
    {
      title: 'Draft report',
      status: 'PENDING',
      dueDate: '2026-12-15',
      overdue: false,
      totalTasks: 3,
      completedTasks: 1,
      focus: false,
    },
  ],
  documents: [
    { title: 'Proposal', category: 'PROPOSAL', reviewStatus: 'APPROVED' },
  ],
  requiredDocuments: [{ category: 'REPORT', status: 'MISSING' }],
  feedback: [],
};

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
  if (!ok) failures++;
}

async function main() {
  const flag = process.argv.indexOf('--handbook');
  let handbookText = SAMPLE_HANDBOOK;
  if (flag > 0 && process.argv[flag + 1]) {
    const extracted = await extractPdfText(
      readFileSync(resolve(process.cwd(), process.argv[flag + 1])),
    );
    check(
      'local handbook PDF extracted',
      extracted.text.length > 200,
      `${extracted.pageCount} pages`,
    );
    handbookText = extracted.text;
  }
  const question = 'What must the final report contain and how long can it be?';
  const excerpts: HandbookExcerpt[] = selectExcerpts(
    chunkHandbook(handbookText),
    question,
    {
      maxChars: 8000,
      maxExcerpts: 8,
    },
  );
  check(
    'relevant handbook excerpts selected',
    excerpts.length > 0,
    `${excerpts.length} excerpt(s)`,
  );

  const provider = new GeminiAiTextProvider(
    ai as Extract<typeof ai, { enabled: true }>,
  );
  console.log(`\nGemini smoke test — model ${provider.model}\n`);
  const started = Date.now();
  try {
    const out = await provider.generateText({
      system: SYSTEM_INSTRUCTION,
      prompt: buildPrompt({
        feature: AI_FEATURES.HANDBOOK_GUIDANCE!,
        context,
        excerpts,
        handbookTitle: 'Smoke test handbook',
        question,
        language: 'en',
        today: new Date(),
      }),
      maxOutputTokens: 4096,
      responseSchema: GUIDANCE_RESPONSE_SCHEMA as unknown as Record<
        string,
        unknown
      >,
    });
    check(
      'Gemini answered',
      true,
      `${Date.now() - started} ms, tokens in/out ${out.usage?.inputTokens ?? '?'}/${out.usage?.outputTokens ?? '?'}`,
    );
    const guidance = parseGuidance(out.text, excerpts);
    check('answer is valid structured guidance', !!guidance.summary);
    check(
      'answer cites the handbook excerpts',
      guidance.handbookReferences.length > 0,
      `${guidance.handbookReferences.length} reference(s)`,
    );
    console.log(`\nSummary: ${guidance.summary.slice(0, 300)}\n`);
  } catch (error) {
    const code =
      error instanceof AiProviderError ? error.code : (error as Error).name;
    check('Gemini request', false, code);
    if (code === 'AI_PROVIDER_REJECTED') {
      console.log(
        '  -> check GEMINI_API_KEY and GEMINI_MODEL (exact model ID) in your .env',
      );
    }
  }
}

main()
  .catch((e: Error) => check('unexpected error', false, e.name))
  .finally(() => {
    console.log(
      failures === 0
        ? 'RESULT: real Gemini smoke test PASSED\n'
        : `RESULT: ${failures} check(s) FAILED\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
