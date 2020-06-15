import grpc from 'grpc';

export class GRPCError extends Error {
  constructor(public message: string, public code: grpc.status) {
    super(message);
  }

  toString(): string {
    return `[${this.code}]: ${this.message}`;
  }

  asServiceError(): grpc.ServiceError {
    return {
      name: 'GRPCError',
      message: this.message,
      code: this.code,
    };
  }
}
