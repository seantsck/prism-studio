export function checksumOf(sql: string): string;
export const MISMATCH_MESSAGE: string;
export interface MigrationFile {
  name: string;
  sql: string;
}
export interface AppliedMigration {
  name: string;
  checksum: string | null;
}
export interface MigrationPlan {
  pending: MigrationFile[];
  mismatched: string[];
  unrecorded: string[];
  missingOnDisk: string[];
  outOfOrder: string[];
}
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan;
export function assertPlanSafe(plan: MigrationPlan): void;
