export function isUnlinkedLidConversation(sourceJid, canonicalJid) {
  return Boolean(
    sourceJid?.endsWith('@lid') &&
    (!canonicalJid || canonicalJid === sourceJid)
  );
}
