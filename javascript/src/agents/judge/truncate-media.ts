/**
 * Truncates base64 data URLs to human-readable markers.
 * @param str - String to check
 * @returns Marker if data URL, original string otherwise
 */
export function truncateMediaUrl(str: string): string {
  const match = str.match(
    /^data:((image|audio|video)\/[a-z0-9+.-]+);base64,(.+)$/i
  );
  if (!match) return str;
  const [, mimeType, category, data] = match;
  return `[${category.toUpperCase()}: ${mimeType}, ~${data.length} bytes]`;
}

/**
 * Truncates AI SDK file/image parts by replacing base64 data with markers.
 * @param v - Value to check
 * @returns Truncated object if media part, null otherwise
 */
export function truncateMediaPart(
  v: unknown
): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;

  // AI SDK file parts: {type: "file", mediaType: "...", data: "..."}
  if (
    obj.type === "file" &&
    typeof obj.mediaType === "string" &&
    typeof obj.data === "string"
  ) {
    const category = obj.mediaType.split("/")[0]?.toUpperCase() ?? "FILE";
    return {
      ...obj,
      data: `[${category}: ${obj.mediaType}, ~${obj.data.length} bytes]`,
    };
  }

  // AI SDK image parts: {type: "image", image: "..."}
  if (obj.type === "image" && typeof obj.image === "string") {
    const imageData = obj.image;

    // Data URL format
    const dataUrlMatch = imageData.match(
      /^data:((image)\/[a-z0-9+.-]+);base64,(.+)$/i
    );
    if (dataUrlMatch) {
      return {
        ...obj,
        image: `[IMAGE: ${dataUrlMatch[1]}, ~${dataUrlMatch[3].length} bytes]`,
      };
    }

    // Raw base64 (long string without common text patterns)
    if (imageData.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(imageData)) {
      return {
        ...obj,
        image: `[IMAGE: unknown, ~${imageData.length} bytes]`,
      };
    }
  }

  return null;
}

