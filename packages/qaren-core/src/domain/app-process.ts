// The runner saw the app process gone; content-free, so it may leave capture unmasked.
export class AppProcessGoneError extends Error {
  constructor() {
    super('the app process is not running');
    this.name = 'AppProcessGoneError';
  }
}
