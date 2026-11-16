# educ_sector_follow_up_2

Follow-up 2 stage of the education-sector lead sequence for James Castrission's mailbox. Sibling of `../educ_sector_follow_up_sequence` (follow-up 1). Supabase project `MAGTestProject` (ref `aivitcomiywiysrfwqxt`).

## Layout
- `prompts/` — dated task specs (`DDMMYY_name.txt`) that drive each piece of work.
- `chase_messages/followup_2.html` — email body (includes signature).
- `supabase/functions/<fn>/index.ts` + `supabase/functions/_shared/` — Deno edge functions.

## Conventions / gotchas
- **Never truncate; upsert/in-place update only** (global rule). Status changes are guarded `UPDATE ... WHERE status = '<from>'`.
- Status flow: `2B` (follow-up 1 sent) -> `3A` (follow-up 2 drafted, `draft_id` set) -> `3B` (sent, `followup_2_date_sent` stamped).
- `educ-draft-followup-2` drafts only, then chains `educ-send-followup-2` as its last step. **`educ-send-followup-2` sends real email** as james@.
- Both use an 8-day aging window (`created_at <= now() - 8 days`); override with `?aged_days=`.
- Auth: `verify_jwt=false`, guarded by `?token=` == `PUSH_SHARED_SECRET`. Chaining passes the token in the URL, no auth header.
- `_shared/chase2.ts` is **generated** from `followup_2.html` (strip Gmail wrapper from the first `<div dir="ltr">`, drop 2 trailing `</div>`, JSON-encode via `[IO.File]::ReadAllText` + `ConvertTo-Json`). Don't hand-edit.
- Deploy via Supabase MCP `deploy_edge_function` with files `index.ts` plus `../_shared/*.ts`; each function bundles its own `_shared` copy, so include `chase2.ts` for the drafter or the bundle fails.
- Safe test: `?dry=1&aged_days=0&limit=N` (no drafts, no sends, no status changes; dry propagates to the send pass). Runs log to `educ_router_runs`.
- Leads missing `email`/`thread_id` (draft) or `draft_id` (send) are skipped.
- User rule for these tasks: do not invoke the functions after creating/updating them unless asked.
