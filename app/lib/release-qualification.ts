/**
 * Public large-file claims are enabled only after the evidence in
 * docs/LARGE_FILE_QUALIFICATION.md passes. Protocol limits are independent.
 * Do not turn this on after metadata-only or simulated sink tests.
 */
export const LARGE_FILE_RELEASE_QUALIFIED: boolean = false;
