type MigrationGrant = { ownerId: string; ownerIds: string[] };
type AuthorityRegistration = { owners: { id: string; host: string; tokenFile?: string }[]; migrations?: MigrationGrant[]; [key: string]: unknown };
type ClientRegistration = { owners: { uid: number; ownerId: string; tokenFile?: string }[]; migration?: MigrationGrant; [key: string]: unknown };
export function migrationConfiguration(authority: AuthorityRegistration, client: ClientRegistration, host: string): {
  authority: AuthorityRegistration & { migrations: MigrationGrant[] };
  client: ClientRegistration & { migration: MigrationGrant };
};
