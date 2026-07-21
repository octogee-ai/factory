export interface ThirdPartyLicenseReportOptions {
  bundle: Record<string, { type: string; modules?: Record<string, unknown> }>;
  additionalNoticeFiles?: string[];
}

export interface ThirdPartyLicensesOptions {
  additionalNoticeFiles?: string[];
  fileName?: string;
}

export function createThirdPartyLicenseReport(
  options: ThirdPartyLicenseReportOptions,
): string;

export function thirdPartyLicenses(options?: ThirdPartyLicensesOptions): {
  name: "octogee-third-party-licenses";
  apply: "build";
  generateBundle(
    this: { emitFile(file: { type: "asset"; fileName: string; source: string }): void },
    outputOptions: unknown,
    bundle: ThirdPartyLicenseReportOptions["bundle"],
  ): void;
};
