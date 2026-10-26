/**
 * PRODUCTION VERIFICATION — run from your computer after each deploy:
 *
 *   npm run prod:verify -- --base-url https://api.tammha.com/api/v1
 *        [--frontend-origin https://app.tammha.com] [--university-code UM] [--no-swagger]
 *        [--report ./production-verification.md]
 *
 * Optional ADMIN credentials (client-IP check), set in your shell — never in a file or chat:
 *   PROD_ADMIN_EMAIL, PROD_ADMIN_PASSWORD
 *
 * 1. Platform: HTTPS, health (database connected), security headers + HSTS, Swagger,
 *    CORS for your frontend, error format.
 * 2. Client IP (ADMIN): sends a FAKE True-Client-IP and confirms the rate limiter does not
 *    use it and does not see one shared proxy address for everybody.
 * 3. Flows (plain HTTP calls): register/login, project creation, invitation join, supervision,
 *    milestone, task, document upload (real Supabase Storage), submission status, feedback,
 *    dashboard + progress, notifications, meeting + LiveKit token (must be 200), AI next steps
 *    and AI handbook analysis (must be 201, real Gemini). The real handbook is only read.
 *
 * Side effects: 3 test users (*.<runId>@example.test), one test project with a tiny PDF, a
 * cancelled meeting and 2 AI requests. Remove them afterwards:
 *   npm run prod:cleanup -- --run-id <runId> --yes
 * Output never contains tokens, passwords or keys.
 */
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';

type Result = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
interface Check {
  name: string;
  result: Result;
  detail: string;
}

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(name);

const baseUrl = (arg('--base-url') ?? '').replace(/\/+$/, '');
const frontendOrigin = arg('--frontend-origin') ?? '';
const universityCode = arg('--university-code') ?? '';
const reportFile = arg('--report');
const expectSwagger = !flag('--no-swagger');
const allowHttp = flag('--allow-http'); // local rehearsal only
const adminEmail = process.env.PROD_ADMIN_EMAIL ?? '';
const adminPassword = process.env.PROD_ADMIN_PASSWORD ?? '';

const checks: Check[] = [];
const add = (name: string, result: Result, detail: string) => {
  checks.push({ name, result, detail });
  const icon = { PASS: '✔', FAIL: '✖', WARN: '!', SKIP: '-' }[result];
  console.log(`${icon} ${name}: ${detail}`);
};

