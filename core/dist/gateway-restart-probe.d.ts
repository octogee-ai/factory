export interface RestartConnection {
    bootId: string;
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    alive(): boolean;
    close(): void;
}
export interface RestartDriverDeps {
    connect(): Promise<RestartConnection>;
    ready(): Promise<boolean>;
    now(): number;
    wait(): Promise<void>;
}
export declare function createRestartDriverDeps(packagePath?: string): Promise<RestartDriverDeps>;
