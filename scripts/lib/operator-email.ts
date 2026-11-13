export const OPERATOR_EMAIL_ENV = "OPERATOR_EMAIL";

export function requireOperatorEmail(env: NodeJS.ProcessEnv): string {
  const email = env[OPERATOR_EMAIL_ENV]?.trim();
  if (!email) {
    throw new Error(
      `${OPERATOR_EMAIL_ENV} must name the operator's admin account when OPERATOR_UID is not set`,
    );
  }
  return email;
}
