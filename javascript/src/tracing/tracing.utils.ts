export const TracingUtils = {
  /**
   * Converts a base64 encoded trace id to a hex string.
   * @see https://github.com/langwatch/langwatch/pull/861
   * @param base64 - The base64 encoded trace id.
   * @returns The hex string.
   */
  toHex: (base64: string) => {
    return Buffer.from(base64, "base64").toString("hex");
  },
};
