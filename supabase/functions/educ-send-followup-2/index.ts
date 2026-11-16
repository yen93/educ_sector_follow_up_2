// educ-send-followup-2 — send the Follow-up 2 drafts that educ-draft-followup-2
// created, in-thread, and advance each lead. SENDS email as james@.
//
// query_drafts:  public.manually_found_educ_leads
//                  WHERE status = '3A'
//                    AND created_at <= now() - interval '8 days'   (aged >= 8 days)
//
// For every such lead that has a stored draft_id it:
//   1. sends that draft (drafts.send on draft_id — Gmail keeps it in its thread
//      and deletes the draft after send),
//   2. sets status = '3B',
//   3. stamps followup_2_date_sent = now().
// The status/date update is guarded by status='3A' so a re-run can't double-flip,
// and because Gmail deletes a draft once sent, a draft can't be sent twice.
//
// This is the send half of the Follow-up 2 step. educ-draft-followup-2 calls it
// as its final step, so a lead flows 2B -> 3A (drafted) -> 3B (sent) in one pass;
// it can also be invoked on its own to flush any leads left at 3A.
//
// A lead with no draft_id is skipped (nothing to send; left 3A). A lead whose
// send fails stays 3A with its draft intact and is retried next run.
//
// Query params:
//   ?token=<PUSH_SHARED_SECRET>  required (verify_jwt=false; same secret as the
//                                other educ routers)
//   ?dry=1                       report what WOULD send; send nothing, make no
//                                status changes
//   ?limit=<n>                   cap leads processed this run (default 200)
//   ?aged_days=<n>               override the 8-day aging window (default 8).
//                                Mainly for dry-run testing (?dry=1&aged_days=0).

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import { sendDraft } from "../_shared/gmail.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const AGED_DAYS = 8;
const SEND_FROM_STATUS = "3A";
const SENT_STATUS = "3B";
const DEFAULT_LIMIT = 200;

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface Lead {
  id: number;
  email: string | null;
  firstname: string | null;
  draft_id: string | null;
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
    scanned: 0, // leads matching the query_drafts query (status='3A')
    sent: 0, // drafts sent (status set to 3B)
    skipped: 0, // missing draft_id, or lost the 3A transition
    errors: 0,
  };
  // deno-lint-ignore no-explicit-any
  const details: any[] = [];

  try {
    const agedBefore = new Date(Date.now() - agedDays * 86_400_000).toISOString();

    // --- query_drafts: status='3A' AND created_at <= now() - interval '8 days' ---
    const { data, error } = await sb
      .from("manually_found_educ_leads")
      .select("id,email,firstname,draft_id,status,created_at")
      .eq("status", SEND_FROM_STATUS)
      .lte("created_at", agedBefore)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    const leads = (data ?? []) as Lead[];
    summary.scanned = leads.length;

    if (!leads.length) {
      await logRun(summary, details);
      return json(summary);
    }

    const token = await getGmailAccessToken();

    // ===================== send (3A -> 3B) =====================
    for (const lead of leads) {
      const draftId = (lead.draft_id ?? "").trim();

      // Nothing to send without the stored draft id.
      if (!draftId) {
        summary.skipped++;
        details.push({ id: lead.id, email: lead.email, skipped: "no draft_id" });
        continue;
      }

      try {
        if (dry) {
          summary.sent++;
          details.push({
            id: lead.id,
            email: lead.email,
            draftId,
            would: "send draft + set status=3B + followup_2_date_sent",
          });
          continue;
        }

        // Send the draft (stays in its thread; Gmail removes the draft after send).
        await sendDraft(token, draftId);

        // Advance: status=3B + followup_2_date_sent. Guarded by status='3A'.
        const nowIso = new Date().toISOString();
        const { data: upd, error: updErr } = await sb
          .from("manually_found_educ_leads")
          .update({ status: SENT_STATUS, followup_2_date_sent: nowIso })
          .eq("id", lead.id)
          .eq("status", SEND_FROM_STATUS)
          .select("id");
        if (updErr) throw updErr;
        if (!upd?.length) {
          // Email went out, but the row was no longer '3A' at update time.
          summary.sent++;
          details.push({ id: lead.id, email: lead.email, draftId, note: "sent; status was not 3A at update (not re-flipped)" });
          continue;
        }

        summary.sent++;
        details.push({ id: lead.id, email: lead.email, draftId, status: SENT_STATUS, followup_2_date_sent: nowIso });
      } catch (perLead) {
        summary.errors++;
        console.error(`followup-2 send failed for lead ${lead.id} (${lead.email}):`, perLead);
        details.push({ id: lead.id, email: lead.email, error: String(perLead) });
        // Left at '3A' with draft_id intact -> retried next run.
      }
    }

    await logRun(summary, details);
    console.log("educ-send-followup-2 run:", JSON.stringify(summary));
    return json(summary);
  } catch (e) {
    summary.errors++;
    console.error("handler error:", e);
    await logRun(summary, details, String(e)).catch(() => {});
    return json({ ...summary, error: String(e) }, 500);
  }
});

// Record the run in educ_router_runs (shared with the other educ routers).
// Column mapping: leads_updated <- drafts sent (rows advanced to 3B); moved and
// bounced are unused here (0).
// deno-lint-ignore no-explicit-any
function logRun(summary: any, details: any[], error?: string) {
  return sb.from("educ_router_runs").insert({
    router: summary.dry ? "send-followup-2 (dry)" : "send-followup-2",
    scanned: summary.scanned,
    bounced: 0,
    moved: 0,
    leads_updated: summary.dry ? 0 : summary.sent,
    errors: summary.errors,
    detail: {
      skipped: summary.skipped,
      sent: summary.sent,
      ...(error ? { error } : {}),
      items: details,
    },
  });
}

// deno-lint-ignore no-explicit-any
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
