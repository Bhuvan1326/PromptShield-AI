# Credential Remediation — Owner Checklist

**Incident**: commit `166dee412053a100b71f4a987bcc796fbd6f7b98` contains a
likely-live Google API key in `.env.example`. Reachable only via local branch
`backup-before-secret-cleanup` (tip `236ed1d`), 0 reachable from `origin/main`.
**Credential value is never reproduced in this repository or tooling.**

## Verified scope (as of this audit)

- `git branch --contains 166dee4` → only `backup-before-secret-cleanup` (local).
- `git branch -r --contains 166dee4` → none (not on origin).
- `scripts/secret-scan.mjs` on the tracked working tree → **0 findings**.
- Risk: anyone holding a clone of the old repo or the local backup branch can
  reach it. The key must be treated as compromised regardless.

## Step 1 — Rotate/revoke FIRST (before any history work)

1. Google Cloud Console → APIs & Services → Credentials → locate the key →
   **Delete** (or regenerate). If usage shows unexpected calls, treat as
   confirmed compromise.
2. Verify the old key returns 401/403 on a Gemini request.
3. Rotate `GEMINI_API_KEY` in `.env` and Render env vars if they share the
   exposed value.
4. If `PS_API_TOKEN`/`PS_ADMIN_TOKEN` were ever committed anywhere, rotate too.

## Step 2 — History purge (only AFTER rotation is confirmed)

```bash
# Delete the local backup branch (the only live ref reaching the commit)
git branch -D backup-before-secret-cleanup

# Expire reflog entries that still reference the commit, then collect garbage
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

Then force-push is NOT needed if the commit never reached origin (verified
above — confirm again before proceeding). If it WAS ever pushed, additionally:
remove it via `git filter-repo`/`filter-branch`, force-push, and have any
forks/clones purge their copies.

## Step 3 — Verify purge

```bash
git rev-list --all | grep -c 166dee4          # must be 0
git log --all --oneline | grep -c 166dee      # must be 0
git fsck --unreachable 2>&1 | grep 166dee     # nothing reachable
```

## Step 4 — Prevent recurrence

- `scripts/secret-scan.mjs` runs in CI (added to the workflow).
- `.env` is gitignored; `.env.example` must contain placeholders only.
- Consider a pre-commit hook: `npx gitleaks protect` or `node scripts/secret-scan.mjs`.

**Status: OPEN — rotation unconfirmed. This limitation is not closed until
steps 1–3 are owner-verified.**
