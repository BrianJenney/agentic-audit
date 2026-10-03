#!/usr/bin/env node
// agentic-audit: is your AI workflow actually making you ship more?
// Compares a "before" window to an "after" window around the date you changed how you work.
// Zero dependencies. Node 20+. Everything runs locally except the optional Jev grading pass.

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DAY = 86400000;
const WEEK = 7 * DAY;

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
const BOOL_FLAGS = new Set(['yes', 'help', 'jev', 'no-jev', 'prs', 'no-prs', 'tokens', 'no-tokens', 'no-open']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const [k, ...rest] = a.slice(2).split('=');
  const v = rest.length ? rest.join('=') : undefined;
  if (v !== undefined) flags[k] = v;
  else if (!BOOL_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
  else flags[k] = true;
}

if (flags.help) {
  console.log(`agentic-audit: compare your output before and after you changed your AI workflow
Built by Parsity: https://parsity.io/ai-dev

Usage: npx github:BrianJenney/agentic-audit [repos...] [options]

  repos               Local paths or GitHub repos (owner/repo or a github.com URL).
                      Default: the current directory. GitHub repos are cloned to a temp folder.

Examples:
  npx github:BrianJenney/agentic-audit
  npx github:BrianJenney/agentic-audit ~/dev/api ~/dev/web
  npx github:BrianJenney/agentic-audit vercel/next.js --author you@example.com

  --repo <paths>      Same as the repos argument, comma-separated
  --author <emails>   Comma-separated git emails (default: git config user.email)
  --cutoff <date>     YYYY-MM-DD, the day you started the new workflow
  --weeks <n>         Weeks to compare on each side (default: time since cutoff, max 12)
  --jev / --no-jev    Grade sampled commits with Jev (needs TYPESAFE_API_KEY or AI_GATEWAY_API_KEY)
  --sample <n>        Max commits graded per period (default 30)
  --prs / --no-prs    Pull merged PR stats with the gh CLI
  --tokens/--no-tokens Read Claude Code / Codex token usage from local logs
  --out <dir>         Where to write the report (default: current directory)
  --agents <names>    Extra AI agent names to detect in commits, e.g. an internal bot
  --no-open           Don't open the HTML report when done
  --yes               Don't ask anything, use defaults`);
  process.exit(0);
}

const interactive = process.stdin.isTTY && !flags.yes;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

async function ask(q, def) {
  if (!rl) return def;
  const ans = (await rl.question(`${q}${def !== undefined && def !== '' ? ` [${def}]` : ''}: `)).trim();
  return ans === '' ? def : ans;
}
async function askYN(q, def) {
  if (!rl) return def;
  const ans = (await rl.question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
  return ans === '' ? def : ans.startsWith('y');
}
function boolFlag(name) {
  if (flags[name] === true || flags[name] === 'true') return true;
  if (flags[`no-${name}`] || flags[name] === 'false') return false;
  return undefined;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}
const git = (args, cwd) => run('git', args, cwd);

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- classification helpers ----------
const NOISE = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage|out|__generated__|generated)\/|\.(lock|min\.js|min\.css|snap|map|svg|png|jpe?g|gif|ico|pdf|ipynb|woff2?)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|uv\.lock)$/i;
const TESTPATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|playwright)\/|\.(test|spec|e2e)\.[a-z]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i;
const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rb|java|kt|kts|swift|rs|php|c|cc|cpp|h|hpp|cs|scala|vue|svelte|sh|bash|zsh|sql|dart|ex|exs|clj|lua)$/i;
const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|<!--)/;
const BRANCH = /\b(if|elif|for|foreach|while|case|catch|except|when|guard)\b|&&|\|\||\sand\s|\sor\s| \? /g;
const FIXMSG = /\b(fix(es|ed)?|bug|hotfix|revert|oops|typo|patch|broken)\b/i;
const BULK_LINES = 3000; // commits bigger than this are usually codegen, moves or vendoring

function branchCount(line) {
  if (COMMENT.test(line)) return 0;
  const m = line.match(BRANCH);
  return m ? m.length : 0;
}

// ---------- git history ----------
function readCommits(repo, authors, since, until) {
  const args = ['log', '--all', '--no-merges', '-p', '--unified=0', '--no-color', '--no-ext-diff',
    '--format=%x1e%H%x1f%aI%x1f%s', `--since=${since.toISOString()}`, `--until=${until.toISOString()}`,
    ...authors.map((a) => `--author=${a}`)];
  const out = git(args, repo);
  if (out === null) throw new Error(`git log failed in ${repo}`);
  const commits = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    const [sha, date, subject] = lines[0].split('\x1f');
    const files = new Map();
    let cur = null, inHunk = false;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('diff --git ')) {
        const m = / b\/(.+)$/.exec(l);
        const p = m ? m[1] : l;
        cur = files.get(p) || { path: p, added: 0, deleted: 0, branchAdd: 0, branchDel: 0 };
        files.set(p, cur);
        inHunk = false;
        continue;
      }
      if (l.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk || !cur) continue;
      const isCode = CODE.test(cur.path);
      if (l[0] === '+') { cur.added++; if (isCode) cur.branchAdd += branchCount(l.slice(1)); }
      else if (l[0] === '-') { cur.deleted++; if (isCode) cur.branchDel += branchCount(l.slice(1)); }
    }
    const real = [...files.values()].filter((f) => !NOISE.test(f.path));
    const size = real.reduce((s, f) => s + f.added + f.deleted, 0);
    commits.push({ repo, sha, date: new Date(date), subject: subject || '', files: real, size, bulk: size > BULK_LINES });
  }
  return commits;
}

// ---------- agent attribution from git ----------
const AGENT_TOOLS = [
  ['Claude', /noreply@anthropic\.com|\bclaude\b|claude\.ai\/code|claude\.com\/claude-code/i],
  ['Cursor', /cursoragent@cursor\.com|\bcursor\b/i],
  ['Copilot', /copilot/i],
  ['Codex', /\bcodex\b|openai/i],
  ['Devin', /devin/i],
  ['Aider', /\baider\b/i],
  ['Gemini', /gemini/i],
];
const ATTRIB_LINE = /^\s*(co-authored-by|ai-assisted|assisted-by|generated-by|ai-tool)\s*:|^\s*🤖?\s*generated with/i;
const NOT_AI_BOTS = /dependabot|renovate|github-actions|semantic-release|greenkeeper|snyk|pre-commit|mergify|allcontributors|imgbot|codecov/i;

const unknownBots = new Map();
const tagDates = [];
const extraAgents = String(flags.agents || '').split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => [x, new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]);

