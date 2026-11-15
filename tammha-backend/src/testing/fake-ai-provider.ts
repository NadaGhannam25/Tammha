import {
  AiTextProvider,
  AiTextRequest,
  AiTextResult,
} from '@/integrations/ai/ai.provider';

type Step =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; value: string }
  | { kind: 'error'; error: unknown };

/**
 * TEST-ONLY AI provider ("gemini" with a fake model). Records every request and answers
 * with valid guidance JSON by default (citing the first excerpt it was given).
 * Queue custom answers or errors with next*(); add a delay with `delayMs`.
 */
export class FakeAiTextProvider implements AiTextProvider {
  readonly name = 'gemini' as const;
  readonly model = 'fake-gemini-model';
  enabled = true;
  delayMs = 0;
  readonly requests: AiTextRequest[] = [];
  private queue: Step[] = [];

  isEnabled() {
    return this.enabled;
  }

  nextJson(value: unknown) {
    this.queue.push({ kind: 'json', value });
  }
  nextText(value: string) {
    this.queue.push({ kind: 'text', value });
  }
  nextError(error: unknown) {
    this.queue.push({ kind: 'error', error });
  }
  get lastPrompt(): string {
    return this.requests[this.requests.length - 1]?.prompt ?? '';
  }
  reset() {
    this.requests.length = 0;
    this.queue = [];
    this.delayMs = 0;
    this.enabled = true;
  }

  async generateText(request: AiTextRequest): Promise<AiTextResult> {
    this.requests.push(request);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const step = this.queue.shift();
    if (step?.kind === 'error') throw step.error;
    const text =
      step?.kind === 'text'
        ? step.value
        : JSON.stringify(
            step?.kind === 'json'
              ? step.value
              : request.prompt.startsWith('TASK: HANDBOOK SUMMARY')
                ? defaultSummary(request.prompt)
                : request.prompt.startsWith('TASK: HANDBOOK TASKS')
                  ? defaultHandbookTasks(request.prompt)
                  : defaultGuidance(request.prompt),
          );
    return {
      text,
      provider: 'gemini',
      model: this.model,
      finishReason: 'STOP',
      usage: { inputTokens: 1200, outputTokens: 300 },
    };
  }
}

export function defaultGuidance(prompt: string) {
  const firstExcerpt = /\[(H\d+)\]/.exec(prompt)?.[1];
  return {
    summary: 'Focus on the final report structure and the upcoming milestone.',
    answer: 'The final report must follow the official template.',
    recommendations: [
      {
        title: 'Use the official template',
        detail: 'Start the report from the template.',
        priority: 'HIGH',
      },
    ],
    nextSteps: [
      'Draft the methodology chapter',
      'Book a review with the supervisor',
    ],
    taskSuggestions: [
      {
        title: 'Write literature review',
        description: 'Summarise 10 sources.',
        estimatedDays: 5,
        milestone: 'Progress report',
      },
    ],
    milestoneSuggestions: [
      {
        title: 'Draft report',
        description: 'Complete chapters 1-3.',
        suggestedOrder: 1,
        suggestedDueDate: '2027-02-01',
      },
    ],
    handbookReferences: firstExcerpt
      ? [{ excerptId: firstExcerpt, note: 'Report requirements' }]
      : [],
    risks: ['Report longer than allowed'],
    confidence: 'MEDIUM',
  };
}

/** First page marker of a handbook prompt and the first words on it (a verifiable quote). */
function firstPageQuote(prompt: string) {
  const m = /\[Page (\d+)\]\n([^\n]+)/.exec(prompt);
  return {
    page: m ? Number(m[1]) : 1,
    quote: (m?.[2] ?? '').split(/\s+/).slice(0, 6).join(' '),
  };
}

/** A valid seven-topic summary: OVERVIEW found (quoting page 1), every other topic not found. */
export function defaultSummary(prompt: string) {
  const { page, quote } = firstPageQuote(prompt);
  return {
    topics: [
      {
        id: 'OVERVIEW',
        found: true,
        summary: 'This handbook explains the graduation project rules.',
        points: [
          {
            text: 'The handbook starts with its purpose.',
            pages: [page],
            quote,
          },
        ],
      },
      { id: 'GRADING', found: false, summary: '', points: [] },
    ],
  };
}

/** Two handbook tasks: one quoting the handbook, one with an invented quote (dropped). */
export function defaultHandbookTasks(prompt: string) {
  const { page, quote } = firstPageQuote(prompt);
  return {
    tasks: [
      {
        title: 'Prepare the project proposal',
        description: 'Follow the handbook rules.',
        priority: 'HIGH',
        estimatedDays: 5,
        pages: [page],
        quote,
      },
      {
        title: 'Book the defense hall',
        description: 'Not in the handbook.',
        priority: 'LOW',
        estimatedDays: 1,
        pages: [page],
        quote: 'this sentence is not anywhere in the handbook text',
      },
    ],
  };
}
