const TYPES = ["visit", "invite", "message", "email"] as const;

export interface StepValue {
  position: number;
  type: string;
  delayDays: number;
  mode: string;
  template: string | null;
  subject: string | null;
}

export function CampaignFields({
  lists,
  linkedin,
  email,
  steps,
  locked,
  campaign,
}: {
  lists: { id: string; name: string }[];
  linkedin: { id: string; unipile_status: string }[];
  email: { id: string; address: string }[];
  steps: StepValue[];
  locked: boolean;
  campaign?: {
    id: string;
    name: string;
    listId: string;
    goal: string;
    tone: string;
    language: string;
    reviewMessages: boolean;
    silentVisits: boolean;
    linkedinSeatId: string | null;
    emailSeatId: string | null;
  };
}) {
  const byPosition = new Map(steps.map((step) => [step.position, step]));
  return (
    <>
      {campaign ? <input type="hidden" name="id" value={campaign.id} /> : null}
      <label>Name<input name="name" required defaultValue={campaign?.name ?? ""} /></label>
      <label>List
        <select name="listId" defaultValue={campaign?.listId ?? ""} disabled={locked}>
          <option value="">Select</option>
          {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
        </select>
      </label>
      {locked ? null : <label>Or new list<input name="newList" placeholder="List name" /></label>}
      <div className="limits">
        <label>Goal
          <select name="goal" defaultValue={campaign?.goal ?? "conversations"}>
            <option value="conversations">Conversations</option>
            <option value="demos">Demos</option>
          </select>
        </label>
        <label>Tone
          <select name="tone" defaultValue={campaign?.tone ?? "professional"}>
            <option value="professional">Professional</option>
            <option value="direct">Direct</option>
            <option value="conversational">Conversational</option>
          </select>
        </label>
      </div>
      <label>Language<input name="language" defaultValue={campaign?.language ?? "en"} /></label>
      <label>LinkedIn seat
        <select name="linkedinSeatId" defaultValue={campaign?.linkedinSeatId ?? ""} disabled={locked}>
          <option value="">None (draft)</option>
          {linkedin.map((seat) => <option key={seat.id} value={seat.id}>{seat.unipile_status} · {seat.id.slice(0, 8)}</option>)}
        </select>
      </label>
      <label>Email seat
        <select name="emailSeatId" defaultValue={campaign?.emailSeatId ?? ""} disabled={locked}>
          <option value="">None</option>
          {email.map((seat) => <option key={seat.id} value={seat.id}>{seat.address}</option>)}
        </select>
      </label>
      <label className="row"><input type="checkbox" name="reviewMessages" defaultChecked={campaign?.reviewMessages ?? true} /> Hold invite notes and messages for review. Visits send without approval.</label>
      <label className="row"><input type="checkbox" name="silentVisits" defaultChecked={campaign?.silentVisits ?? false} /> Silent visits</label>
      {locked ? <p className="meta">This campaign has contacts. You can change templates, subjects, delays, and mode. Duplicate it to change seats or step types.</p> : null}
      {[1, 2, 3, 4, 5, 6].map((position) => {
        const step = byPosition.get(position);
        return (
          <div className="step" key={position}>
            <strong>Step {position}</strong>
            <div className="limits">
              <label>Type
                <select name={`type_${position}`} defaultValue={step?.type ?? ""} disabled={locked && !step}>
                  <option value="">{position === 1 && !locked ? "visit" : "Skip"}</option>
                  {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label>Delay days<input name={`delay_${position}`} type="number" min={0} defaultValue={step?.delayDays ?? (position === 1 ? 0 : 1)} /></label>
              <label>Mode
                <select name={`mode_${position}`} defaultValue={step?.mode ?? "ai"}>
                  <option value="ai">AI</option>
                  <option value="fixed">Fixed</option>
                </select>
              </label>
            </div>
            <label>Template<input name={`template_${position}`} defaultValue={step?.template ?? ""} /></label>
            <label>Subject<input name={`subject_${position}`} defaultValue={step?.subject ?? ""} /></label>
            {locked && step ? <input type="hidden" name={`type_${position}`} value={step.type} /> : null}
          </div>
        );
      })}
    </>
  );
}
