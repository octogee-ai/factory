export interface AdmittedRepeat {
    suppressed: number;
    note: string;
}
export interface RepeatSquelch {
    admit(key: string, value?: string): AdmittedRepeat | null;
    settle(key: string): AdmittedRepeat | null;
}
export declare function createRepeatSquelch(options: {
    windowMs: number;
    now?: () => number;
}): RepeatSquelch;
