// Path: src/api/comments/comment-target-runtime.registry.ts
import type {
  CommentSectionKey,
  CommentSubSectionKey,
  CommentTargetSource,
} from "../../../source/comments.source";
import { CommentsSourceRegistry, LEGACY_SECTION_SET } from "../../../source/comments.source";

/**
 * CommentTargetRuntimeRegistry (Canonical)
 * -----------------------------------------------------------------------------
 * Purpose:
 * - Runtime validation + normalization for section/subSection/refId using CommentsSourceRegistry.
 * - Legacy compatibility for older flat sections (WorkItems/Events).
 *
 * exactOptionalPropertyTypes rule:
 * - Never return optional fields as `undefined` values in objects.
 *   Either omit the property or return it as a proper value.
 */
export class CommentTargetRuntimeRegistry {
  /**
   * Normalize section only (does not enforce Teams subSection requirement).
   * This is used in places where you need only canonical section validation
   * without subSection semantics (example: filesystem path building step that already
   * has canonical target elsewhere).
   */
  public normalizeSectionOnly(inputSection: unknown): CommentSectionKey {
    return CommentsSourceRegistry.normalizeSection(inputSection);
  }

  /**
   * Normalize legacy sections into canonical Teams subSections.
   * - "WorkItems" => section:"Teams", subSection:"WorkItems"
   * - "Events"    => section:"Teams", subSection:"Events"
   */
  public normalizeSectionAndSubSection(
    inputSection: unknown,
    inputSubSection: unknown,
  ): {
    section: CommentSectionKey;
    subSection?: CommentSubSectionKey;
    source: CommentTargetSource;
    wasLegacyMapped: boolean;
  } {
    const rawSection = String(inputSection ?? "").trim();
    if (!rawSection) {
      throw new Error("[Error:] [CommentTargetRuntimeRegistry] section is required.\n");
    }

    // Canonical normalization (supports legacy alias mapping)
    const normalized = CommentsSourceRegistry.normalizeSectionAndSubSection(rawSection, inputSubSection);

    // Resolve authoritative target source (model/collection/filePath/refId rules)
    const source = CommentsSourceRegistry.resolveSource(normalized.section, normalized.subSection);

    // Legacy detection (informational only)
    const wasLegacyMapped = LEGACY_SECTION_SET.has(rawSection.toLowerCase());

    return {
      section: normalized.section,
      ...(normalized.subSection ? { subSection: normalized.subSection } : {}),
      source,
      wasLegacyMapped,
    };
  }

  /**
   * Validate a full target object and return normalized info + resolved source.
   */
  public validateTargetOrThrow(target: {
    section: unknown;
    subSection?: unknown;
    refId: unknown;
  }): {
    section: CommentSectionKey;
    subSection?: CommentSubSectionKey;
    refId: string;
    source: CommentTargetSource;
  } {
    // Normalize first (includes legacy mapping)
    const normalized = this.normalizeSectionAndSubSection(target.section, target.subSection);

    // Then validate target fully (includes refId regex rules)
    const validated = CommentsSourceRegistry.validateTargetOrThrow({
      section: normalized.section,
      ...(normalized.subSection ? { subSection: normalized.subSection } : {}),
      refId: target.refId,
    });

    return {
      section: validated.section,
      ...(validated.subSection ? { subSection: validated.subSection } : {}),
      refId: validated.refId,
      source: validated.source,
    };
  }

  /**
   * Validate modelName override (if provided) against resolved source.
   */
  public resolveModelNameOrThrow(source: CommentTargetSource, modelNameOverride?: unknown): string {
    const override = typeof modelNameOverride === "string" ? modelNameOverride.trim() : "";
    if (!override) return source.mongooseModelName;

    if (override !== source.mongooseModelName) {
      throw new Error(
        `[Error:] [CommentTargetRuntimeRegistry] Invalid modelName override "${override}". Expected "${source.mongooseModelName}".\n`,
      );
    }

    return override;
  }
}
