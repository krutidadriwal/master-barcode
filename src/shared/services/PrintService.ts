export class PrintService {
  /**
   * Triggers the native browser print.
   * Works smoothly on desktop and mobile platforms.
   */
  static print(): void {
    window.print();
  }
}
