# Reviewing large files and diffs

Large artifacts need a review procedure, not a larger prompt. A 12,000-line
file can fit within a model's context window and still exceed a client, tool,
transport, or provider limit. Claude Workflow keeps those failures visible and
supports bounded inspection without treating truncated output as complete.

## Limits that matter

Several independent limits apply to one review:

- Claude Code can reject an oversized Read result before the gateway receives
  it. Line count, token count, and a dense single line can each trigger this.
- The gateway accepts JSON request bodies up to 32 MiB. This is separate from
  provider context limits and can bind first for unusually large tool results.
- Generic Codex tool output may be shortened before it enters model history.
  An omission marker identifies an unseen gap; it is not a continuation cursor.
- For a matching Claude `Read` result, the gateway validates Claude Code's
  immediately adjacent partial-view notice and forwards only a contiguous
  numbered prefix no larger than 36,000 UTF-8 bytes. It adds machine-readable
  coverage metadata with the exact next 1-based offset. A malformed or
  mismatched notice produces no coverage claim.
- The Codex CLI 0.171.0 bundled catalog declares a 10,000-token function-output policy.
  A single 12,000-line result can therefore be shortened independently of the
  overall context window.
- A context window counts the complete conversation, including system
  instructions, tool schemas, prior turns, tool results, reasoning, and output
  headroom. The source or diff gets only part of that budget.
- Codex CLI 0.171.0's bundled GPT-6.2 Astra model advertises a 272,000-token standard window and an
  872,000-token maximum through the installed app-server catalog. Codex reserves
  part of that window, leaving 258,400 usable tokens in `standard` mode or
  828,400 in `long` mode. Claude Workflow uses `long` by default and passes the
  exact catalog values to both Codex and Claude Code; it does not claim a literal
  1,000,000-token Codex window.
- Kimi K3 supports up to 1,048,576 context tokens on Allegretto and higher
  plans. Kimi Code separately rejects total message content above 2,097,152
  bytes, so the byte limit can bind first. See Kimi's
  [model reference](https://www.kimi.com/code/docs/en/kimi-code/models.html) and
  [error reference](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html).
- Qwen 3.8 Max has a 1,000,000-token total context window, a safe
  983,616-token thinking-mode input ceiling, and a 131,072-token answer cap.
  With the default Astra agents, Claude Code exposes the smaller shared
  custom-model maximum of 828,400 tokens. Qwen's `xhigh` setting can use up to
  262,144 thinking tokens, so a large review still needs room for reasoning,
  tools, and the final report.

Kimi Code does not document an Anthropic-compatible token-count endpoint. For
Kimi routes, the gateway answers Claude Code's count request locally with a
conservative ceiling of one estimated token per UTF-8 byte. This is a
deliberately early compaction signal, not an exact provider token count.

The Qwen Token Plan route uses the same conservative local byte ceiling;
Alibaba does not expose a compatible count endpoint for this workflow. The
count makes no provider call and must not be treated as a tokenizer or billing
count.

## Gateway guarantees

Claude Workflow applies the following rules:

1. A tool result that matches a pending Codex tool call continues that call. A
   large raw result does not silently move to an unrelated thread.
2. Omitted content is marked as an unreviewed gap. The gateway never presents a
   head-and-tail preview as full coverage.
3. Read arguments retain Claude Code's 1-based source-line semantics. A verified
   result carries its contiguous covered range and exact next offset. The
   gateway never advances beyond the last numbered source line it actually
   forwarded.
4. Claude's adjacent partial-view notice remains transient. It does not become
   a persistent Codex developer instruction or change thread identity. If a
   thread must be rebuilt after eviction or recovery, historical Read results
   pass through the same contiguous paging check before replay.
5. The routed agent receives guidance to inventory large diffs, index hunks,
   inspect bounded ranges, and report gaps.
6. A shared daemon records its loaded revision. `start` or `reconcile` replaces
   a stale running daemon when installed code, effective user configuration, or
   the selected Node.js or Codex executable changes.
7. Every workflow Codex thread disables optional native execution environments
   and integrations. Repository reads, writes, searches, and shell commands
   use Claude-provided dynamic tools. The same
   boundary applies to per-session and shared gateways.
   A private catalog snapshot suppresses native async-question and clock tools
   that model metadata enables independently of feature flags. Experimental
   Codex context management is disabled so Claude owns the conversation tools.
8. A dense single line, malformed partial notice, path mismatch, or noncontiguous
   numbered result fails closed and recommends a smaller Read, targeted Grep,
   or byte/character query without claiming source coverage.
9. Qwen tool-result translation does not add a gateway byte cap. Contract tests
   carry a 12,000-line result through the continuation unchanged, but Claude's
   own Read paging and the provider's context limits still apply.

These guarantees prevent silent loss. They do not prove that every line was
reviewed; coverage still has to be recorded.

## Review a large diff

1. Define the review scope and inventory it before reading. For all tracked
   staged and unstaged changes relative to `HEAD`, plus untracked paths:

   ```bash
   git status --short
   git diff HEAD --stat
   git diff HEAD --numstat
   git diff HEAD --name-status
   git ls-files --others --exclude-standard
   ```

   A path list does not cover an untracked file's contents. Add each untracked
   file to the manifest and inspect it directly. In a repository without a
   `HEAD` commit, inventory `git diff --cached` and `git diff` separately.
   For a committed branch or pull request, record immutable base and head SHAs,
   then use one documented comparison consistently, such as
   `<merge-base>..HEAD`.

2. Create a stable `git diff HEAD` snapshot when the worktree may change during
   review. Record its digest, then index its `diff --git` and `@@` lines with
   `rg -n`. Snapshot and hash each untracked file separately. Keep the full
   artifacts outside the conversation.
3. Maintain a coverage manifest with the snapshot digest, every hunk in scope,
   the ranges inspected, checks run, and any explicit exclusions or gaps.
4. Read bounded context around each hunk. If output is truncated, narrow the
   range and repeat; never advance across an omission marker.
5. Make localized changes with the edit or patch tool available in the current
   mode. For a mechanical near-total rewrite, use an idempotent transform or
   formatter, then inspect the resulting diff again.
6. Re-run the inventory after editing. Review new or changed hunks, run scoped
   tests, and record the results in the manifest.

A head-and-tail preview, summary, digest, or passing test can support a review.
None of them proves that an uninspected middle section is correct.

## Review a large file

1. Locate symbols or facts with `rg -n` or Grep before reading.
2. Use explicit, bounded 1-based Read ranges and verify the returned source-line
   numbers.
3. Track reviewed ranges and merge overlaps. Do not claim whole-file coverage
   while any in-scope interval remains unreviewed.
4. For minified or generated single-line content, query the structure instead
   of paginating by line. Use `jq` for JSON, an appropriate parser for tabular
   or structured data, or exact byte/character ranges for raw text.
5. Validate findings against the same file revision. If the file changes,
   invalidate the affected ranges and review them again.

## Continue in a new session

Start a new session before conversation history reaches a provider limit. Carry
forward only a concise handoff containing:

- the repository state or snapshot digest;
- the coverage manifest;
- decisions and open questions;
- commands and test results; and
- stable paths, hunk identifiers, or source ranges for the next step.

Do not paste the omitted artifact into the handoff. Retrieve each remaining
range from the repository or saved snapshot in the new session.

## Completion rule

A large-file or large-diff review is complete only when every item in scope has
recorded coverage and every omission is either resolved or reported as a gap.
If the available tools cannot inspect a range, stop and say so rather than
inferring what the missing content contains.
