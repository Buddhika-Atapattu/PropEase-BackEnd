// Path: src/utils/mongo-id.util.ts
import { Types } from "mongoose";

export class MongoIdUtil {
  private constructor() {}

  /**
   * Convert a Mongo ObjectId-like value into a string id.
   *
   * @param v
   * - Accepts: Types.ObjectId | string | unknown
   * - Returns: trimmed string id, or "" if invalid/empty
   */
  public static toIdString(v: unknown): string {
    if (v instanceof Types.ObjectId) return v.toHexString();

    if (typeof v === "string") {
      const s = v.trim();
      return s;
    }

    // Some libs return: { _id: ObjectId } or { $oid: "..." } etc.
    if (v && typeof v === "object") {
      const anyObj = v as Record<string, unknown>;

      const maybeId = anyObj["_id"];
      if (maybeId instanceof Types.ObjectId) return maybeId.toHexString();

      const maybeOid = anyObj["$oid"];
      if (typeof maybeOid === "string") return maybeOid.trim();
    }

    return "";
  }

  /**
   * Convert to a VALID MongoId string.
   * - If invalid, returns "".
   *
   * @param v
   * - Accepts: Types.ObjectId | string | unknown
   */
  public static toValidMongoIdString(v: unknown): string {
    const s = MongoIdUtil.toIdString(v);
    if (!s) return "";
    return Types.ObjectId.isValid(s) ? s : "";
  }

  /**
   * Convert a string/ObjectId into Types.ObjectId.
   * - If invalid, returns null.
   *
   * @param v
   * - Accepts: Types.ObjectId | string | unknown
   */
  public static toObjectIdOrNull(v: unknown): Types.ObjectId | null {
    if (v instanceof Types.ObjectId) return v;

    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      if (!Types.ObjectId.isValid(s)) return null;
      return new Types.ObjectId(s);
    }

    return null;
  }

  /**
   * Normalize array into de-duped string ids.
   *
   * @param values
   * - Accepts: unknown[] (ObjectId/string mixed)
   * - Returns: string[] unique, non-empty
   */
  public static toIdStringArray(values: unknown[]): string[] {
    const list = Array.isArray(values) ? values : [];
    const out: string[] = [];
    const seen = new Set<string>();

    for (const v of list) {
      const s = MongoIdUtil.toIdString(v);
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }

    return out;
  }
}