export interface FanoutSignal {
  id: string;
  signalKey: string | null;
  enabled: boolean;
  agentStatus: string;
}

/** Every enabled signal on an active agent for this key. Profile viewers are not a key. */
export function fanoutSignalIds(signals: FanoutSignal[], signalKey: string): string[] {
  return signals
    .filter((row) => row.signalKey === signalKey && row.enabled && row.agentStatus === "active")
    .map((row) => row.id);
}
