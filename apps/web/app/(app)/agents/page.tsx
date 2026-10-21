import { desc } from "drizzle-orm";
import { forOrg } from "../../../../../shared/db/scope.js";
import { agents } from "../../../../../shared/db/schema.js";
import { requireOrg } from "../org.js";
import { Shell } from "../shell.js";

export default async function AgentsPage() {
  const { db, orgId } = await requireOrg();
  const rows = await db.select().from(agents).where(forOrg(orgId, agents.orgId)).orderBy(desc(agents.createdAt));

  return (
    <Shell title="Agents">
      <p>Keywords move the score. Exclusions drop people before scoring. Profile viewers are not watched.</p>
      {rows.length === 0 ? <p>Save an onboarding draft to create an agent.</p> : (
        <ul>
          {rows.map((agent) => (
            <li key={agent.id}>
              <a href={`/agents/${agent.id}`} style={{ color: "#0f6e56" }}>{agent.status} agent</a>
              {" "}· min {agent.minScore} · {agent.reviewMode ? "review on" : "review off"} · keywords {agent.mandatoryKeywords.join(", ") || "none"}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
