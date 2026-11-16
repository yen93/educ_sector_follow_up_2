// educ-draft-followup-2 — draft Follow-up 2 to education-sector leads whose
// Follow-up 1 has already been sent (status '2B'), as a REPLY inside each lead's
// existing email thread. DRAFTS ONLY — this function never sends.
//
// to_process:  public.manually_found_educ_leads
//                 WHERE status = '2B'
//                   AND created_at <= now() - interval '8 days'   (aged >= 8 days)
//
// For every such lead that has an email + thread_id it:
//   1. creates a Follow-up 2 draft (chase_messages/followup_2.html with
//      [firstname] substituted — see _shared/chase2.ts) as a reply in the lead's
//      thread (thread_id), threaded via In-Reply-To / References.
//   2. sets status = '3A' and draft_id = the new draft id, guarded by status='2B'.
//
// Unlike educ-draft-followup-1 (which also SENDS), this mirrors the rest of the
// educ draft pipeline: it only creates drafts — then, as its final step, it chains
// educ-send-followup-2 to send them (see triggerSend). followup_2_date_sent is
// stamped by the send pass, not here.
//
// Idempotent: it picks only '2B' rows and flips each to '3A' guarded by a
// status='2B' check, so a re-run never double-drafts a lead already advanced. A
// lead whose draft fails stays '2B' and is retried next run. Leads with no email
// or no thread_id are skipped (left '2B').
//
// Query params:
//   ?token=<PUSH_SHARED_SECRET>  required (verify_jwt=false; same secret as the
//                                other educ routers)
//   ?dry=1                       report what WOULD happen; create no drafts, make
//                                no status changes (propagated to the send pass)
//   ?limit=<n>                   cap leads processed this run (default 200)
//   ?aged_days=<n>               override the 8-day aging window (default 8).
//                                Mainly for dry-run testing (?dry=1&aged_days=0).

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import { createDraft, getProfileEmail, getThread, header, lastMessage } from "../_shared/gmail.ts";
import { fillChase2 } from "../_shared/chase2.ts";
import { buildReply } from "../_shared/mime.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const AGED_DAYS = 8;
const DRAFT_FROM_STATUS = "2B";
const DRAFTED_STATUS = "3A";
const DEFAULT_LIMIT = 200;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface Lead {
  id: number;
  email: string | null;
  firstname: string | null;
  thread_id: string | null;
  status: string | null;
  created_at: string;
}

