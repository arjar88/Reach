import { and, eq } from "drizzle-orm";
import { forOrg } from "../../../../../shared/db/scope.js";
import { agents, companyProfiles, signals } from "../../../../../shared/db/schema.js";
import { requireOrg } from "../org.js";
import { Shell, buttonStyle, fieldStyle, inputStyle } from "../shell.js";
import { analyzeWebsite, confirmOnboarding, latestJobs, requestPreview, requestResolveNames, saveOnboardingDraft } from "./actions.js";
import { JobPoller } from "./job-poller.js";

function text(values: string[] | null | undefined): string {
  return (values ?? []).join("\n");
}

export default async function OnboardingPage() {
  const { db, orgId } = await requireOrg();
  const [profile] = await db.select().from(companyProfiles).where(forOrg(orgId, companyProfiles.orgId)).limit(1);
  const [agent] = await db.select().from(agents).where(forOrg(orgId, agents.orgId)).limit(1);
  const watched = agent
    ? await db.select().from(signals).where(and(forOrg(orgId, signals.orgId), eq(signals.agentId, agent.id)))
    : [];
  const jobs = await latestJobs();

  return (
    <Shell title="Onboarding">
      <p>Keywords raise a lead’s score. Excluded companies and names are dropped. Connecting a LinkedIn seat does not start outreach.</p>

      <form action={analyzeWebsite}>
        <label style={fieldStyle}>Website<input name="website" defaultValue={profile?.website ?? ""} style={inputStyle} /></label>
        <label style={fieldStyle}>Or describe what you sell<textarea name="description" defaultValue={profile?.description ?? ""} rows={4} style={inputStyle} /></label>
        <button style={buttonStyle} type="submit">Analyze</button>
      </form>

      <form action={saveOnboardingDraft}>
        <h2>ICP draft</h2>
        <label style={fieldStyle}>Website<input name="website" defaultValue={profile?.website ?? ""} style={inputStyle} /></label>
        <label style={fieldStyle}>Description<textarea name="description" defaultValue={profile?.description ?? ""} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Pain points<textarea name="painPoints" defaultValue={text(profile?.painPoints)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Features<textarea name="features" defaultValue={text(profile?.features)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Your company LinkedIn id<input name="ownCompany" defaultValue={profile?.ownCompanyLinkedinId ?? ""} style={inputStyle} /></label>
        <label style={fieldStyle}>Job titles<textarea name="jobTitles" defaultValue={text(agent?.jobTitles)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Industries<textarea name="industries" defaultValue={text(agent?.industries)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Company sizes<textarea name="companySizes" defaultValue={text(agent?.companySizes)} rows={2} style={inputStyle} /></label>
        <label style={fieldStyle}>Locations<textarea name="locations" defaultValue={text(agent?.locations)} rows={2} style={inputStyle} /></label>
        <label style={fieldStyle}>Keywords (score only, max 6)<textarea name="keywords" defaultValue={text(agent?.mandatoryKeywords)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Excluded companies<textarea name="excludedCompanies" defaultValue={text(agent?.excludedCompanies)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Excluded names<textarea name="excludedNames" defaultValue={text(agent?.excludedNames)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Minimum score<input name="minScore" type="number" min="0" max="1" step="0.01" defaultValue={agent?.minScore ?? 0.7} style={inputStyle} /></label>
        <label style={fieldStyle}>Review<select name="reviewMode" defaultValue={agent?.reviewMode === false ? "off" : "on"} style={inputStyle}><option value="on">Hold for review</option><option value="off">Approve automatically</option></select></label>
        <button style={buttonStyle} type="submit">Save draft</button>
      </form>

      <form action={requestResolveNames}>
        <h2>Resolve names</h2>
        <label style={fieldStyle}>Competitors<textarea name="competitors" rows={3} style={inputStyle} placeholder="One company name per line" /></label>
        <label style={fieldStyle}>Influencers<textarea name="influencers" rows={3} style={inputStyle} placeholder="One person name per line" /></label>
        <button style={buttonStyle} type="submit">Resolve names</button>
      </form>

      <form action={requestPreview}>
        <h2>Preview</h2>
        <p>Preview scores people and writes nothing. One preview runs per workspace.</p>
        <button style={buttonStyle} type="submit">Queue preview</button>
      </form>

      <form action={confirmOnboarding}>
        <h2>Confirm</h2>
        <p>This creates an inactive campaign with no LinkedIn seat. The sequence is visit, invite, then two messages.</p>
        <label style={fieldStyle}>Competitor pages<textarea name="competitorPages" rows={3} style={inputStyle} placeholder="Company URL or id" /></label>
        <label style={fieldStyle}>Influencer pages<textarea name="influencerPages" rows={3} style={inputStyle} placeholder="https://www.linkedin.com/in/…" /></label>
        <label style={fieldStyle}>Excluded companies<textarea name="excludedCompanies" defaultValue={text(agent?.excludedCompanies)} rows={2} style={inputStyle} /></label>
        <label style={fieldStyle}>Excluded names<textarea name="excludedNames" defaultValue={text(agent?.excludedNames)} rows={2} style={inputStyle} /></label>
        <button style={buttonStyle} type="submit">Confirm and create the campaign</button>
      </form>

      <h2>Watched signals</h2>
      {watched.length === 0 ? <p>No signals yet.</p> : (
        <ul>
          {watched.map((row) => <li key={row.id}>{row.type}: {row.label ?? row.value} {row.enabled ? "" : "(paused)"}</li>)}
        </ul>
      )}

      <h2>Jobs</h2>
      {jobs.map((job) => (
        <div key={job.id}>
          {(job.status === "pending" || job.status === "running") ? <JobPoller jobId={job.id} label={`${job.type} ${job.id}`} /> : (
            <article style={{ border: "1px solid #e2dcd0", padding: 12, margin: "12px 0", background: "#fff" }}>
              <strong>{job.type}</strong>
              <p>Status: {job.status}{job.error ? ` — ${job.error}` : ""}</p>
              {job.result ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{JSON.stringify(job.result, null, 2)}</pre> : null}
            </article>
          )}
        </div>
      ))}
    </Shell>
  );
}
