// Thrown for expected business-rule violations (duplicate name, reserved name,
// duplicate feed URL, etc.) — carries a 400 status and a user-facing message that's
// safe to send to the client. Anything NOT a ValidationError is treated as an
// unexpected fault by the central error handler and reported as a generic 500.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}
