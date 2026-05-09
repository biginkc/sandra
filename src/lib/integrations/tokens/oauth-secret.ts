export class OAuthSecret {
  private readonly _value!: string;

  constructor(value: string) {
    Object.defineProperty(this, "_value", {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  reveal(): string {
    return this._value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}
