export interface PlaybookSeed {
    relPath: string;
    content: string;
}
export declare function notesWelcomeSeed(scopeName: string): PlaybookSeed;
export declare function projectPlaybookSeeds(projectName: string, today: string): PlaybookSeed[];
