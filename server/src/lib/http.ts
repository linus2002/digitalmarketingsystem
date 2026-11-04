import { z, ZodError, type ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const forbidden = (msg = "You don't have permission to do that.") => new HttpError(403, msg);
export const notFound = (what = "That record") => new HttpError(404, `${what} wasn't found.`);
export const conflict = (msg: string) => new HttpError(409, msg);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const field = first?.path.join(".");
      throw badRequest(field ? `${field}: ${first.message}` : first?.message ?? "Invalid input", err.issues);
    }
    throw err;
  }
}

export function intParam(v: unknown, name = "id"): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${name} must be a positive whole number`);
  return n;
}
