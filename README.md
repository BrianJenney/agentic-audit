# agentic-audit

Is your AI workflow actually making you ship more, or just making you feel busy?

Pick the date you changed how you work. This script compares the weeks before it to the weeks after it, using your own git history. You get a one-page report you can bring to your manager.

## Run it

You need Node 20 or newer. Nothing to install. From inside any git repo:

```bash
npx github:BrianJenney/agentic-audit
```

Or grab the single file and run it:

```bash
curl -O https://raw.githubusercontent.com/BrianJenney/agentic-audit/main/agentic-audit.mjs
node agentic-audit.mjs
```

It asks you a few questions:

1. Which repos (default: the one you're in)
2. Your git email(s). It pre-fills every email you've committed under with your git name.
3. The date you started the new workflow. It suggests one from when your commits started carrying AI co-author tags.
4. How many weeks to compare on each side
5. Whether to pull PR stats (needs the `gh` CLI)
6. Whether to read token usage from your local Claude Code / Codex logs
7. Whether to grade commits with Jev (optional, see below)

Prefer flags? `node agentic-audit.mjs --help`

## What you get

An HTML report that opens in your browser (plus markdown and JSON copies), with before vs. after for:

- **Throughput:** commits, active days, lines changed, files touched, merged PRs, PR cycle time
- **Complexity:** decision points added (ifs, loops, catches, `&&`, `||`). A rough stand-in for cyclomatic complexity.
- **Quality:** test share of new code, rework (same file touched again within 72 hours), fix and revert commits
- **Agent usage:** share of commits and code your AI tools signed in git (Co-Authored-By, AI-Assisted and similar trailers). Works for any date, no logs needed.
- **Cost:** Claude Code and Codex tokens per week, and tokens per commit
- **Difficulty (optional):** how hard the work actually was, graded per commit

Then a short "honest read" that flags the stuff people don't want to see. More commits but easier ones. Branching logic growing faster than tests. Rework going up.

## Why not just count commits?

Because anyone can 3x their commit count by splitting work smaller, and anyone can 3x their lines by letting an agent write bloated code. Throughput only means something next to rework, tests and difficulty. The script shows them side by side on purpose.

## Optional: difficulty grading with Jev

Jev is a small decision model from TypeSafe. It doesn't write text, it just answers typed questions, which makes it fast and very cheap for grading. The script samples up to 30 commits per period and asks Jev three things about each one: how hard was it (1 to 5), what kind of change was it, and would a reviewer have to actually think about it.

A typical run is a few hundred thousand tokens at most, which is well under a dollar. The script shows you the estimate and asks before it spends anything.

Set one of these:

```bash
export TYPESAFE_API_KEY=...        # from console.typesafe.ai
# or
export AI_GATEWAY_API_KEY=...      # Vercel AI Gateway, model typesafe-ai/jev
```

No key? It skips this part and everything else still works.

## Privacy

Everything runs on your machine. Git history and agent logs never leave it. The only thing sent anywhere is the sampled commit diffs to Jev, and only if you turn that on.

## What it can't see (and how to fix it)

The report has a section for this and flags which gaps affect your run. The short version:

| Blind spot | Fix |
|---|---|
| Agent usage only counts commits your tools signed. Autocomplete and copy-paste leave no trace. | Keep co-author attribution on in Claude Code. For other tools: `git commit --trailer "AI-Assisted: cursor"` |
| Claude Code deletes local logs after 30 days, and only this machine is visible. | Add `"cleanupPeriodDays": 365` to `~/.claude/settings.json` today. Use the Anthropic Console for team or API spend. |
| Tokens are not dollars. Cached reads are cheap, and subscriptions are flat rate. | Read tokens as a trend. Check billing for real cost. |
| Your company's internal agent isn't recognized. | The report lists unknown bot co-authors. Rerun with `--agents "your-bot-name"`. |
| Commits under other emails are missed. | `git log --format='%ae' \| sort \| uniq -c`, then pass every email with `--author`. |
| Squash merges and rebases distort commit counts. | Add `--prs` to compare merged PRs instead. |
| Without Jev there's no difficulty score. | Set `TYPESAFE_API_KEY` and rerun. |

## Caveats

- Codex token reading is best effort. Its log format changes.
- Lockfiles, build output, vendored code and commits over 3,000 lines are ignored so a big codegen dump doesn't skew things.
- Small samples lie. If you have fewer than 10 commits on either side, widen the window.