function agentTags(repo, authors, since, until) {
  const out = git(['log', '--all', '--no-merges', '--format=%x1e%H%x1f%ae%x1f%an%x1f%aI%x1f%B',
    `--since=${since.toISOString()}`, `--until=${until.toISOString()}`, ...authors.map((a) => `--author=${a}`)], repo) || '';
  const tags = new Map();
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const [sha, email, name, date, body = ''] = rec.split('\x1f');
    const lines = body.split('\n').filter((l) => ATTRIB_LINE.test(l));
    const hay = [email, name, ...lines].join('\n');
    let tool = null;
    for (const [t, re] of extraAgents) if (re.test(hay)) { tool = t; break; }
    if (!tool) for (const [t, re] of AGENT_TOOLS) if (re.test(hay)) { tool = t; break; }
    if (!tool) for (const l of lines) {
      const m = /^\s*co-authored-by:\s*([^<]*\[bot\])/i.exec(l);
      if (m && !NOT_AI_BOTS.test(m[1])) unknownBots.set(m[1].trim(), (unknownBots.get(m[1].trim()) || 0) + 1);
    }
    if (!tool && /^\s*(ai-assisted|assisted-by|ai-tool)\s*:\s*(?!no\b|false\b|0\b)\S/im.test(body)) tool = 'Self-tagged';
    if (tool) tags.set(sha.trim(), tool);
    tagDates.push({ t: new Date(date).getTime(), ai: !!tool });
  }
  return tags;
}

function rework(commits) {
  // a file touch counts as "reworked" if you touched the same file again within 72h
  const byFile = new Map();
  for (const c of commits) for (const f of c.files) {
    const k = `${c.repo}::${f.path}`;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k).push(c.date.getTime());
  }
  const reworked = new Set();
  for (const c of commits) for (const f of c.files) {
    const times = byFile.get(`${c.repo}::${f.path}`);
    const t = c.date.getTime();
    if (times.some((x) => x > t && x - t <= 3 * DAY)) reworked.add(`${c.sha}::${f.path}`);
  }
  return reworked;
}

function summarize(commits, reworked, weeks) {
  const s = { commits: commits.length, bulkCommits: 0, activeDays: new Set(), added: 0, deleted: 0, otherLines: 0, testAdded: 0, agentCommits: 0, agentCode: 0, agentTools: {},
    branchAdd: 0, branchDel: 0, files: new Set(), touches: 0, reworkedTouches: 0, fixCommits: 0, reverts: 0 };
  for (const c of commits) {
    s.activeDays.add(ymd(c.date));
    if (FIXMSG.test(c.subject)) s.fixCommits++;
    if (c.agent) { s.agentCommits++; s.agentTools[c.agent] = (s.agentTools[c.agent] || 0) + 1; }
    if (/^revert/i.test(c.subject)) s.reverts++;
    for (const f of c.files) {
      s.files.add(`${c.repo}::${f.path}`);
      s.touches++;
      if (reworked.has(`${c.sha}::${f.path}`)) s.reworkedTouches++;
    }
    if (c.bulk) { s.bulkCommits++; continue; }
    for (const f of c.files) {
      if (!CODE.test(f.path)) { s.otherLines += f.added + f.deleted; continue; }
      s.added += f.added; s.deleted += f.deleted;
      if (c.agent) s.agentCode += f.added + f.deleted;
      s.branchAdd += f.branchAdd; s.branchDel += f.branchDel;
      if (TESTPATH.test(f.path)) s.testAdded += f.added;
    }
  }
  const pct = (a, b) => (b ? (100 * a) / b : 0);
  return {
    weeks,
    commitsPerWeek: s.commits / weeks,
    activeDaysPerWeek: s.activeDays.size / weeks,
    linesChangedPerWeek: (s.added + s.deleted) / weeks,
    otherLinesPerWeek: s.otherLines / weeks,
    netLinesPerWeek: (s.added - s.deleted) / weeks,
    filesTouchedPerWeek: s.files.size / weeks,
    medianCommitSize: median(commits.filter((c) => !c.bulk).map((c) => c.size)),
    decisionPointsAddedPerWeek: (s.branchAdd - s.branchDel) / weeks,
    decisionPointsPer100Lines: pct(s.branchAdd, s.added),
    testLineSharePct: pct(s.testAdded, s.added),
    reworkPct: pct(s.reworkedTouches, s.touches),
    fixCommitPct: pct(s.fixCommits, s.commits),
    reverts: s.reverts,
    agentCommitPct: pct(s.agentCommits, s.commits),
    agentCodePct: pct(s.agentCode, s.added + s.deleted),
    agentTools: s.agentTools,
    bulkCommitsExcluded: s.bulkCommits,
    totalCommits: s.commits,
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------- PRs via gh ----------
// ---------- resolving repo arguments ----------
const repoLabels = new Map(); // local path -> display name
const repoSlugs = new Map();  // local path -> owner/repo for gh

function parseGitHub(arg) {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:|github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(arg.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function resolveRepo(arg) {
  const local = path.resolve(arg.replace(/^~(?=$|\/)/, os.homedir()));
  if (fs.existsSync(local)) {
    if (git(['rev-parse', '--git-dir'], local) === null) throw new Error(`${local} is not a git repo`);
    repoLabels.set(local, path.basename(local));
    return local;
  }
  const slug = parseGitHub(arg);
  if (!slug) throw new Error(`Can't find "${arg}". Pass a local path, owner/repo, or a github.com URL.`);
  const dir = path.join(os.tmpdir(), 'agentic-audit', slug.replace('/', '__'));
  const since = new Date(Date.now() - 2 * 365 * DAY).toISOString().slice(0, 10);
  if (fs.existsSync(path.join(dir, 'HEAD'))) {
    process.stdout.write(`Updating ${slug}... `);
    git(['fetch', '--quiet', `--shallow-since=${since}`, 'origin', '+refs/heads/*:refs/heads/*'], dir);
  } else {
    process.stdout.write(`Cloning ${slug} (last 2 years, no checkout)... `);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = spawnSync('git', ['clone', '--bare', '--quiet', `--shallow-since=${since}`, `https://github.com/${slug}.git`, dir], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Couldn't clone ${slug}. Is it private? Clone it yourself and pass the local path.\n${(r.stderr || '').trim()}`);
  }
  console.log('done');
  repoLabels.set(dir, slug);
  repoSlugs.set(dir, slug);
  return dir;
}

function prStats(repo, from, to, weeks) {
  const out = run('gh', ['pr', 'list', ...(repoSlugs.has(repo) ? ['-R', repoSlugs.get(repo)] : []), '--author', '@me', '--state', 'merged', '--limit', '1000',
    '--search', `merged:${ymd(from)}..${ymd(new Date(to.getTime() - DAY))}`,
    '--json', 'number,additions,deletions,createdAt,mergedAt'], repo);
  if (out === null) return null;
  const prs = JSON.parse(out);
  return {
    merged: prs.length,
    cycleHours: prs.map((p) => (new Date(p.mergedAt) - new Date(p.createdAt)) / 3600000),
    sizes: prs.map((p) => p.additions + p.deletions),
    weeks,
  };
}

// ---------- token usage from local agent logs ----------
function* walk(dir, ext) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, ext);
    else if (p.endsWith(ext)) yield p;
  }
}

function tokenUsage(periods, repos) {
  const res = periods.map(() => ({ claude: 0, claudeInRepo: 0, codex: 0, sessions: new Set() }));
  const which = (t) => periods.findIndex((p) => t >= p.from && t < p.to);
  const repoRoots = repos.map((r) => path.resolve(r));
  let oldest = Infinity;

  // Claude Code: ~/.claude/projects/**/*.jsonl, one line per message with message.usage
  const seen = new Set();
  for (const f of walk(path.join(os.homedir(), '.claude', 'projects'), '.jsonl')) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = o?.message?.usage; if (!u || !o.timestamp) continue;
      const key = `${o.message.id || ''}:${o.requestId || ''}`;
      if (key !== ':' && seen.has(key)) continue;
      seen.add(key);
      const t = new Date(o.timestamp).getTime();
      oldest = Math.min(oldest, t);
      const i = which(t); if (i < 0) continue;
      const n = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      res[i].claude += n;
      if (o.cwd && repoRoots.some((r) => path.resolve(o.cwd).startsWith(r))) res[i].claudeInRepo += n;
      if (o.sessionId) res[i].sessions.add(o.sessionId);
    }
  }

  // Codex (best effort): ~/.codex/sessions/**/*.jsonl, cumulative token_count events, take the last one per file
  for (const f of walk(path.join(os.homedir(), '.codex', 'sessions'), '.jsonl')) {
    let last = null;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('token_count')) continue;
      try { const o = JSON.parse(line); const tu = o?.payload?.info?.total_token_usage; if (tu) last = { t: new Date(o.timestamp).getTime(), tu }; } catch {}
    }
    if (!last) continue;
    oldest = Math.min(oldest, last.t);
    const i = which(last.t); if (i < 0) continue;
    res[i].codex += (last.tu.total_tokens ?? ((last.tu.input_tokens || 0) + (last.tu.output_tokens || 0)));
  }
  return { res: res.map((r) => ({ ...r, sessions: r.sessions.size })), oldest };
}

