export function storedGatewayClassValue<T>(value: T): T | "isolated" {
  return value === "builder" ? "isolated" : value;
}
