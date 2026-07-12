import type {
  AgentActivityEnvelopeV1,
  AgentAttention,
} from "@octogee/shared/types/agent-conversation";

export interface ActivityDeliveryPolicy {
  target: "activity";
  silent: boolean | null;
  attention: AgentAttention;
}

export interface PrimaryDeliveryPolicy {
  target: "main";
  silent: false;
}

export interface DeliveryOptions {
  silent: boolean;
  persistentNotification?: boolean;
  forceNotification?: boolean;
}

export function assertCompatibleDeliveryOptions(options: DeliveryOptions): void {
  if (options.silent && options.persistentNotification) {
    throw new Error("persistent notifications cannot be silent");
  }
  if (options.silent && options.forceNotification) {
    throw new Error("force notification cannot be silent");
  }
}

export function activityAttentionPolicy(
  envelope: AgentActivityEnvelopeV1,
): ActivityDeliveryPolicy {
  if (envelope.type === "control.transition") {
    return { target: "activity", silent: null, attention: "routine" };
  }
  if (
    envelope.type === "item.completed" &&
    envelope.item.kind === "approval" &&
    envelope.item.status === "waiting"
  ) {
    return { target: "activity", silent: false, attention: "action-required" };
  }
  const attention =
    envelope.type === "item.completed" && envelope.item.status === "failed"
      ? "failure"
      : "routine";
  return { target: "activity", silent: true, attention };
}

export function primaryAttentionPolicy(
  _kind: "answer" | "terminal-failure",
): PrimaryDeliveryPolicy {
  return { target: "main", silent: false };
}