const PRIVATE_IP =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fc|fd|::ffff:10\.|::ffff:127\.|::ffff:192\.168\.)/i;

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One HTTP call; returns status + parsed JSON (never throws on HTTP errors). */
async function call(
  method: string,
  path: string,
  options: {
    token?: string;
    json?: unknown;
    form?: FormData;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | FormData | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = text ? (JSON.parse(text) as Json) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

/** A tiny valid one-page PDF built in memory (no fixture file needed). */
function tinyPdf(): Buffer {
  const content =
    'BT /F1 12 Tf 72 720 Td (Tammha production verification) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function platformChecks(): Promise<boolean> {
  add(
    'HTTPS',
    baseUrl.startsWith('https://') ? 'PASS' : allowHttp ? 'WARN' : 'FAIL',
    baseUrl.startsWith('https://') ? 'TLS endpoint' : 'base URL is not https',
  );

  const t0 = Date.now();
  const health = await fetch(`${baseUrl}/health`).catch((e: Error) => e);
  if (health instanceof Error) {
    add('Health', 'FAIL', `not reachable: ${health.message}`);
    return false;
  }
  const hb = (await health.json().catch(() => ({}))) as Json;
  const healthy = health.status === 200 && hb.database === 'connected';
  add(
    'Health',
    healthy ? 'PASS' : 'FAIL',
    `HTTP ${health.status}, database=${String(hb.database)}, ${Date.now() - t0} ms`,
  );
  const h = health.headers;
  const problems = [
    h.get('x-content-type-options') === 'nosniff' ? '' : 'nosniff missing',
    (h.get('content-security-policy') ?? '').includes("default-src 'none'")
      ? ''
      : 'CSP missing',
    h.get('x-powered-by') ? 'X-Powered-By present' : '',
  ].filter(Boolean);
  add(
    'Security headers',
    problems.length ? 'FAIL' : 'PASS',
    problems.join(', ') || 'helmet headers present',
  );
  const hsts = h.get('strict-transport-security');
  add(
    'HSTS',
    hsts ? 'PASS' : allowHttp ? 'WARN' : 'FAIL',
    hsts ?? 'missing (NODE_ENV must be production)',
  );

  const docs = await fetch(`${baseUrl}/docs-json`);
  if (expectSwagger) {
    const spec = (await docs.json().catch(() => ({}))) as {
      paths?: object;
      info?: { title?: string };
    };
    add(
      'Swagger',
      docs.status === 200 && spec.paths ? 'PASS' : 'FAIL',
      docs.status === 200
        ? `${spec.info?.title}: ${Object.keys(spec.paths ?? {}).length} paths at ${baseUrl}/docs`
        : `HTTP ${docs.status} (set SWAGGER_ENABLED=true or pass --no-swagger)`,
    );
  } else {
    add(
      'Swagger hidden',
      docs.status === 404 ? 'PASS' : 'FAIL',
      `HTTP ${docs.status}`,
    );
  }

  if (frontendOrigin) {
    const pre = await fetch(`${baseUrl}/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: frontendOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    const allowed = pre.headers.get('access-control-allow-origin');
    add(
      'CORS frontend',
      allowed === frontendOrigin ? 'PASS' : 'FAIL',
      `allow-origin=${allowed ?? 'none'} (FRONTEND_ORIGIN)`,
    );
  } else {
    add(
      'CORS frontend',
      'SKIP',
      'no --frontend-origin given (set FRONTEND_ORIGIN when the frontend exists)',
    );
  }
  const evil = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://evil.example.com' },
  });
  add(
    'CORS other sites',
    evil.headers.get('access-control-allow-origin') ? 'FAIL' : 'PASS',
    'unknown origin gets no permission',
  );

  const unauth = await call('GET', '/auth/me');
  add(
    'Auth required + error format',
    unauth.status === 401 &&
      'timestamp' in unauth.body &&
      !JSON.stringify(unauth.body).includes('stack')
      ? 'PASS'
      : 'FAIL',
    `GET /auth/me without token -> ${unauth.status}`,
  );
  return healthy;
}

async function clientIpCheck() {
  if (!adminEmail || !adminPassword) {
    add(
      'Client IP (rate limiting)',
      'WARN',
      'not checked: set PROD_ADMIN_EMAIL / PROD_ADMIN_PASSWORD in your shell',
    );
    return;
  }
  const login = await call('POST', '/auth/login', {
    json: { email: adminEmail, password: adminPassword },
  });
  const token = login.body.tokens?.accessToken as string | undefined;
  if (!token) {
    add(
      'Client IP (rate limiting)',
      'FAIL',
      `admin login failed (HTTP ${login.status})`,
    );
    return;
  }
  const fake = '203.0.113.77';
  const diag = await call('GET', '/admin/diagnostics/request', {
    token,
    headers: { 'True-Client-IP': fake, 'CF-Connecting-IP': fake },
  });
  const d = diag.body;
  const ip = String(d.rateLimitClientIp ?? '');
  let result: Result = 'PASS';
  let detail = `rate limiter sees ${ip} (source ${d.source}) — compare with your public IP`;
  if (diag.status !== 200) {
    result = 'FAIL';
    detail = `diagnostics HTTP ${diag.status}`;
  } else if (ip === fake) {
    result = 'FAIL';
    detail = `${d.source} can be faked by clients. Remove CLIENT_IP_HEADER and set TRUST_PROXY to the number of X-Forwarded-For entries (${String(d.xForwardedFor ?? '').split(',').length})`;
  } else if (PRIVATE_IP.test(ip)) {
    result = 'FAIL';
    detail = `${ip} is a proxy address: all users would share one limit. X-Forwarded-For has ${String(d.xForwardedFor ?? '').split(',').length} entries — set TRUST_PROXY to that number, or CLIENT_IP_HEADER`;
  }
  add('Client IP (rate limiting)', result, detail);
}

async function flows(runId: string) {
  const password = `Pv-${randomBytes(9).toString('base64url')}7`;
  const email = (name: string) => `${name}.${runId}@example.test`;
  const step = (name: string, ok: boolean, detail: string) => {
    add(`Flow: ${name}`, ok ? 'PASS' : 'FAIL', detail);
    return ok;
  };

  const unis = await call('GET', '/universities');
  const list = Array.isArray(unis.body) ? (unis.body as unknown as Json[]) : [];
  const uni =
    list.find((u) => universityCode && u.code === universityCode) ?? list[0];
  if (
    !step(
      'Universities',
      unis.status === 200 && !!uni,
      `HTTP ${unis.status}, ${list.length} active`,
    )
  )
    return;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const [name, role] of [
    ['student1', 'STUDENT'],
    ['student2', 'STUDENT'],
    ['supervisor1', 'SUPERVISOR'],
  ] as const) {
    const r = await call('POST', '/auth/register', {
      json: {
        email: email(name),
        password,
        role,
        universityId: uni.id,
        firstName: name,
        lastName: 'Verification',
      },
    });
    if (!step(`Register ${name}`, r.status === 201, `HTTP ${r.status}`)) return;
    tokens[name] = r.body.tokens.accessToken;
    ids[name] = r.body.user.id;
  }
  const login = await call('POST', '/auth/login', {
    json: { email: email('student1'), password },
  });
  if (
    !step(
      'Login',
      login.status === 200 && !!login.body.tokens?.accessToken,
      `HTTP ${login.status}`,
    )
  )
    return;
  tokens.student1 = login.body.tokens.accessToken;
  const me = await call('GET', '/auth/me', { token: tokens.student1 });
  step(
    'Me (no password hash)',
    me.status === 200 && !('password' in me.body),
    `HTTP ${me.status}`,
  );

  const project = await call('POST', '/projects', {
    token: tokens.student1,
    json: {
      name: `Verification ${runId}`,
      description: 'Production verification (safe to delete)',
    },
  });
  if (
    !step('Project creation', project.status === 201, `HTTP ${project.status}`)
  )
    return;
  const projectId = project.body.project.id as string;
  const code = project.body.invitation.code as string;

  const join = await call('POST', '/teams/join', {
    token: tokens.student2,
    json: { code },
  });
  step('Join by invitation code', join.status === 200, `HTTP ${join.status}`);

  const sreq = await call(
    'POST',
    `/projects/${projectId}/supervision-requests`,
    {
      token: tokens.student1,
      json: { supervisorEmail: email('supervisor1') },
    },
  );
  const accept =
    sreq.status === 201
      ? await call('POST', `/supervision-requests/${sreq.body.id}/accept`, {
          token: tokens.supervisor1,
          json: {},
        })
      : { status: 0, body: {} };
  step(
    'Supervision request + accept',
    sreq.status === 201 && accept.status === 200,
    `HTTP ${sreq.status} / ${accept.status}`,
  );

  const due = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const ms = await call('POST', '/milestones', {
    token: tokens.student1,
    json: { projectId, title: 'Proposal', dueDate: due },
  });
  step('Milestone', ms.status === 201, `HTTP ${ms.status}`);
  const task = await call('POST', '/tasks', {
    token: tokens.student1,
    json: {
      projectId,
      title: 'Write the introduction',
      milestoneId: ms.body.id,
      assignedStudentId: ids.student2,
      dueDate: due,
    },
  });
  step('Task', task.status === 201, `HTTP ${task.status}`);

  const form = new FormData();
  form.append('projectId', projectId);
  form.append('title', 'Verification proposal');
  form.append('category', 'PROPOSAL');
  form.append(
    'file',
    new Blob([tinyPdf()], { type: 'application/pdf' }),
    'proposal.pdf',
  );
  const doc = await call('POST', '/documents/upload', {
    token: tokens.student1,
    form,
  });
  step(
    'Document upload (Supabase Storage)',
    doc.status === 201,
    `HTTP ${doc.status}`,
  );
  if (doc.status === 201) {
    const get = await call('GET', `/documents/${doc.body.id}`, {
      token: tokens.supervisor1,
    });
    step(
      'Document signed URL',
      get.status === 200 && typeof get.body.signedUrl === 'string',
      `HTTP ${get.status}`,
    );
    const sub = await call(
      'PATCH',
      `/documents/${doc.body.id}/submission-status`,
      {
        token: tokens.supervisor1,
        json: { status: 'UNDER_REVIEW' },
      },
    );
    step('Submission status', sub.status === 200, `HTTP ${sub.status}`);
  }
  const fb = await call('POST', '/feedback', {
    token: tokens.supervisor1,
    json: {
      projectId,
      comment: 'Production verification feedback',
      score: 8,
      maxScore: 10,
      scoreVisibleToStudents: false,
    },
  });
  step('Feedback', fb.status === 201, `HTTP ${fb.status}`);

  const dash = await call('GET', '/dashboard/student', {
    token: tokens.student1,
  });
  step(
    'Student dashboard',
    dash.status === 200 && dash.body.hasProject === true,
    `HTTP ${dash.status}`,
  );
  const prog = await call('GET', `/projects/${projectId}/progress`, {
    token: tokens.supervisor1,
  });
  step(
    'Progress + readiness',
    prog.status === 200 && typeof prog.body.progress?.percent === 'number',
    `HTTP ${prog.status}`,
  );
  const notes = await call('GET', '/notifications', { token: tokens.student2 });
  step(
    'Notifications',
    notes.status === 200 && (notes.body.items?.length ?? 0) > 0,
    `HTTP ${notes.status}, ${notes.body.items?.length ?? 0} items`,
  );

  const meeting = await call('POST', '/meetings', {
    token: tokens.supervisor1,
    json: {
      projectId,
      title: 'Verification meeting',
      scheduledAt: new Date(Date.now() + 5 * 60000).toISOString(),
      durationMinutes: 30,
    },
  });
  step('Meeting scheduled', meeting.status === 201, `HTTP ${meeting.status}`);
  if (meeting.status === 201) {
    const lk = await call('POST', `/meetings/${meeting.body.id}/token`, {
      token: tokens.student1,
    });
    const okToken =
      lk.status === 200 &&
      String(lk.body.token ?? '').split('.').length === 3 &&
      !/secret/i.test(JSON.stringify(lk.body));
    step(
      'LiveKit token',
      okToken,
      `HTTP ${lk.status}${lk.body.code ? ` ${lk.body.code}` : ''}`,
    );
    await call('POST', `/meetings/${meeting.body.id}/cancel`, {
      token: tokens.supervisor1,
      json: { reason: 'verification done' },
    });
  }

  const ai = await call('POST', '/ai-support/requests', {
    token: tokens.student1,
    json: { projectId, kind: 'NEXT_STEPS' },
  });
  step(
    'AI next steps (Gemini)',
    ai.status === 201 && ai.body.advisoryOnly === true,
    `HTTP ${ai.status}${ai.body.code ? ` ${ai.body.code}` : ''}`,
  );
  const hb = await call('POST', '/ai-support/requests', {
    token: tokens.student2,
    json: {
      projectId,
      kind: 'HANDBOOK_GUIDANCE',
      question: 'What must the proposal contain?',
    },
  });
  step(
    'AI handbook analysis',
    hb.status === 201 &&
      hb.body.handbook?.used === true &&
      hb.body.handbook?.excerptsUsed > 0,
    `HTTP ${hb.status}${hb.body.code ? ` ${hb.body.code} (upload the handbook: npm run handbook -- upload ...)` : ''}`,
  );
}

async function main() {
  if (!/^https?:\/\/[^\s]+\/api\/v\d+$/.test(baseUrl)) {
    console.error(
      'Usage: npm run prod:verify -- --base-url https://<host>/api/v1',
    );
    process.exit(2);
  }
  const healthy = await platformChecks();
  await clientIpCheck();
  const runId = `p${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  if (healthy) {
    console.log(`\nFlows (test data run id ${runId}):`);
    await flows(runId);
  }
  const failed = checks.filter((c) => c.result === 'FAIL').length;
  console.log(
    `\nPRODUCTION ${failed === 0 ? 'PASS' : `FAIL (${failed} checks)`} — ${checks.length} checks`,
  );
  if (healthy)
    console.log(
      `Remove the test data: npm run prod:cleanup -- --run-id ${runId} --yes`,
    );
  if (reportFile) {
    const lines = [
      '# Production verification — Tammha API',
      '',
      `- Date: ${new Date().toISOString()}`,
      `- Base URL: ${baseUrl}`,
      `- Result: **${failed === 0 ? 'PASS' : `FAIL (${failed} checks)`}**`,
      ...(healthy ? [`- Test data run id: \`${runId}\``] : []),
      '',
      '| Check | Result | Detail |',
      '|---|---|---|',
      ...checks.map(
        (c) => `| ${c.name} | ${c.result} | ${c.detail.replace(/\|/g, '/')} |`,
      ),
      '',
    ];
    writeFileSync(reportFile, lines.join('\n'));
    console.log(`Report: ${reportFile}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('prod:verify failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
