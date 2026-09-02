import type { Response } from "express";

interface A2AHttpErrorOptions {
  code: number;
  status: string;
  message: string;
  reason?: string;
}

/** Build the AIP-193 JSON error envelope required by the HTTP+JSON binding. */
export function a2aHttpErrorBody(options: A2AHttpErrorOptions) {
  return {
    error: {
      code: options.code,
      status: options.status,
      message: options.message,
      details: options.reason ? [{
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: options.reason,
        domain: "a2a-protocol.org",
        metadata: {},
      }] : [],
    },
  };
}

export function sendA2AHttpError(response: Response, options: A2AHttpErrorOptions): void {
  response.status(options.code).type("application/json").json(a2aHttpErrorBody(options));
}
