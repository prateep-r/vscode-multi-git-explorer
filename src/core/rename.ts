/**
 * The extension used to be called Multi-Repo Explorer. These say what to carry
 * over from it, without VS Code, so they can be tested.
 */

/** IDs the old extension was installed under. */
export const OLD_EXTENSION_IDS = ['prateep-r.multi-repo-explorer', 'prateep.multi-repo-explorer', 'local.multi-repo-explorer'];

export const OLD_SETTINGS_PREFIX = 'multiRepoExplorer.';
export const NEW_SETTINGS_PREFIX = 'multiGitExplorer.';

/** Where a setting can be set, as in `WorkspaceConfiguration.inspect`. */
export type SettingScope = 'globalValue' | 'workspaceValue' | 'workspaceFolderValue';

export type ScopedValues = Partial<Record<SettingScope, unknown>>;

/** The old name of a new setting: `multiGitExplorer.scanDepth` → `multiRepoExplorer.scanDepth`. */
export function oldSettingName(newName: string): string | undefined {
  return newName.startsWith(NEW_SETTINGS_PREFIX) ? OLD_SETTINGS_PREFIX + newName.slice(NEW_SETTINGS_PREFIX.length) : undefined;
}

/**
 * The scopes, among `scopes`, where the old setting has a value and the new one
 * doesn't, so the old value should be copied. A new value is never overwritten.
 */
export function scopesToCopy(oldValues: ScopedValues | undefined, newValues: ScopedValues | undefined, scopes: SettingScope[]): SettingScope[] {
  return scopes.filter(scope => oldValues?.[scope] !== undefined && newValues?.[scope] === undefined);
}
