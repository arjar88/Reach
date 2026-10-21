import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { forOrg } from "../../../../../../shared/db/scope.js";
import { agents, signals } from "../../../../../../shared/db/schema.js";
import { requireOrg } from "../../org.js";
import { Shell, buttonStyle, fieldStyle, inputStyle } from "../../shell.js";
import { toggleSignal, updateAgent, upsertSignal } from "../actions.js";

function text(values: string[]): string {
  return values.join("\n");
}

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, orgId } = await requireOrg();
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), forOrg(orgId, agents.orgId))).limit(1);
  if (!agent) notFound();
  const watched = await db.select().from(signals).where(and(forOrg(orgId, signals.orgId), eq(signals.agentId, agent.id)));

  return (
    <Shell title="Agent">
      <p>Status: {agent.status}. Keywords raise the score and do not hard-drop a person. Excluded companies and names are dropped.</p>
      <form action={updateAgent}>
        <input type="hidden" name="agentId" value={agent.id} />
        <label style={fieldStyle}>Job titles<textarea name="jobTitles" defaultValue={text(agent.jobTitles)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Industries<textarea name="industries" defaultValue={text(agent.industries)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Company sizes<textarea name="companySizes" defaultValue={text(agent.companySizes)} rows={2} style={inputStyle} /></label>
        <label style={fieldStyle}>Locations<textarea name="locations" defaultValue={text(agent.locations)} rows={2} style={inputStyle} /></label>
        <label style={fieldStyle}>Keywords (score only)<textarea name="keywords" defaultValue={text(agent.mandatoryKeywords)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Excluded companies<textarea name="excludedCompanies" defaultValue={text(agent.excludedCompanies)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Excluded names<textarea name="excludedNames" defaultValue={text(agent.excludedNames)} rows={3} style={inputStyle} /></label>
        <label style={fieldStyle}>Minimum score<input name="minScore" type="number" min="0" max="1" step="0.01" defaultValue={agent.minScore} style={inputStyle} /></label>
        <label style={fieldStyle}>Review<select name="reviewMode" defaultValue={agent.reviewMode ? "on" : "off"} style={inputStyle}><option value="on">Hold for review</option><option value="off">Approve automatically</option></select></label>
        <button style={buttonStyle} type="submit">Save agent</button>
      </form>

      <h2>Signals</h2>
      {watched.length === 0 ? <p>No signals yet.</p> : watched.map((row) => (
        <form key={row.id} action={toggleSignal} style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input type="hidden" name="signalId" value={row.id} />
          <span>{row.type}: {row.label ?? row.value} · {row.enabled ? "on" : "off"}</span>
          <button style={buttonStyle} type="submit">{row.enabled ? "Pause" : "Enable"}</button>
        </form>
      ))}

      <form action={upsertSignal}>
        <h2>Add a signal</h2>
        <input type="hidden" name="agentId" value={agent.id} />
        <label style={fieldStyle}>Type
          <select name="type" style={inputStyle}>
            <option value="keyword">Keyword</option>
            <option value="company_page">Competitor page</option>
            <option value="influencer">Influencer</option>
          </select>
        </label>
        <label style={fieldStyle}>Value<input name="value" required style={inputStyle} placeholder="Keyword, company URL, or profile URL" /></label>
        <button style={buttonStyle} type="submit">Save signal</button>
      </form>
    </Shell>
  );
}
