import { UnsupportedOperationError } from "../errors.js";
import { translateWriteError } from "./pg-errors.js";
import { clientRunner, poolRunner, runQuery } from "./sql.js";
export const DEFAULT_RETRY_POLICY = { baseDelayMs: 25, maxDelayMs: 1_000, budgetMs: 10_000 };
async function write(run, schema, record, text, values) {
    try {
        return await runQuery(run, schema, text, values);
    }
    catch (error) {
        throw translateWriteError(error, record);
    }
}
export class DirectPostgresSession {
    context;
    runTransaction;
    transactional = false;
    run;
    constructor(context, runTransaction) {
        this.context = context;
        this.runTransaction = runTransaction;
        this.run = poolRunner(context.pool);
    }
    read(_operation, text, values = []) {
        return runQuery(this.run, this.context.schema, text, values);
    }
    write(_operation, record, text, values = []) {
        return write(this.run, this.context.schema, record, text, values);
    }
    execute(text, values = []) {
        return runQuery(this.run, this.context.schema, text, values);
    }
    atomically(operation, body) {
        return this.runTransaction(this.context, { label: operation }, body);
    }
}
export class TransactionPostgresSession {
    context;
    attempt;
    transactional = true;
    run;
    wrote = false;
    firstFailure;
    constructor(context, client, attempt) {
        this.context = context;
        this.attempt = attempt;
        const run = clientRunner(client);
        this.run = async (config) => {
            try {
                return await run(config);
            }
            catch (error) {
                this.firstFailure ??= error;
                throw error;
            }
        };
    }
    get failure() {
        return this.firstFailure;
    }
    async read(operation, text, values = []) {
        if (this.wrote)
            throw new UnsupportedOperationError("postgresql", operation, "read-after-write");
        return runQuery(this.run, this.context.schema, text, values);
    }
    async write(operation, record, text, values = []) {
        if (this.attempt.readOnly)
            throw new UnsupportedOperationError("postgresql", operation, "write-in-read-only-transaction");
        this.wrote = true;
        return write(this.run, this.context.schema, record, text, values);
    }
    execute(text, values = []) {
        return runQuery(this.run, this.context.schema, text, values);
    }
    atomically(_operation, body) {
        return body(this);
    }
}