// ---------- Jev grading ----------
function jevConfig() {
  if (process.env.TYPESAFE_API_KEY) return { url: process.env.JEV_BASE_URL || 'https://api.typesafe.ai', key: process.env.TYPESAFE_API_KEY, model: 'jev-latest', via: 'TypeSafe' };
  if (process.env.AI_GATEWAY_API_KEY) return { url: process.env.JEV_BASE_URL || 'https://ai-gateway.vercel.sh/typesafe', key: process.env.AI_GATEWAY_API_KEY, model: 'typesafe-ai/jev', via: 'Vercel AI Gateway' };
  return null;
}

const JEV_QUESTIONS = {
  difficulty: {
    type: 'score',
    instructions: 'How hard was the engineering work in this commit? Judge `diff` and `message`, not the line count.',
    criteria: [
      'Trivial: typo, rename, formatting, version bump, small config tweak',
      'Small: localized change in one place with obvious logic',
      'Moderate: new logic, or a fix that needs understanding of the surrounding code',
      'Substantial: multi-file feature, or a non-obvious bug fix',
      'Hard: architectural change, concurrency, data migration, security, or subtle correctness work',
    ],
  },
  kind: {
    type: 'choice',
    instructions: 'What kind of change is this commit?',
    criteria: {
      feature: 'Adds new user-facing or API behavior',
      bugfix: 'Corrects broken behavior',
      refactor: 'Restructures code without changing behavior',
      tests: 'Mostly adds or changes tests',
      docs_config: 'Docs, CI, build, or configuration',
      chore: 'Dependency bumps, cleanup, generated output',
    },
  },
  substantive: {
    type: 'noul',
    instructions: 'Would a careful reviewer have to actually think about this change instead of skimming it?',
  },
};

function commitState(c, maxChars) {
  const excludes = [':(exclude)*.lock', ':(exclude)*lock.json', ':(exclude)*lock.yaml', ':(exclude)*.snap', ':(exclude)*.min.*', ':(exclude)*.svg'];
  let diff = git(['show', '--no-color', '--no-ext-diff', '--unified=2', '--format=', c.sha, '--', '.', ...excludes], c.repo) || '';
  if (diff.length > maxChars) diff = diff.slice(0, maxChars) + `\n... [truncated, ${diff.length - maxChars} more chars]`;
  return { message: c.subject, files_changed: c.files.map((f) => f.path).slice(0, 40), lines_changed: c.size, diff };
}

function sample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

