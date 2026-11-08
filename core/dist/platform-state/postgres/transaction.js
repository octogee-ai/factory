import { randomInt } from "node:crypto";
import { BackendFailureError, ContentionExhaustedError } from "../errors.js";
import { isConnectionLoss, isContention } from "./pg-errors.js";
import { TransactionPostgresSession } from "./session.js";
import { clientRunner, runQuery } from "./sql.js";
export const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 5;
const SESSION_LIMITS = "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'; SET LOCAL idle_in_transaction_session_timeout = '30s'";
const BEGIN_READ_WRITE = `BEGIN ISOLATION LEVEL SERIALIZABLE; ${SESSION_LIMITS}`;
const BEGIN_READ_ONLY = `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE; ${SESSION_LIMITS}`;
function asError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
export function contentionBackoffMs(policy, attempt) {
    const ceiling = Math.floor(Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)));
    return randomInt(Math.max(ceiling, 0) + 1);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function rollback(context, client, label) {
    try {
        await client.query("ROLLBACK");
        return undefined;
    }
    catch (error) {
        context.logger.warn("platform state rollback failed; discarding the connection", { label, error });
        return asError(error);
    }
}
async function runAttempt(context, attempt, body) {
    let client;
    try {
        client = await context.pool.connect();
    }
    catch (error) {
        return { committed: false, error, retryable: isConnectionLoss(error) };
    }
    let broken;
    const onConnectionError = (error) => {
        broken = error;
    };
    client.on("error", onConnectionError);
    let commitSent = false;
    try {
        await client.query(attempt.readOnly ? BEGIN_READ_ONLY : BEGIN_READ_WRITE);
        const session = new TransactionPostgresSession(context, client, attempt);
        const value = await body(session);
        if (session.failure !== undefined) {
            throw isContention(session.failure) || isConnectionLoss(session.failure)
                ? session.failure
                : new BackendFailureError("postgresql", attempt.label, { cause: session.failure });
        }
        commitSent = true;
        await client.query("COMMIT");
        return { committed: true, value };
    }
    catch (error) {
        const outcomeUnknown = commitSent && isConnectionLoss(error);
        if (outcomeUnknown)
            broken = broken ?? asError(error);
        if (broken === undefined)
            broken = await rollback(context, client, attempt.label);
        return { committed: false, error, retryable: isContention(error) || (!commitSent && isConnectionLoss(error)) };
    }
    finally {
        client.off("error", onConnectionError);
        client.release(broken);
    }
}
export async function runPostgresTransaction(context, options, body) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_TRANSACTION_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new RangeError(`transaction ${options.label} maxAttempts must be a positive integer, got ${maxAttempts}`);
    }
    const readOnly = options.readOnly === true;
    const startedAt = Date.now();
    for (let attempt = 1;; attempt += 1) {
        const outcome = await runAttempt(context, { label: options.label, readOnly, attempt }, body);
        if (outcome.committed)
            return outcome.value;
        if (!outcome.retryable)
            throw outcome.error;
        const delay = contentionBackoffMs(context.retry, attempt);
        if (attempt >= maxAttempts || Date.now() - startedAt + delay > context.retry.budgetMs) {
            context.logger.error("platform state transaction exhausted its contention retries", {
                label: options.label,
                attempts: attempt,
                error: outcome.error,
            });
            throw new ContentionExhaustedError("postgresql", options.label, attempt, { cause: outcome.error });
        }
        await sleep(delay);
    }
}
export async function withReadSnapshot(context, label, body) {
    const client = await context.pool.connect();
    let broken;
    const onConnectionError = (error) => {
        broken = error;
    };
    client.on("error", onConnectionError);
    try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const run = clientRunner(client);
        const result = await body((text, values = []) => runQuery(run, context.schema, text, values));
        await client.query("COMMIT");
        return result;
    }
    catch (error) {
        if (broken === undefined)
            broken = await rollback(context, client, label);
        throw error;
    }
    finally {
        client.off("error", onConnectionError);
        client.release(broken);
    }
}
