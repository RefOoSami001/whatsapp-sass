export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toErrorResponse(err: unknown) {
  if (err instanceof AppError) {
    return {
      success: false as const,
      error: { code: err.code, message: err.message },
    };
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  return {
    success: false as const,
    error: { code: 'INTERNAL_ERROR', message },
  };
}
