export class SecretNotFoundError extends Error {
    name = "SecretNotFoundError";
}
export function isSecretNotFound(error) {
    return error instanceof SecretNotFoundError || error?.code === 5;
}
