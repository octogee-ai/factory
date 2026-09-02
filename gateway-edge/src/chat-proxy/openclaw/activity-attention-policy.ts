import type {
  AgentActivityEnvelopeV1,
  AgentAttention,
} from "@octogee/shared/types/agent-conversation";

export interface ActivityDeliveryPolicy {
  target: "activity";
  silent: boolean | null;
  attention: AgentAttention;
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
  if (
    envelope.type === "item.completed" &&
    envelope.item.kind === "approval" &&
    envelope.item.status === "waiting"
  ) {
    return { target: "activity", silent: false, attention: "action-required" };
  }
  if (
    envelope.type === "item.completed" &&
    envelope.item.kind === "error" &&
    envelope.item.status === "failed"
  ) {
    return { target: "activity", silent: false, attention: "failure" };
  }
  const attention =
    envelope.type === "item.completed" && envelope.item.status === "failed"
      ? "failure"
      : "routine";
  return { target: "activity", silent: true, attention };
}
