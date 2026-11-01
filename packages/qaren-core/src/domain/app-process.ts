// The runner saw the app process gone; content-free, so it may leave capture unmasked.
export class AppProcessGoneError extends Error {
  constructor() {
    super(
      'APP_PROCESS_CHANGED: the app process is not running; inspect the crash report and re-run the plan',
    );
    this.name = 'AppProcessGoneError';
  }
}
