import type { AccessRepositories, SecretsRepository } from "../../platform-state/secrets.js";
import type { FirestoreSession } from "./session.js";
export declare const GATEWAY_TICKETS_COLLECTION = "gatewayTickets";
export declare const GATEWAY_TICKET_MINT_LOG_COLLECTION = "gatewayTicketMintLog";
export declare const OPENCLAW_CONTROL_SESSIONS_COLLECTION = "openclawControlSessions";
export declare function createFirestoreSecretsRepository(session: FirestoreSession): SecretsRepository;
export declare function createFirestoreAccessRepositories(session: FirestoreSession): AccessRepositories;
