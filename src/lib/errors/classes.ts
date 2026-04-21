export type ErrorClass =
  | "validation"
  | "transient"
  | "provider"
  | "database"
  | "authorization"
  | "configuration";

export abstract class AppError extends Error {
  abstract readonly errorClass: ErrorClass;

  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  readonly errorClass = "validation" as const;
}

export class TransientError extends AppError {
  readonly errorClass = "transient" as const;
}

export class ProviderError extends AppError {
  readonly errorClass = "provider" as const;

  constructor(
    message: string,
    public readonly provider: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }
}

export class DatabaseError extends AppError {
  readonly errorClass = "database" as const;
}

export class AuthorizationError extends AppError {
  readonly errorClass = "authorization" as const;
}

export class ConfigurationError extends AppError {
  readonly errorClass = "configuration" as const;
}