Deno.serve(async (req) => {
  // --- authenticate ---------------------------------------------------------
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== Deno.env.get("PUSH_SHARED_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const dry = url.searchParams.get("dry") === "1";
  const limit = Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT);
  const agedDaysParam = url.searchParams.get("aged_days");
  const agedDays = agedDaysParam !== null && agedDaysParam !== "" && !Number.isNaN(Number(agedDaysParam))
    ? Number(agedDaysParam)
    : AGED_DAYS;

  const summary = {
    dry,
    scanned: 0, // leads matching the to_process query (status='2B')
    drafted: 0, // drafts created (status set to 3A)
    skipped: 0, // missing email/thread_id, or lost the 2B transition
    errors: 0,
  };
  // deno-lint-ignore no-explicit-any
  const details: any[] = [];

  try {
    const agedBefore = new Date(Date.now() - agedDays * 86_400_000).toISOString();

    // --- to_process: status='2B' AND created_at <= now() - interval '8 days' ---
    const { data, error } = await sb
      .from("manually_found_educ_leads")
      .select("id,email,firstname,thread_id,status,created_at")
      .eq("status", DRAFT_FROM_STATUS)
      .lte("created_at", agedBefore)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    const leads = (data ?? []) as Lead[];
    summary.scanned = leads.length;

    if (!leads.length) {
      await logRun(summary, details);
      // Still chain the send pass: there may be '3A' leads left to send.
      const send = await triggerSend({ dry, agedDays, limit });
      return json({ ...summary, send });
    }

    const token = await getGmailAccessToken();
    const fromAddr = await getProfileEmail(token);

    // ===================== draft (2B -> 3A) =====================
    for (const lead of leads) {
      const email = (lead.email ?? "").trim();
      const threadId = (lead.thread_id ?? "").trim();

      // Can't draft a threaded reply without a recipient and a thread.
      if (!email || !threadId) {
        summary.skipped++;
        details.push({ id: lead.id, email: lead.email, skipped: !email ? "no email" : "no thread_id" });
        continue;
      }

      try {
        // Thread context -> reply subject + threading headers.
        const thread = await getThread(token, threadId);
        const last = lastMessage(thread);
        if (!last) {
          summary.skipped++;
          details.push({ id: lead.id, email, skipped: "empty/invalid thread" });
          continue;
        }

        const subject = header(last, "Subject") || "Following up";
        const inReplyTo = header(last, "Message-ID");
        const references = `${header(last, "References")} ${inReplyTo}`.trim();

        const raw = buildReply({
          from: fromAddr,
          to: email,
          subject,
          inReplyTo,
          references,
          body: fillChase2(lead.firstname), // [firstname] <- manually_found_educ_leads.firstname
        });

        if (dry) {
          summary.drafted++;
          details.push({
            id: lead.id,
            email,
            firstname: lead.firstname,
            threadId,
            subject: /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`,
            would: "create draft + set status=3A",
          });
          continue;
        }

        // Create the draft in the existing thread.
        const draft = await createDraft(token, raw, threadId);
        const draftId: string = draft?.id;
        if (!draftId) throw new Error("drafts.create returned no id");

        // Mark the lead: status=3A + draft_id. Guarded by status='2B' so a
        // concurrent/duplicate run can't flip it twice.
        const { data: upd, error: updErr } = await sb
          .from("manually_found_educ_leads")
          .update({ status: DRAFTED_STATUS, draft_id: draftId })
          .eq("id", lead.id)
          .eq("status", DRAFT_FROM_STATUS)
          .select("id");
        if (updErr) throw updErr;
        if (!upd?.length) {
          // Row was no longer '2B' (already handled). Draft exists but we didn't
          // own the transition — count as skipped, not drafted.
          summary.skipped++;
          details.push({ id: lead.id, email, draftId, note: "status was not 2B at update; not re-counted" });
          continue;
        }

        summary.drafted++;
        details.push({ id: lead.id, email, firstname: lead.firstname, threadId, draftId, status: DRAFTED_STATUS });
      } catch (perLead) {
        summary.errors++;
        console.error(`followup-2 draft failed for lead ${lead.id} (${email}):`, perLead);
        details.push({ id: lead.id, email, error: String(perLead) });
        // Left at '2B' -> retried next run.
      }
    }

    await logRun(summary, details);
    console.log("educ-draft-followup-2 run:", JSON.stringify(summary));

    // --- final step: chain the send pass (educ-send-followup-2) --------------
    // It picks up the '3A' drafts this run just created (same 8-day window) and
    // sends them -> '3B'. dry/aged_days/limit are propagated so a dry draft run
    // triggers a dry send run (no email, no status changes). A failure here is
    // logged but does not fail the draft pass (drafts stay '3A', sendable later).
    const send = await triggerSend({ dry, agedDays, limit });

    return json({ ...summary, send });
  } catch (e) {
    summary.errors++;
    console.error("handler error:", e);
    await logRun(summary, details, String(e)).catch(() => {});
    return json({ ...summary, error: String(e) }, 500);
  }
});

// Record the run in educ_router_runs (shared with the other educ routers).
// Column mapping: moved <- drafts created; leads_updated unused here (0; nothing
// is sent in this function); bounced unused (0).
// deno-lint-ignore no-explicit-any
function logRun(summary: any, details: any[], error?: string) {
  return sb.from("educ_router_runs").insert({
    router: summary.dry ? "draft-followup-2 (dry)" : "draft-followup-2",
    scanned: summary.scanned,
    bounced: 0,
    moved: summary.drafted,
    leads_updated: 0,
    errors: summary.errors,
    detail: {
      skipped: summary.skipped,
      drafted: summary.drafted,
      ...(error ? { error } : {}),
      items: details,
    },
  });
}

// Invoke educ-send-followup-2 (the Follow-up 2 send pass) on the same project.
// Mirrors the educ cron convention: token in the query string, no auth header
// (the target runs with verify_jwt=false). Returns its JSON summary, or an
// error object if the call itself failed — never throws.
async function triggerSend(opts: { dry: boolean; agedDays: number; limit: number }) {
  try {
    const base = Deno.env.get("SUPABASE_URL")!;
    const sendUrl = new URL(`${base}/functions/v1/educ-send-followup-2`);
    sendUrl.searchParams.set("token", Deno.env.get("PUSH_SHARED_SECRET") ?? "");
    if (opts.dry) sendUrl.searchParams.set("dry", "1");
    sendUrl.searchParams.set("aged_days", String(opts.agedDays));
    sendUrl.searchParams.set("limit", String(opts.limit));

    const res = await fetch(sendUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await res.json().catch(() => ({ status: res.status }));
    if (!res.ok) return { ok: false, status: res.status, body };
    return body;
  } catch (e) {
    console.error("triggerSend (educ-send-followup-2) failed:", e);
    return { ok: false, error: String(e) };
  }
}

// deno-lint-ignore no-explicit-any
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