async function jevGrade(cfg, state) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${cfg.url}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, state, questions: JEV_QUESTIONS }),
    });
    if (r.ok) return r.json();
    if (r.status === 429 || r.status === 529 || r.status >= 500) {
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      continue;
    }
    throw new Error(`Jev ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  throw new Error('Jev kept failing (rate limited or overloaded)');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function jevSummary(results, commitsPerWeek) {
  const ok = results.filter(Boolean);
  if (!ok.length) return null;
  const diff = ok.map((r) => r.answers.difficulty.score + 1); // 1..5
  const kinds = {};
  for (const r of ok) kinds[r.answers.kind.choice] = (kinds[r.answers.kind.choice] || 0) + 1;
  const avg = diff.reduce((a, b) => a + b, 0) / diff.length;
  return {
    graded: ok.length,
    avgDifficulty: avg,
    substantivePct: (100 * ok.filter((r) => r.answers.substantive.noul >= 0.5).length) / ok.length,
    weightedOutputPerWeek: commitsPerWeek * avg,
    kindMix: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, (100 * v) / ok.length])),
    tokens: ok.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0),
  };
}

// ---------- formatting ----------
const fmt = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? 'n/a' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
function change(a, b, isPct = false) {
  if (a === null || b === null || a === undefined || b === undefined) return '';
  if (isPct) { const d = b - a; return `${d >= 0 ? '+' : ''}${fmt(d)} pts`; }
  if (!a) return b ? 'new' : '0%';
  const d = (100 * (b - a)) / Math.abs(a);
  return `${d >= 0 ? '+' : ''}${fmt(d, 0)}%`;
}


// ---------- pretty output ----------
// group and direction (+1 higher is better, -1 lower is better, 0 neutral) per metric
const META = {
  'Commits / week': ['Throughput', 1], 'Active days / week': ['Throughput', 1],
  'Code lines changed / week': ['Throughput', 0], 'Docs, data, markup lines / week': ['Throughput', 0],
  'Files touched / week': ['Throughput', 0], 'Median commit size (lines)': ['Throughput', 0],
  'Decision points added / week': ['Complexity', 0], 'Decision points per 100 lines': ['Complexity', 0],
  'Test share of added code': ['Quality', 1], 'Rework (same file again <72h)': ['Quality', -1], 'Fix / revert commits': ['Quality', -1],
  'Merged PRs / week': ['Pull requests', 1], 'Median PR cycle time (hours)': ['Pull requests', -1], 'Median PR size (lines)': ['Pull requests', 0],
  'Avg difficulty (1-5, Jev)': ['Difficulty', 1], 'Difficulty-weighted output / week': ['Difficulty', 1], 'Substantive commits': ['Difficulty', 1],
  'Claude Code tokens / week': ['Agent spend', 0], '  ...in these repos': ['Agent spend', 0], 'Codex tokens / week': ['Agent spend', 0], 'Agent tokens per commit (after)': ['Agent spend', 0],
  'Commits tagged as agent-written': ['Agent usage', 0], 'Code lines in agent-tagged commits': ['Agent usage', 0],
};
const GROUP_BLURB = {
  Throughput: 'How much you shipped. Easy to inflate, so read it next to quality.',
  Complexity: 'Branching logic added to the codebase. More logic means more places for bugs.',
  Quality: 'Whether the extra output holds up.',
  'Pull requests': 'What actually got reviewed and merged.',
  Difficulty: 'How hard the work was, graded commit by commit by Jev.',
  'Agent spend': 'Tokens from your local Claude Code and Codex logs.',
  'Agent usage': 'Commits your tools signed in git (Co-Authored-By trailers and similar). Works for any date, no logs needed.',
};

function noteKind(n) {
  if (/Good sign|number to bring/i.test(n)) return 'good';
  if (/Small sample|logs only go back|No Claude Code|No big red flags|Agent-tagged commits went|bot co-authors/i.test(n)) return 'info';
  return 'warn';
}

function verdict(x, y, isPct, dir) {
  if (x === null || y === null || dir === 0) return 'neutral';
  const delta = isPct ? y - x : x ? (y - x) / Math.abs(x) : y ? 1 : 0;
  const small = isPct ? Math.abs(delta) < 1 : Math.abs(delta) < 0.05;
  if (small) return 'neutral';
  return delta * dir > 0 ? 'good' : 'bad';
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHtml({ rows, notes, kindMix, meta, methodology, limits }) {
  const cell = (v, isPct, d) => (v === null ? 'n/a' : `${fmt(v, d)}${isPct ? '%' : ''}`);
  const heroNames = ['Difficulty-weighted output / week', 'Commits / week', 'Code lines changed / week', 'Test share of added code', 'Rework (same file again <72h)'];
  const hero = heroNames.map((n) => rows.find((r) => r[0] === n)).filter(Boolean).slice(0, 4);
  const card = ([name, x, y, d = 1, isPct = false]) => {
    const v = verdict(x, y, isPct, META[name]?.[1] ?? 0);
    return `<div class="kpi">
      <div class="kpi-label">${esc(name)}</div>
      <div class="kpi-value">${cell(y, isPct, d)}</div>
      <div class="kpi-sub"><span class="pill ${v}">${esc(change(x, y, isPct) || 'n/a')}</span> from ${cell(x, isPct, d)}</div>
    </div>`;
  };
  const groups = {};
  for (const r of rows) (groups[META[r[0]]?.[0] || 'Other'] ||= []).push(r);
  const rowHtml = ([name, x, y, d = 1, isPct = false]) => {
    const v = verdict(x, y, isPct, META[name]?.[1] ?? 0);
    const max = Math.max(Math.abs(x ?? 0), Math.abs(y ?? 0)) || 1;
    const w = (n) => (n === null ? 0 : Math.max(1.5, (100 * Math.abs(n)) / max));
    return `<div class="row">
      <div class="name">${esc(name.trim())}</div>
      <div class="bars">
        <div class="bar-line"><span class="tag">Before</span><div class="track"><div class="bar before" style="width:${w(x)}%"></div></div><span class="num">${cell(x, isPct, d)}</span></div>
        <div class="bar-line"><span class="tag">After</span><div class="track"><div class="bar after ${v}" style="width:${w(y)}%"></div></div><span class="num">${cell(y, isPct, d)}</span></div>
      </div>
      <div class="chg"><span class="pill ${v}">${esc(x === null ? 'n/a' : change(x, y, isPct))}</span></div>
    </div>`;
  };
  const icon = { good: '&#10003;', warn: '!', info: 'i' };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic Workflow Audit</title>
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#17171a;--muted:#6b6b73;--line:#e6e4df;--track:#efede8;--before:#b9b7b0;--accent:#2f5bea;
--good:#15803d;--good-bg:#dcfce7;--bad:#b91c1c;--bad-bg:#fee2e2;--neutral:#52525b;--neutral-bg:#ececef;--warn-bg:#fff7e6;--warn:#b45309;--info-bg:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--panel:#18181b;--ink:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--track:#232327;--before:#52525b;--accent:#6d8cff;
--good:#4ade80;--good-bg:#14301f;--bad:#f87171;--bad-bg:#3a1515;--neutral:#a1a1aa;--neutral-bg:#26262b;--warn-bg:#2d2213;--warn:#fbbf24;--info-bg:#1b1f33}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:48px 20px 64px}
.eyebrow{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(28px,5vw,42px);line-height:1.1;margin:12px 0 14px;letter-spacing:-.02em}
.meta{display:flex;flex-wrap:wrap;gap:8px 20px;color:var(--muted);font-size:13px}
.meta b{color:var(--ink);font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:32px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.kpi-label{color:var(--muted);font-size:13px}.kpi-value{font:700 34px/1.15 ui-monospace,SFMono-Regular,Menlo,monospace;margin:6px 0 8px;letter-spacing:-.02em}
.kpi-sub{font-size:13px;color:var(--muted)}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font:600 12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.pill.good{color:var(--good);background:var(--good-bg)}.pill.bad{color:var(--bad);background:var(--bad-bg)}.pill.neutral{color:var(--neutral);background:var(--neutral-bg)}
h2{font-size:20px;margin:40px 0 4px;letter-spacing:-.01em}.blurb{color:var(--muted);margin:0 0 14px;font-size:14px}
.notes{display:grid;gap:10px}
.note{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:12px;border:1px solid var(--line);background:var(--panel)}
.note .ic{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:700 12px/1 ui-monospace,monospace}
.note.warn{background:var(--warn-bg)}.note.warn .ic{background:var(--warn);color:var(--bg)}
.note.good{background:var(--good-bg)}.note.good .ic{background:var(--good);color:var(--bg)}
.note.info{background:var(--info-bg)}.note.info .ic{background:var(--accent);color:#fff}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:4px 18px}
.row{display:grid;grid-template-columns:minmax(150px,1.1fr) 2fr 90px;gap:16px;align-items:center;padding:14px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}.name{font-weight:550;font-size:14px}
.bars{display:grid;gap:5px}.bar-line{display:grid;grid-template-columns:44px 1fr 72px;gap:8px;align-items:center}
.tag{font-size:11px;color:var(--muted)}.track{height:8px;background:var(--track);border-radius:99px;overflow:hidden}
.bar{height:100%;border-radius:99px}.bar.before{background:var(--before)}.bar.after{background:var(--accent)}
.bar.after.good{background:var(--good)}.bar.after.bad{background:var(--bad)}
.num{font:500 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right}.chg{text-align:right}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:10px 0;border-top:1px solid var(--line);text-align:right}th{color:var(--muted);font-weight:500}td:first-child,th:first-child{text-align:left}tr:first-child th{border-top:0}
.limits{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.limit{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.limit.hit{border-color:var(--warn)}.pill.warn{color:var(--warn);background:var(--warn-bg);margin-bottom:8px}
.limit-title{font-weight:600;font-size:15px}
.limit p{color:var(--muted);font-size:14px;margin:8px 0 12px}.fix{display:flex;gap:10px;font-size:13.5px;background:var(--track);border-radius:10px;padding:10px 12px}
.fix-label{flex:none;font:600 11px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--accent)}
details{margin-top:40px;color:var(--muted);font-size:14px}summary{cursor:pointer;color:var(--ink);font-weight:600}details ul{padding-left:18px}
footer{margin-top:40px;color:var(--muted);font-size:12px}
@media (max-width:640px){.row{grid-template-columns:1fr;gap:8px}.chg{text-align:left}}
</style></head><body><div class="wrap">
<div class="eyebrow">Agentic Workflow Audit</div>
<h1>Did your new workflow actually move the needle?</h1>
<div class="meta">${meta.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div>
<div class="kpis">${hero.map(card).join('')}</div>
<h2>The honest read</h2>
<p class="blurb">What the numbers say when you read them together.</p>
<div class="notes">${notes.map((n) => { const k = noteKind(n); return `<div class="note ${k}"><span class="ic">${icon[k]}</span><div>${esc(n)}</div></div>`; }).join('')}</div>
${Object.entries(groups).map(([g, rs]) => `<h2>${esc(g)}</h2><p class="blurb">${esc(GROUP_BLURB[g] || '')}</p><div class="panel">${rs.map(rowHtml).join('')}</div>`).join('')}
${kindMix ? `<h2>What kind of work</h2><p class="blurb">Share of graded commits by type.</p><div class="panel"><table><tr><th>Kind</th><th>Before</th><th>After</th></tr>${kindMix.map(([k, x, y]) => `<tr><td>${esc(k)}</td><td>${fmt(x)}%</td><td>${fmt(y)}%</td></tr>`).join('')}</table></div>` : ''}
<h2>What this can't see</h2>
<p class="blurb">The honest limits, and how to close each gap. The ones marked affect the numbers above.</p>
<div class="limits">${[...limits].sort((x, y) => y.hit - x.hit).map((l) => `<div class="limit${l.hit ? ' hit' : ''}">
  ${l.hit ? '<span class="pill warn">Affects this report</span>' : ''}<div class="limit-title">${esc(l.title)}</div>
  <p>${esc(l.detail)}</p>
  <div class="fix"><span class="fix-label">Fix</span><span>${esc(l.fix)}</span></div>
</div>`).join('')}</div>
<details><summary>How these are measured</summary><ul>${methodology.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></details>
<footer>Generated ${esc(new Date().toLocaleString())} by agentic-audit, a before/after audit of your AI workflow. Everything was computed on your machine.<br>Want to move these numbers? <a href="https://parsity.io/ai-dev" style="color:var(--accent)">Parsity</a> teaches developers to get into the top 10% with agentic workflows.</footer>
</div></body></html>`;
}

