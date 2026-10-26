// APK ownership is independent of the plugin-version rebuild budget. An owner
// may be replaced only after its recorded identity and writer group are gone.
export interface AndroidRunnerApkOwner {
  nonce: string;
  birth: {
    pid: number;
    source: 'linux-proc' | 'darwin-libproc' | 'windows-powershell';
    token: string;
  };
  pgid: number;
  retained: boolean;
}

export function androidRunnerApkOwnerPresence(
  owner: AndroidRunnerApkOwner,
  observed:
    | { status: 'present'; birth: AndroidRunnerApkOwner['birth'] }
    | { status: 'absent' | 'unknown' },
  group: 'live' | 'absent' | 'unknown',
): 'live' | 'absent' | 'unknown' {
  if (observed.status === 'unknown' || group === 'unknown') return 'unknown';
  const sameOwner =
    observed.status === 'present' &&
    observed.birth.token === owner.birth.token &&
    observed.birth.source === owner.birth.source;
  if (!sameOwner) return group === 'absent' ? 'absent' : 'unknown';
  return group === 'live' && !owner.retained ? 'live' : 'unknown';
}
