export interface WestIngressPlanReceipt {
  summary: {
    create: number;
    update: number;
    delete: number;
    replace: number;
  };
  changes: Array<{
    address: string;
    actions: string[];
  }>;
}

export function verifyWestIngressPlan(
  receipt: WestIngressPlanReceipt,
): "create" | "unchanged";

export function verifyWestIngressAddresses(
  outputs: Record<string, string>,
): Record<string, string>;