function printTerminal(rows, notes, meta, limits = []) {
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code, t) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
  const color = { good: (t) => c('32', t), bad: (t) => c('31', t), neutral: (t) => c('90', t) };
  const cell = (v, isPct, d) => (v === null ? 'n/a' : `${fmt(v, d)}${isPct ? '%' : ''}`);
  const W = [34, 12, 12, 12];
  const line = c('90', '─'.repeat(W.reduce((a, b) => a + b, 0) + 3));
  console.log('\n' + c('1', '  AGENTIC WORKFLOW AUDIT'));
  for (const [k, v] of meta) console.log(c('90', `  ${k.padEnd(9)}`) + v);
  let group = null;
  for (const [name, x, y, d = 1, isPct = false] of rows) {
    const g = META[name]?.[0] || 'Other';
    if (g !== group) {
      group = g;
      console.log('\n  ' + c('1', g.toUpperCase()) + c('90', `${' '.repeat(Math.max(1, W[0] - g.length))}${'Before'.padStart(W[1])}${'After'.padStart(W[2])}${'Change'.padStart(W[3])}`));
      console.log('  ' + line);
    }
    const v = verdict(x, y, isPct, META[name]?.[1] ?? 0);
    const ch = x === null ? '' : change(x, y, isPct);
    console.log(`  ${name.trim().padEnd(W[0])}${cell(x, isPct, d).padStart(W[1])}${c('1', cell(y, isPct, d).padStart(W[2]))}${color[v](ch.padStart(W[3]))}`);
  }
  console.log('\n  ' + c('1', 'THE HONEST READ') + '\n  ' + line);
  const mark = { good: color.good('✓'), warn: c('33', '!'), info: c('34', 'i') };
  for (const n of notes) console.log(`  ${mark[noteKind(n)]} ${n}`);
  const hits = limits.filter((l) => l.hit);
  if (hits.length) {
    console.log('\n  ' + c('1', "BLIND SPOTS IN THIS RUN") + '\n  ' + line);
    for (const l of hits) console.log(`  ${c('31', '•')} ${c('1', l.title)}\n    ${c('90', 'Fix:')} ${l.fix}`);
  }
}

