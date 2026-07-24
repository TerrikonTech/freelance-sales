export class OutboundDeliveryUnknownError extends Error {
  readonly deliveryUnknown = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OutboundDeliveryUnknownError';
  }
}

export class OutboundPreflightError extends Error {
  constructor(
    readonly code: 'captcha' | 'layout_change' | 'authentication',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OutboundPreflightError';
  }
}

export function isDeliveryUnknown(error: unknown): error is OutboundDeliveryUnknownError {
  return error instanceof OutboundDeliveryUnknownError
    || (typeof error === 'object' && error !== null && (error as { deliveryUnknown?: unknown }).deliveryUnknown === true);
}