// ---------- main ----------
async function main() {
  console.log('\nagentic-audit: compare your output before and after your AI workflow\nby Parsity, https://parsity.io/ai-dev\n');

  const repoArgs = [...positional, ...String(flags.repo || '').split(',')].map((x) => x.trim()).filter(Boolean);
  const repoAns = repoArgs.length ? repoArgs : String(await ask('Repo(s): local paths or owner/repo, comma-separated', process.cwd())).split(',').map((x) => x.trim()).filter(Boolean);
  const repos = repoAns.map(resolveRepo);

  // default authors: your configured email plus any other email used under your git name in these repos
  const myEmail = (git(['config', 'user.email'], repos[0]) || '').trim();
  const myName = (git(['config', 'user.name'], repos[0]) || '').trim();
  const emails = new Set(myEmail ? [myEmail] : []);
  if (myName) for (const r of repos) for (const l of (git(['log', '--all', '--format=%an%x1f%ae', '--since=2 years ago'], r) || '').split('\n')) {
    const [n, e] = l.split('\x1f'); if (n === myName && e) emails.add(e.trim());
  }
  const defaultEmail = [...emails].join(',');
  const authors = String(flags.author || (await ask('Your git email(s), comma-separated (add old work/personal emails too)', defaultEmail)))
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!authors.length) throw new Error('Need at least one author email');

  // suggest a cutoff: the day agent-tagged commits became a habit (3rd tagged commit in the last year)
  let suggested = null;
  if (!flags.cutoff) {
    const now0 = new Date();
    for (const r of repos) agentTags(r, authors, new Date(now0.getTime() - 365 * DAY), now0);
    // first commit after which AI-tagged commits are at least 30% of the next 4 weeks (min 5 commits)
    const ds = tagDates.sort((x, y) => x.t - y.t);
    for (let i = 0; i < ds.length && !suggested; i++) {
      if (!ds[i].ai) continue;
      const win = ds.filter((d) => d.t >= ds[i].t && d.t < ds[i].t + 28 * DAY);
      if (win.length >= 5 && win.filter((d) => d.ai).length / win.length >= 0.3) suggested = ymd(new Date(ds[i].t));
    }
    tagDates.length = 0; unknownBots.clear();
    if (suggested) console.log(`\nYour commits started carrying AI co-author tags around ${suggested}. That's a good default cutoff.`);
  }
  let cutoff = parseDate(flags.cutoff) || (!rl && suggested ? parseDate(suggested) : null);
  while (!cutoff) {
    if (!rl) throw new Error('Pass --cutoff YYYY-MM-DD (the day you switched workflows). No AI-tagged commits found to suggest one.');
    cutoff = parseDate(await ask('When did you start the new workflow? (YYYY-MM-DD)', suggested || ''));
  }
  const now = new Date();
  if (cutoff >= now) throw new Error('Cutoff has to be in the past');
  const sinceWeeks = Math.max(1, Math.floor((now - cutoff) / WEEK));
  const weeks = Math.max(1, Number(flags.weeks || (await ask('Weeks to compare on each side', Math.min(12, sinceWeeks)))));
  const after = { label: 'After', from: cutoff, to: new Date(Math.min(now.getTime(), cutoff.getTime() + weeks * WEEK)) };
  const before = { label: 'Before', from: new Date(cutoff.getTime() - weeks * WEEK), to: cutoff };
  const periods = [before, after];
  for (const p of periods) p.weeks = (p.to - p.from) / WEEK;

  // git
  process.stdout.write('\nReading git history... ');
  let commits = [];
  for (const r of repos) commits.push(...readCommits(r, authors, before.from, after.to));
  commits.sort((a, b) => a.date - b.date);
  console.log(`${commits.length} commits`);
  if (!commits.length) throw new Error('No commits found for those emails in that window. Check --author (try `git log --format=%ae | sort | uniq -c`).');

  const tags = new Map();
  for (const r of repos) for (const [k, v] of agentTags(r, authors, before.from, after.to)) tags.set(k, v);
  for (const c of commits) c.agent = tags.get(c.sha) || null;
  const reworked = rework(commits);
  const inP = (p) => commits.filter((c) => c.date >= p.from && c.date < p.to);
  const stats = periods.map((p) => summarize(inP(p), reworked, p.weeks));

  // PRs
  const ghOk = run('gh', ['auth', 'status'], repos[0]) !== null;
  let wantPrs = boolFlag('prs');
  if (wantPrs === undefined) wantPrs = ghOk ? await askYN('Pull merged PR stats with the gh CLI?', true) : false;
  let prs = null;
  if (wantPrs && ghOk) {
    process.stdout.write('Pulling merged PRs... ');
    prs = periods.map((p) => {
      const parts = repos.map((r) => prStats(r, p.from, p.to, p.weeks)).filter(Boolean);
      if (!parts.length) return null;
      return { merged: parts.reduce((s, x) => s + x.merged, 0), cycle: median(parts.flatMap((x) => x.cycleHours)), size: median(parts.flatMap((x) => x.sizes)), weeks: p.weeks };
    });
    if (prs.every((x) => x === null)) prs = null;
    console.log(prs ? 'done' : 'none found (is this a GitHub repo?)');
  } else if (wantPrs) console.log('Skipping PRs: gh CLI not installed or not logged in.');

  // tokens
  let wantTokens = boolFlag('tokens');
  if (wantTokens === undefined) wantTokens = await askYN('Read token usage from your local Claude Code / Codex logs? (stays on your machine)', true);
  let tokens = null;
  if (wantTokens) {
    process.stdout.write('Reading agent logs... ');
    tokens = tokenUsage(periods, repos);
    console.log('done');
  }

  // Jev
  const cfg = jevConfig();
  let jev = null;
  let wantJev = boolFlag('jev');
  const sampleN = Number(flags.sample || 30);
  if (wantJev === undefined) wantJev = cfg ? await askYN(`Grade up to ${sampleN} commits per period with Jev (${cfg.via})?`, true) : false;
  if (wantJev && !cfg) console.log('Skipping Jev: set TYPESAFE_API_KEY or AI_GATEWAY_API_KEY to grade commits.');
  if (wantJev && cfg) {
    const maxChars = 8000;
    const picks = periods.map((p) => sample(inP(p).filter((c) => !c.bulk), sampleN));
    const states = picks.map((list) => list.map((c) => commitState(c, maxChars)));
    const estTokens = states.flat().reduce((s, st) => s + Math.ceil(JSON.stringify(st).length / 4) + 400, 0);
    const estCost = (estTokens / 1e6) * 0.042;
    console.log(`Jev will grade ${states.flat().length} commits, about ${fmt(estTokens, 0)} tokens (~$${estCost.toFixed(4)}).`);
    if (await askYN('Go?', true)) {
      let done = 0; const total = states.flat().length;
      const results = [];
      for (const list of states) {
        results.push(await pool(list, 4, async (st) => {
          try { return await jevGrade(cfg, st); }
          catch (e) { console.warn(`\n  skipped a commit: ${e.message}`); return null; }
          finally { done++; if (process.stdout.isTTY) process.stdout.write(`\r  graded ${done}/${total}`); }
        }));
      }
      console.log('');
      jev = results.map((r, i) => jevSummary(r, stats[i].commitsPerWeek));
    }
  }

  // ---------- report ----------
  const [b, a] = stats;
  const rows = [
    ['Commits / week', b.commitsPerWeek, a.commitsPerWeek],
    ['Active days / week', b.activeDaysPerWeek, a.activeDaysPerWeek],
    ['Code lines changed / week', b.linesChangedPerWeek, a.linesChangedPerWeek, 0],
    ['Docs, data, markup lines / week', b.otherLinesPerWeek, a.otherLinesPerWeek, 0],
    ['Files touched / week', b.filesTouchedPerWeek, a.filesTouchedPerWeek],
    ['Median commit size (lines)', b.medianCommitSize, a.medianCommitSize, 0],
    ['Decision points added / week', b.decisionPointsAddedPerWeek, a.decisionPointsAddedPerWeek],
    ['Decision points per 100 lines', b.decisionPointsPer100Lines, a.decisionPointsPer100Lines],
    ['Test share of added code', b.testLineSharePct, a.testLineSharePct, 1, true],
    ['Rework (same file again <72h)', b.reworkPct, a.reworkPct, 1, true],
    ['Fix / revert commits', b.fixCommitPct, a.fixCommitPct, 1, true],
    ['Commits tagged as agent-written', b.agentCommitPct, a.agentCommitPct, 1, true],
    ['Code lines in agent-tagged commits', b.agentCodePct, a.agentCodePct, 1, true],
  ];
  if (prs) {
    const [pb, pa] = prs;
    rows.push(['Merged PRs / week', pb ? pb.merged / pb.weeks : null, pa ? pa.merged / pa.weeks : null]);
    rows.push(['Median PR cycle time (hours)', pb?.cycle ?? null, pa?.cycle ?? null]);
    rows.push(['Median PR size (lines)', pb?.size ?? null, pa?.size ?? null, 0]);
  }
  if (jev && jev[0] && jev[1]) {
    rows.push(['Avg difficulty (1-5, Jev)', jev[0].avgDifficulty, jev[1].avgDifficulty, 2]);
    rows.push(['Difficulty-weighted output / week', jev[0].weightedOutputPerWeek, jev[1].weightedOutputPerWeek]);
    rows.push(['Substantive commits', jev[0].substantivePct, jev[1].substantivePct, 1, true]);
  }
  if (tokens && tokens.res.every((r) => !r.claude && !r.codex)) tokens.none = true;
  if (tokens && !tokens.none) {
    const [tb, ta] = tokens.res;
    rows.push(['Claude Code tokens / week', tb.claude / before.weeks, ta.claude / after.weeks, 0]);
    rows.push(['  ...in these repos', tb.claudeInRepo / before.weeks, ta.claudeInRepo / after.weeks, 0]);
    if (tb.codex || ta.codex) rows.push(['Codex tokens / week', tb.codex / before.weeks, ta.codex / after.weeks, 0]);
    if (ta.claudeInRepo + ta.codex > 0 && a.commitsPerWeek > 0)
      rows.push(['Agent tokens per commit (after)', null, (ta.claudeInRepo + ta.codex) / (a.commitsPerWeek * after.weeks), 0]);
  }

  for (let i = rows.length - 1; i >= 0; i--) if (!rows[i][1] && !rows[i][2]) rows.splice(i, 1); // drop rows that are empty on both sides
  const pctCell = (v, isPct, d) => (v === null ? 'n/a' : `${fmt(v, d)}${isPct ? '%' : ''}`);
  const table = [
    '| Metric | Before | After | Change |',
    '|---|---:|---:|---:|',
    ...rows.map(([name, x, y, d = 1, isPct = false]) => `| ${name} | ${pctCell(x, isPct, d)} | ${pctCell(y, isPct, d)} | ${x === null ? '' : change(x, y, isPct)} |`),
  ].join('\n');

  // the honest read
  const notes = [];
  const up = (x, y, t = 0.1) => x > 0 && (y - x) / x > t;
  const down = (x, y, t = 0.1) => x > 0 && (x - y) / x > t;
  if (up(b.commitsPerWeek, a.commitsPerWeek) && jev?.[0] && jev?.[1] && jev[1].avgDifficulty < jev[0].avgDifficulty - 0.3)
    notes.push('More commits, but easier ones. Fine if you split work smaller on purpose. Not fine to call it more output.');
  if (up(b.decisionPointsAddedPerWeek, a.decisionPointsAddedPerWeek, 0.2) && down(b.testLineSharePct, a.testLineSharePct, 0.1))
    notes.push('You are adding branching logic faster than you are adding tests. That is where agent-written bugs hide.');
  if (a.reworkPct - b.reworkPct > 5) notes.push('Rework is up. Check whether agents are calling things done before they are.');
  if (a.fixCommitPct - b.fixCommitPct > 5) notes.push('A bigger share of your commits are fixes. Some of that may be cleaning up after the agent.');
  if (up(b.linesChangedPerWeek, a.linesChangedPerWeek, 0.25) && !up(b.filesTouchedPerWeek, a.filesTouchedPerWeek, 0.05))
    notes.push('Lines are up a lot but you are not touching more of the codebase. Look for bloat or duplicated code.');
  if (a.testLineSharePct - b.testLineSharePct > 5) notes.push('Test share is up. Good sign that you are making the agent prove its work.');
  if (jev?.[0] && jev?.[1] && jev[1].weightedOutputPerWeek > jev[0].weightedOutputPerWeek * 1.15)
    notes.push('Difficulty-weighted output is up. That is the number to bring to your manager.');
  if (b.totalCommits < 10 || a.totalCommits < 10) notes.push('Small sample on at least one side. Widen the window or add more repos/emails before drawing conclusions.');
  if (tokens?.none) notes.push('No Claude Code or Codex usage found in local logs for these dates, so token numbers are left out.');
  else if (tokens && tokens.oldest > before.from.getTime() && Number.isFinite(tokens.oldest))
    notes.push(`Agent logs only go back to ${ymd(new Date(tokens.oldest))}. Claude Code deletes local logs after 30 days by default (cleanupPeriodDays in settings.json), so "before" token numbers may be incomplete.`);
  if (unknownBots.size) {
    const top = [...unknownBots].sort((x, y) => y[1] - x[1]).slice(0, 3);
    notes.push(`Found bot co-authors this script doesn't recognize: ${top.map(([n, c]) => `${n} (${c})`).join(', ')}. If any of these is an AI agent, rerun with --agents "${top[0][0].replace(/\[bot\]$/, '')}" to count it.`);
  }
  const toolStr = (t) => Object.entries(t).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  if (a.agentCommitPct > 0 || b.agentCommitPct > 0)
    notes.push(`Agent-tagged commits went from ${fmt(b.agentCommitPct)}% to ${fmt(a.agentCommitPct)}% of your commits${Object.keys(a.agentTools).length ? ` (after: ${toolStr(a.agentTools)})` : ''}. Treat this as a floor, not the full picture.`);

  // what this report can't see, and how to fix it
  const limits = [
    {
      title: 'Agent usage only counts commits your tools signed',
      detail: 'Claude Code adds a Co-Authored-By line by default. Autocomplete, chat copy-paste, and many IDE agents leave no trace, and squash merges can drop the line.',
      fix: 'Keep co-author attribution on in Claude Code. For other tools, add a trailer yourself: git commit --trailer "AI-Assisted: cursor". Keep trailers when you squash.',
      hit: a.agentCommitPct < 5,
    },
    {
      title: 'Token history is short and local',
      detail: 'Claude Code deletes local session logs after 30 days by default, and the script only sees this machine. Usage from the web app, Cursor, or another laptop is invisible.',
      fix: 'Add "cleanupPeriodDays": 365 to ~/.claude/settings.json today so your next audit has history. For team or API spend, use the usage page in your Anthropic Console.',
      hit: !tokens || tokens.none || (Number.isFinite(tokens.oldest) && tokens.oldest > before.from.getTime()),
    },
    {
      title: 'Tokens are not dollars',
      detail: 'Cached reads are counted at full volume but cost about a tenth as much. On a Pro or Max plan you pay a flat rate, not per token.',
      fix: 'Read token numbers as a relative trend. For real cost, check your billing page.',
      hit: !!tokens && !tokens.none,
    },
    {
      title: 'Commits under other emails are missed',
      detail: 'If you commit from a work laptop, a personal laptop, and an agent, those can all be different git identities.',
      fix: "Run git log --format='%ae' | sort | uniq -c and pass every email you use with --author.",
      hit: authors.length < 2,
    },
    {
      title: 'Commit counts depend on how you merge',
      detail: 'Squash merges turn a day of work into one commit. Rebases can move commit dates.',
      fix: 'Turn on the PR view (--prs, needs the gh CLI) to compare merged PRs instead.',
      hit: !prs,
    },
    {
      title: 'Difficulty grading is off',
      detail: 'Without it, throughput only tells you that you shipped more, not that you shipped harder things.',
      fix: 'Set TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY) and rerun. A typical run costs well under a dollar.',
      hit: !jev,
    },
    {
      title: 'Lines and commits are easy to game',
      detail: 'An agent can triple your line count with bloated code, and anyone can triple commits by splitting work smaller.',
      fix: 'Never quote throughput alone. Pair it with rework, test share and difficulty, which is why they sit side by side here.',
      hit: false,
    },
  ];
  if (!notes.length) notes.push('No big red flags. If the numbers are flat, the workflow change is not paying off yet.');

  const kindMix = jev?.[0] && jev?.[1]
    ? `\n## What kind of work\n\n| Kind | Before | After |\n|---|---:|---:|\n${[...new Set([...Object.keys(jev[0].kindMix), ...Object.keys(jev[1].kindMix)])]
        .map((k) => `| ${k} | ${fmt(jev[0].kindMix[k] || 0)}% | ${fmt(jev[1].kindMix[k] || 0)}% |`).join('\n')}\n`
    : '';

  const md = `# Agentic Workflow Audit

**Repos:** ${repos.map((r) => repoLabels.get(r) || path.basename(r)).join(', ')}
**Author:** ${authors.join(', ')}
**Before:** ${ymd(before.from)} to ${ymd(new Date(before.to - 1))} (${fmt(before.weeks)} weeks, ${b.totalCommits} commits)
**After:** ${ymd(after.from)} to ${ymd(new Date(after.to - 1))} (${fmt(after.weeks)} weeks, ${a.totalCommits} commits)

${table}
${kindMix}
## The honest read

${notes.map((n) => `- ${n}`).join('\n')}

## What this can't see

${limits.map((l) => `- **${l.title}**${l.hit ? ' _(affects this report)_' : ''}. ${l.detail} **Fix:** ${l.fix}`).join('\n')}

## How these are measured

- Everything is per week so uneven windows compare fairly. Merge commits, lockfiles, build output and vendored code are ignored.\n- Code metrics (lines, decision points, test share) only count source code files. Markdown, JSON, HTML and other content are counted separately.
- Commits over ${BULK_LINES} changed lines are treated as bulk (codegen, moves, vendoring) and left out of line and complexity numbers. Excluded: ${b.bulkCommitsExcluded} before, ${a.bulkCommitsExcluded} after.
- **Decision points** count \`if\`, loops, \`case\`, \`catch\`, \`&&\`, \`||\` and ternaries in added minus removed lines. A rough, language-agnostic proxy for cyclomatic complexity.
- **Rework** is the share of file touches where you touched the same file again within 72 hours.
- **Agent-tagged commits** are commits whose author or trailers (Co-Authored-By, AI-Assisted, Generated with) name an AI tool.
${jev ? `- **Difficulty** comes from Jev (TypeSafe) grading ${jev[0]?.graded ?? 0} before and ${jev[1]?.graded ?? 0} after commits, sampled evenly across each window. Difficulty-weighted output = commits per week x average difficulty.\n` : ''}- Lines of code and commit counts are easy to game. Read them next to rework, fixes, tests and difficulty, never alone.

_Generated ${new Date().toISOString()} by agentic-audit, a before/after audit of your AI workflow. Built by [Parsity](https://parsity.io/ai-dev)._
`;

  const outDir = path.resolve(flags.out || process.cwd());
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, 'agentic-audit-report.md');
  fs.writeFileSync(mdPath, md);
  const meta = [
    ['Repos', repos.map((r) => repoLabels.get(r) || path.basename(r)).join(', ')],
    ['Author', authors.join(', ')],
    ['Before', `${ymd(before.from)} to ${ymd(new Date(before.to - 1))}, ${b.totalCommits} commits`],
    ['After', `${ymd(after.from)} to ${ymd(new Date(after.to - 1))}, ${a.totalCommits} commits`],
  ];
  const methodology = md.split('## How these are measured')[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).replace(/\*\*|`/g, ''));
  const kindRows = jev?.[0] && jev?.[1] ? [...new Set([...Object.keys(jev[0].kindMix), ...Object.keys(jev[1].kindMix)])].map((k) => [k, jev[0].kindMix[k] || 0, jev[1].kindMix[k] || 0]) : null;
  const htmlPath = path.join(outDir, 'agentic-audit-report.html');
  fs.writeFileSync(htmlPath, renderHtml({ rows, notes, kindMix: kindRows, meta: meta.slice(0, 4), methodology, limits }));
  fs.writeFileSync(path.join(outDir, 'agentic-audit-report.json'), JSON.stringify({ repos, authors, periods: periods.map((p) => ({ label: p.label, from: p.from, to: p.to, weeks: p.weeks })), git: stats, prs, tokens: tokens?.res ?? null, jev, notes }, null, 2));

  printTerminal(rows, notes, meta, limits);
  console.log(`\n  Report: ${htmlPath}\n  Also saved as markdown and JSON next to it.\n`);
  if (process.stdout.isTTY && !flags['no-open']) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawnSync(opener, [htmlPath], { stdio: 'ignore' });
  }
}

main()
  .catch((e) => { console.error(`\nError: ${e.message}`); process.exitCode = 1; })
  .finally(() => rl?.close());
